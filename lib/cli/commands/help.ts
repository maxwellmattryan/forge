// `forge help`, `--help` and the CLI's error contract (docs/CLI.md). The help tables live beside
// their command modules as `HELP`; CORE holds the commands lib/cli/main.ts routes itself. The same tables
// build `usage:` errors, the README command table and the `--json` error hint.
import path from 'node:path';
import { forgeVersion } from '#engine/evals/run.ts';
import { PLUGIN_ROOT } from '#core/paths.ts';
import { ERROR_CODE_DOCS, ERROR_CODES, ForgeError } from '#core/errors.ts';
import type { ErrorCode } from '#core/errors.ts';
import { replaceRegion } from '#core/format/region.ts';
import { jsonFlag, lenientOutputMode, out, parseArgs, usageError } from './args.ts';
import { colorEnabled, renderError } from './render.ts';
import { HELP as AUDIT } from './audit.ts';
import { HELP as BACKING } from './backing.ts';
import { HELP as BUDGET } from './budget.ts';
import { HELP as ENVIRONMENT } from './environment.ts';
import { HELP as CONFIG } from './config.ts';
import { HELP as DAEMON } from './daemon.ts';
import { HELP as DASH } from './dash.ts';
import { HELP as DOCTOR } from './doctor.ts';
import { HELP as EVAL } from './eval.ts';
import { HELP as EXPERIMENT } from './experiment.ts';
import { HELP as FOCUS } from './focus.ts';
import { HELP as GIT } from './git.ts';
import { HELP as INIT } from './init.ts';
import { HELP as JOB } from './job/help.ts';
import { HELP as NOTIFY } from './notify.ts';
import { HELP as RELEASE } from './release.ts';
import { HELP as REQUESTS } from './requests.ts';
import { HELP as SECRETS } from './secrets.ts';
import { HELP as STATUS } from './status.ts';
import { HELP as TRACKER } from './tracker.ts';
import { HELP as UPDATE } from './update.ts';
import { HELP as VERIFIERS } from './verifiers.ts';
import type { CliError, CommandHelp, HelpGroup } from '../types.ts';

const NO_JOB: [1, string] = [1, 'no such job'];
const GIT_FAILED: [5, string] = [5, 'git failed'];
const GH_FAILED: [5, string] = [5, 'gh or git failed'];

/** The commands lib/cli/main.ts routes itself. */
export const CORE: HelpGroup[] = [
  {
    name: 'worktree',
    summary: "a job's git worktree",
    commands: [
      {
        command: 'worktree create',
        args: '<id>',
        summary:
          "create the job's worktree and branch (stacked on its one unmerged dependency, if any) bring its backing services up (a failed one skips setup and fails the result, listed as backing), and run worktrees.setup there; with worktrees.seed and matching key files it clones the seed and runs seed.setup instead of worktrees.setup, listed as seed; then each missing member repo worktree (forge job repo add) on the job's branch, or detached at its base for a verify-only repo; with members, the result lists them as repos",
        exits: [[1, 'no such job, an unsafe branch name, no free port, a member repo worktree that could not be created (the result names it), or the inbox or office daemon session ran it'], GIT_FAILED],
      },
      {
        command: 'worktree remove',
        args: '<id> [--repo NAME] [--delete-branch] [--force]',
        summary: "remove the job's worktree and every member repo worktree, or with --repo only that member's; without --repo also its per-job backing containers and volumes (listed as backing)",
        flags: [
          ['--repo NAME', 'only the worktree of member repo NAME'],
          ['--delete-branch', "delete the job's branch too, only the one Forge named (git.branchPrefix + id; another is kept and listed as branchKept), not in a verify-only repo"],
          ['--force', 'remove it with uncommitted changes'],
        ],
        exits: [[1, "no such job or repo, a stored worktree that is not the job's own <worktrees.root>/<id>, an unsafe branch name with --delete-branch, a member worktree that could not be removed (the result names it), or a backing teardown that failed (backing.json is kept for a retry)"], GIT_FAILED],
      },
      {
        command: 'worktree path',
        args: '<id> [--repo NAME]',
        summary: "the worktree's path, or member repo NAME's (empty when it has none)",
        flags: [['--repo NAME', "member repo NAME's worktree"]],
        exits: [NO_JOB],
      },
      { command: 'worktree prune', args: '', summary: "prune git's records of worktrees that are gone", exits: [GIT_FAILED] },
    ],
  },
  {
    name: 'run',
    summary: "run a configured command in a job's worktree",
    commands: [
      {
        command: 'run',
        args: '<id> <command> [--repo NAME] [--background] [--tail N] [-- <args…>]',
        summary: 'run commands.<command> in the job\'s worktree, logging its output to the job dir and printing the tail',
        flags: [
          ['--repo NAME', "run the command of member repo NAME's one component that defines it, in that member's worktree (not with --background)"],
          ['--background', 'start it detached (dev servers); stop it with forge stop'],
          ['--tail N', 'print the last N lines (default 40)'],
          ['-- <args…>', 'quoted arguments, placed at {args} in the template or appended'],
        ],
        exits: [[1, 'the command failed, is not configured (for --repo: no component of that repo, or several, define it), or the job has no worktree']],
      },
    ],
  },
  {
    name: 'stop',
    summary: "stop a job's background command",
    commands: [{ command: 'stop', args: '<id>', summary: 'stop the command forge run --background started for the job' }],
  },
  {
    name: 'verify',
    summary: "run the verify commands on a job's worktree",
    commands: [
      {
        command: 'verify',
        args: '<id>',
        summary: "run the configured verify commands in the job's worktree and record the result for its HEAD",
        exits: [[1, 'a check failed (the result says which), or the job has no worktree']],
      },
    ],
  },
  {
    name: 'integrate',
    summary: 'bring a job branch up to date with its base',
    commands: [
      {
        command: 'integrate',
        args: '<id> [--strategy merge|rebase] [--keep-conflicts | --continue]',
        summary: "merge or rebase the job's base into its branch; conflicts are aborted unless --keep-conflicts leaves them for the integrator",
        flags: [
          ['--strategy merge|rebase', 'how to integrate (default: pr.updateStrategy, merge unless set to rebase)'],
          ['--keep-conflicts', 'leave conflicts in the worktree to resolve'],
          ['--continue', 'finish a merge or rebase once its conflicts are resolved'],
        ],
        exits: [[1, 'conflicts, a dirty worktree, nothing in progress for --continue, or no worktree'], GIT_FAILED],
      },
    ],
  },
  {
    name: 'pr',
    summary: "a job's pull request",
    commands: [
      { command: 'pr find', args: '<id>', summary: "find the job's open PR by branch and record it", exits: [NO_JOB, GH_FAILED] },
      {
        command: 'pr open',
        args: '<id> [--title T] [--draft] [--force]',
        summary: "push the verified branch and open or update its PR; with job repos, every repo is checked first, then each non-verify-only member's branch is pushed and its PR opened or updated (result: repos) in dependency order before the root PR; a repo an interim strategy holds back is not pushed (result: deferred; docs/CONFIG.md \"Interim strategies\")",
        flags: [
          ['--title T', 'the PR title (default: the job title)'],
          ['--draft', 'open it as a draft'],
          ['--force', 'publish a HEAD that forge verify has not passed'],
        ],
        exits: [[1, 'no such job or worktree, an unverified HEAD (of any job repo), nothing to push (in any job repo), no GitHub slug for a member repo, a likely secret in a PR title or body or the commits it would push (code secret_found), an interim pin that cannot be written, or one that is not the dependency\'s checked HEAD (code interim_stale)'], GH_FAILED],
      },
      {
        command: 'pr sync',
        args: '<id>',
        summary: "read the PR's state, checks and review feedback into the job; each member repo PR's state and checks are read first, and the job is done only when every PR merged; a multi-repo job's PR bodies get their sibling links",
        exits: [NO_JOB, GH_FAILED],
      },
      {
        command: 'pr merge',
        args: '<id> [--repo NAME | --root] [--now]',
        summary:
          "merge once merge.auto is on, the approver's recorded APPROVE still stands and covers the PR head, no escalate-floor path changed and CI passed at a settled head; or queue auto-merge, or defer; a multi-repo job's PRs merge in the components' dependsOn order, never a PR before its dependencies; --now is a human's override",
        flags: [
          ['--repo NAME', 'merge only that member repo PR, once every PR it depends on merged'],
          ['--root', 'merge only the root repo PR, once every PR it depends on merged'],
          [
            '--now',
            "a human's override in their own terminal: merge without the eligibility, floor and CI checks (logged as pr-merge-bypass); refused in a daemon session; never bypasses the merge order or a release gate",
          ],
        ],
        exits: [
          [
            1,
            "the merge was refused or failed (the result says why), a dependency PR is not merged yet, the dependsOn edges form a cycle, or a consumer's release gate is held or bump-due (reason order|cycle|release), merge.auto off, a rework, a new round or a stage change after the approver's decision, no eligible decision for the PR head, an escalate-floor path (reason auto-off|superseded|decision|floor), the job has no PR, --repo names no PR member, --repo and --root together, --root given a value, a daemon session passing --now, another job's id or a broken scope, the office daemon session ran it, or a protected path at the PR head that no human approved at that content (code protected_path; --now overrides)",
          ],
          GH_FAILED,
        ],
      },
      {
        command: 'pr ready',
        args: '<id> [--repo NAME | --root]',
        summary: "mark the job's open draft PRs ready for review, in merge order (result: ready and skipped); a consumer held by a local or sequential interim edge stays a draft until a human records its dependency's release (forge job interim release), and a consumer with a recorded release until verify bumped its manifests to it",
        flags: [
          ['--repo NAME', 'only that member repo PR'],
          ['--root', 'only the root repo PR'],
        ],
        exits: [[1, "no such job, --repo names no PR member, --repo and --root together, --root given a value, or a targeted PR's release gate is held or bump-due, or its manifests at HEAD don't name the recorded release (code release_gate; nothing is called)"], GH_FAILED],
      },
    ],
  },
  {
    name: 'roster',
    summary: 'the agent roster',
    commands: [{ command: 'roster', args: '', summary: "each role's agent prompt, model, effort and prompt hash, plus the learning count and oldest review-by" }],
  },
  {
    name: 'retro',
    summary: 'retrospectives over finished jobs',
    commands: [
      { command: 'retro due', args: '', summary: 'whether a retro is due: improve.retroEvery jobs finished since the last one' },
      {
        command: 'retro prepare',
        args: '<job> [--since DATE]',
        summary: "gather metrics, human interventions and review history into the retro job's dir, including learnings past their review-by",
        flags: [['--since DATE', 'only jobs since DATE (default: since the last retro)']],
        exits: [NO_JOB],
      },
    ],
  },
  {
    name: 'version',
    summary: "this install's version",
    commands: [
      {
        command: 'version',
        args: '[--json]',
        summary: 'print {version}; --json adds commit, installedAs and node',
        flags: [['--json', "print {version, commit, installedAs, node}: commit from a release archive's COMMIT file, the plugin install record or git, else null"]],
      },
    ],
  },
  {
    name: 'help',
    summary: 'this help, or a command\'s',
    commands: [{ command: 'help', args: '[<command> [<subcommand>]]', summary: "the command list, a group's subcommands, or one command's flags and exit codes" }],
  },
];

const ALL = [...STATUS, ...TRACKER, ...JOB, ...CORE, ...BACKING, ...ENVIRONMENT, ...FOCUS, ...AUDIT, ...BUDGET, ...SECRETS, ...VERIFIERS, ...GIT, ...EVAL, ...EXPERIMENT, ...REQUESTS, ...DAEMON, ...NOTIFY, ...RELEASE, ...INIT, ...CONFIG, ...DOCTOR, ...DASH, ...UPDATE];
const byName = (a: string, b: string): number => a.localeCompare(b, 'en');
const flagKey = (f: string): string => f.replace(/^[-\s]+/, '');

/** Every command group, alphabetical like its subcommands and flags, so a name is found without reading the lot. */
export const GROUPS: HelpGroup[] = [...ALL]
  .sort((a, b) => byName(a.name, b.name))
  .map((g) => ({
    ...g,
    commands: [...g.commands]
      .sort((a, b) => byName(a.command, b.command))
      .map((c) => (c.flags ? { ...c, flags: [...c.flags].sort(([a], [b]) => byName(flagKey(a), flagKey(b))) } : c)),
  }));

/** Flags every command takes. */
export const GLOBAL_FLAGS: [string, string][] = [
  ['--json', 'machine-readable output: errors print as one JSON line on stdout, and strings as JSON strings'],
  ['--mode human|agent', 'output for a terminal (human) or a program (agent); default human only when stdout is a terminal, agent under --json, FORGE_MODE when set'],
  ['--help', "print this command's help instead of running it"],
  ['--pretty', 'indent JSON output'],
];

const EXIT_SUMMARY = 'Exit codes: 0 ok · 1 failed · 2 usage · 3 owned · 4 blocked · 5 external (docs/CLI.md)';
const USAGE_EXIT = 'the call could not be parsed, or .forge/config.yml is missing or invalid';

/** A group that is one command, `forge verify <id>`, rather than subcommands. */
const single = (g: HelpGroup): boolean => g.commands.length === 1 && g.commands[0].command === g.name;
const usageLine = (c: CommandHelp): string => ['forge', c.command, c.args].filter(Boolean).join(' ');
const subs = (g: HelpGroup): string => g.commands.map((c) => c.command.slice(g.name.length + 1)).join('|');
const columns = (rows: [string, string][], max: number, indent = '  '): string => {
  const w = Math.min(max, Math.max(...rows.map(([l]) => l.length)));
  return rows.map(([l, r]) => `${indent}${l.length > w ? `${l}  ` : l.padEnd(w + 2)}${r}`.trimEnd()).join('\n');
};

export type HelpTarget = { group?: undefined; command?: undefined } | { group: HelpGroup; command?: CommandHelp };

/** What `forge help <words>` shows: the overview, a group or one command; null for an unknown command. */
export function findHelp(words: readonly string[]): HelpTarget | null {
  if (!words.length) return {};
  const group = GROUPS.find((g) => g.name === words[0]);
  if (!group) return null;
  const command = words[1] === undefined ? undefined : group.commands.find((c) => c.command === `${group.name} ${words[1]}`);
  if (command) return { group, command };
  return single(group) ? { group, command: group.commands[0] } : { group };
}

export function renderOverview(): string {
  const rows = GROUPS.map((g): [string, string] => [single(g) ? usageLine(g.commands[0]) : `forge ${g.name} ${subs(g)}`, g.summary]);
  return [
    `⚒️  Forge v${forgeVersion()}: a lightweight, self-improving software factory`,
    '',
    'Usage: forge <command> [args] [--json] [--mode human|agent] [--help] [--pretty]',
    '',
    columns(rows, 36),
    '',
    'Global flags:',
    columns(GLOBAL_FLAGS, 12),
    '',
    EXIT_SUMMARY,
    'Run forge help <command> for its flags and exit codes.',
    '',
    `Docs: ${path.join(PLUGIN_ROOT, 'docs')}`,
  ].join('\n');
}

function renderGroup(g: HelpGroup): string {
  if (single(g)) return renderCommand(g.commands[0]);
  return [
    `forge ${g.name}: ${g.summary}`,
    '',
    columns(g.commands.map((c) => [usageLine(c), c.summary]), 48),
    '',
    `Run forge help ${g.name} <subcommand> for flags and exit codes.`,
  ].join('\n');
}

export function renderCommand(c: CommandHelp): string {
  const exits = new Map<number, string>([[0, 'ok'], [2, `usage: ${USAGE_EXIT}`]]);
  for (const [code, when] of c.exits ?? []) exits.set(code, when);
  const lines = [
    usageLine(c),
    '',
    c.summary,
    '',
    'Flags:',
    // A command's own entry for a global flag (version's --json) replaces the generic line.
    columns([...(c.flags ?? []), ...GLOBAL_FLAGS.filter(([g]) => !c.flags?.some(([f]) => f === g))], 24),
    '',
    'Exit codes:',
    ...[...exits].sort(([a], [b]) => a - b).map(([code, when]) => `  ${code}  ${when}`),
  ];
  if (c.docs) lines.push('', `See: ${c.docs[0]} (${c.docs[1]})`);
  return lines.join('\n');
}

/**
 * A command as `forge help --json` prints it. `readme` only picks README rows, so it stays out of
 * the JSON, where docs/CLI.md "Stability" would make it a field scripts may rely on.
 */
function publicCommand(c: CommandHelp): Omit<CommandHelp, 'readme'> {
  const { readme: _readme, ...rest } = c;
  return rest;
}
const publicGroup = (g: HelpGroup) => ({ ...g, commands: g.commands.map(publicCommand) });

/** `forge help [words]`, `forge --help` and `forge <words> --help`. */
export function helpCmd(words: readonly string[], flags: Record<string, any>): void {
  const h = findHelp(words);
  if (!h) throw new ForgeError(`unknown command "${words[0]}"; run \`forge help\` to list commands`, 'unknown_command', 'forge help');
  if (flags.json) return out(h.command ? publicCommand(h.command) : h.group ? publicGroup(h.group) : { version: forgeVersion(), groups: GROUPS.map(publicGroup) }, flags);
  out(h.command ? renderCommand(h.command) : h.group ? renderGroup(h.group) : renderOverview(), flags);
}

export const README_START = '<!-- forge:commands:start (generated from lib/cli/commands/*.ts by npm run docs:commands; edit those tables) -->';
export const README_END = '<!-- forge:commands:end -->';

/** README's CLI table: the `readme: true` rows, in overview order. */
export function readmeTable(): string {
  const cell = (text: string) => text.replace(/\|/g, '\\|');
  const rows = GROUPS.flatMap((g) => g.commands.filter((c) => c.readme));
  return [
    '| Command | What it does |',
    '|---|---|',
    ...rows.map((c) => `| ${cell(`\`${usageLine(c)}\``)} | ${cell(c.summary)}${c.docs ? ` (see [${c.docs[0]}](${c.docs[1]}))` : ''} |`),
  ].join('\n');
}

/** README.md's text with the lines between the markers replaced by readmeTable(). */
export function syncReadme(readme: string): string {
  return replaceRegion(readme, README_START, README_END, readmeTable(), 'README.md');
}

export const CLI_START = '<!-- forge:cli:start (generated from lib/cli/commands/*.ts by npm run docs:cli; edit those tables) -->';
export const CLI_END = '<!-- forge:cli:end -->';
export const ERRORS_START = '<!-- forge:errors:start (generated from ERROR_CODE_DOCS in lib/core/errors.ts by npm run docs:cli; edit that) -->';
export const ERRORS_END = '<!-- forge:errors:end -->';

/** Help text as markdown prose: outside backtick spans, `<` and `*` would start HTML or emphasis. */
const mdText = (text: string): string =>
  text
    .split(/(`[^`]*`)/)
    .map((part) => (part.startsWith('`') && part.endsWith('`') && part.length > 1 ? part : part.replace(/</g, '&lt;').replace(/\*/g, '\\*')))
    .join('');
/** Help text in a table cell, where every `|`, in code spans too, would end the cell. */
const mdCell = (text: string): string => mdText(text).replace(/\|/g, '\\|');
const flagRows = (rows: readonly [string, string][]): string[] => rows.map(([f, m]) => `| ${mdCell(`\`${f}\``)} | ${mdCell(m)} |`);
/** A help table's docs link from docs/CLI.md: docs/ paths are siblings, everything else sits one level up. */
const docsHref = (href: string): string => (href.startsWith('docs/') ? href.slice('docs/'.length) : `../${href}`);

function commandReference(c: CommandHelp): string[] {
  const blocks = [`**\`${usageLine(c)}\`**: ${mdText(c.summary)}`];
  if (c.flags?.length) blocks.push(['| Flag | Meaning |', '|---|---|', ...flagRows(c.flags)].join('\n'));
  if (c.exits?.length) blocks.push(['| Exit | When |', '|---|---|', ...c.exits.map(([code, when]) => `| ${code} | ${mdCell(when)} |`)].join('\n'));
  if (c.docs) blocks.push(`See [${mdText(c.docs[0])}](${docsHref(c.docs[1])}).`);
  return blocks;
}

/** docs/CLI.md's command reference: every group and command in `forge help` order, with its flags, exits and docs link. */
export function cliReference(groups: readonly HelpGroup[] = GROUPS): string {
  const blocks = [
    `Every command also takes these flags, and exits 0 when it did what it was asked or 2 (\`usage\`) when ${USAGE_EXIT}.`,
    ['| Global flag | Meaning |', '|---|---|', ...flagRows(GLOBAL_FLAGS)].join('\n'),
  ];
  for (const g of groups) {
    blocks.push(`### \`forge ${g.name}\``, `${mdText(g.summary.charAt(0).toUpperCase() + g.summary.slice(1))}.`);
    for (const c of g.commands) blocks.push(...commandReference(c));
  }
  return blocks.join('\n\n');
}

/** docs/CLI.md's "Error codes" table, in ERROR_CODES order. */
export function errorCodeTable(): string {
  const rows = (Object.keys(ERROR_CODES) as ErrorCode[]).map((code) => `| \`${code}\` | ${ERROR_CODES[code]} | ${ERROR_CODE_DOCS[code].replace(/\|/g, '\\|')} |`);
  return ['| Code | Exit | Meaning |', '|---|---|---|', ...rows].join('\n');
}

/** docs/CLI.md's text with the command reference and the error-code table regenerated. */
export function syncCliDoc(text: string): string {
  const withErrors = replaceRegion(text, ERRORS_START, ERRORS_END, errorCodeTable(), 'docs/CLI.md');
  return replaceRegion(withErrors, CLI_START, CLI_END, cliReference(), 'docs/CLI.md');
}

/** A `usage:` error for a group in these tables (lib/cli/main.ts routes some groups itself). */
export function usage(name: string, sub?: string): ForgeError {
  const g = GROUPS.find((x) => x.name === name);
  if (!g) throw new ForgeError(`no help table for forge ${name}`, 'internal');
  return usageError(g, sub);
}

/** The help for the longest known prefix of the call's words: `forge help job claim`. */
function usageHint(argv: readonly string[]): string {
  const [cmd, sub] = parseArgs([...argv]).pos;
  const g = GROUPS.find((x) => x.name === cmd);
  if (!g) return 'forge help';
  const c = g.commands.find((x) => x.command === `${g.name} ${sub}`);
  return `forge help ${c ? c.command : g.name}`;
}

const DEFAULT_HINTS: Partial<Record<string, string>> = { unknown_command: 'forge help', not_initialized: '/forge init' };

/** The error as `--json` prints it. Anything but a ForgeError is a bug or an unexpected Node error. */
export function toCliError(err: unknown, argv: readonly string[]): CliError {
  if (err instanceof ForgeError) {
    const hint = err.hint ?? (err.code === 'usage' ? usageHint(argv) : (DEFAULT_HINTS[err.code] ?? null));
    return { code: err.code, message: err.message, exit: err.exitCode, hint };
  }
  const message = (err as { message?: unknown } | null)?.message ?? err;
  return { code: 'internal', message: String(message), exit: ERROR_CODES.internal, hint: null };
}

/**
 * Reports a failed `forge` call and returns its exit code: one JSON line on stdout under `--json`
 * (JSON.stringify keeps message text from breaking the line), `error:` and `fix:` lines on stderr
 * in human mode, else `forge: <message>` on stderr. The mode is resolved leniently: the error may
 * be a bad --mode or FORGE_MODE itself. FORGE_DEBUG adds the stack on stderr either way.
 */
export function reportError(err: unknown, argv: readonly string[]): number {
  const e = toCliError(err, argv);
  if (jsonFlag(argv)) process.stdout.write(JSON.stringify({ error: e }) + '\n');
  else if (lenientOutputMode(argv, process.env, process.stdout.isTTY === true) === 'human') process.stderr.write(renderError(e, { color: colorEnabled(process.stderr.isTTY === true, process.env) }));
  else process.stderr.write(`forge: ${e.message}\n`);
  const stack = (err as { stack?: unknown } | null)?.stack;
  if (process.env.FORGE_DEBUG && stack) process.stderr.write(stack + '\n');
  return e.exit;
}
