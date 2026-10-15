// `forge help`, `--help` and the CLI's error contract (docs/CLI.md). The help tables live beside
// their command modules as `HELP`; CORE holds the commands lib/cli.ts routes itself. The same tables
// build `usage:` errors, the README command table and the `--json` error hint.
import path from 'node:path';
import { forgeVersion } from '../evals.ts';
import { PLUGIN_ROOT } from '../paths.ts';
import { ERROR_CODES, ForgeError } from '../util.ts';
import { jsonFlag, out, parseArgs, usageError } from './args.ts';
import { HELP as CONFIG } from './config.ts';
import { HELP as DAEMON } from './daemon.ts';
import { HELP as DASH } from './dash.ts';
import { HELP as EVAL } from './eval.ts';
import { HELP as GIT } from './git.ts';
import { HELP as INIT } from './init.ts';
import { HELP as JOB } from './job.ts';
import { HELP as REQUESTS } from './requests.ts';
import { HELP as SECRETS } from './secrets.ts';
import { HELP as STATUS } from './status.ts';
import { HELP as TRACKER } from './tracker.ts';
import { HELP as UPDATE } from './update.ts';
import type { CliError, CommandHelp, HelpGroup } from '../types.ts';

const NO_JOB: [1, string] = [1, 'no such job'];
const GIT_FAILED: [5, string] = [5, 'git failed'];
const GH_FAILED: [5, string] = [5, 'gh or git failed'];

/** The commands lib/cli.ts routes itself. */
export const CORE: HelpGroup[] = [
  {
    name: 'worktree',
    summary: "a job's git worktree",
    commands: [
      {
        command: 'worktree create',
        args: '<id>',
        summary: "create the job's worktree and branch (stacked on its one unmerged dependency, if any) and run worktrees.setup there",
        exits: [[1, 'no such job, an unsafe branch name, or no free port'], GIT_FAILED],
      },
      {
        command: 'worktree remove',
        args: '<id> [--delete-branch] [--force]',
        summary: "remove the job's worktree",
        flags: [
          ['--delete-branch', 'delete its branch too'],
          ['--force', 'remove it with uncommitted changes'],
        ],
        exits: [NO_JOB, GIT_FAILED],
      },
      { command: 'worktree path', args: '<id>', summary: "the worktree's path (empty when it has none)", exits: [NO_JOB] },
      { command: 'worktree prune', args: '', summary: "prune git's records of worktrees that are gone", exits: [GIT_FAILED] },
    ],
  },
  {
    name: 'run',
    summary: "run a configured command in a job's worktree",
    commands: [
      {
        command: 'run',
        args: '<id> <command> [--background] [--tail N] [-- <args…>]',
        summary: 'run commands.<command> in the job\'s worktree, logging its output to the job dir and printing the tail',
        flags: [
          ['--background', 'start it detached (dev servers); stop it with forge stop'],
          ['--tail N', 'print the last N lines (default 40)'],
          ['-- <args…>', 'quoted arguments, placed at {args} in the template or appended'],
        ],
        exits: [[1, 'the command failed, is not configured, or the job has no worktree']],
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
          ['--strategy merge|rebase', 'how to integrate (default: pr.updateStrategy once a PR is open, else rebase)'],
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
        summary: 'push the verified branch and open or update its PR',
        flags: [
          ['--title T', 'the PR title (default: the job title)'],
          ['--draft', 'open it as a draft'],
          ['--force', 'publish a HEAD that forge verify has not passed'],
        ],
        exits: [[1, 'no such job or worktree, an unverified HEAD, nothing to push, or a likely secret in the PR title or body or the commits it would push (code secret_found)'], GH_FAILED],
      },
      { command: 'pr sync', args: '<id>', summary: "read the PR's state, checks and review feedback into the job", exits: [NO_JOB, GH_FAILED] },
      {
        command: 'pr merge',
        args: '<id> [--now]',
        summary: 'merge once CI passes, or queue auto-merge, or defer; --now is a human override that bypasses CI',
        flags: [['--now', 'merge without waiting for CI (logged as pr-merge-bypass)']],
        exits: [[1, 'the merge was refused or failed (the result says why), or the job has no PR'], GH_FAILED],
      },
    ],
  },
  {
    name: 'roster',
    summary: 'the agent roster',
    commands: [{ command: 'roster', args: '', summary: "each role's agent prompt, model and prompt hash" }],
  },
  {
    name: 'retro',
    summary: 'retrospectives over finished jobs',
    commands: [
      { command: 'retro due', args: '', summary: 'whether a retro is due: improve.retroEvery jobs finished since the last one' },
      {
        command: 'retro prepare',
        args: '<job> [--since DATE]',
        summary: "gather metrics, human interventions and review history into the retro job's dir",
        flags: [['--since DATE', 'only jobs since DATE (default: since the last retro)']],
        exits: [NO_JOB],
      },
    ],
  },
  {
    name: 'doctor',
    summary: 'check this repo and machine for Forge',
    commands: [{ command: 'doctor', args: '', summary: 'check this repo and machine for Forge (tools, config, job files) and print what is wrong, indented' }],
  },
  {
    name: 'version',
    summary: "this install's version",
    commands: [{ command: 'version', args: '', summary: 'print {version}' }],
  },
  {
    name: 'help',
    summary: 'this help, or a command\'s',
    commands: [{ command: 'help', args: '[<command> [<subcommand>]]', summary: "the command list, a group's subcommands, or one command's flags and exit codes" }],
  },
];

const ALL = [...STATUS, ...TRACKER, ...JOB, ...CORE, ...SECRETS, ...GIT, ...EVAL, ...REQUESTS, ...DAEMON, ...INIT, ...CONFIG, ...DASH, ...UPDATE];
const ORDER = ['status', 'next', 'job', 'worktree', 'run', 'stop', 'verify', 'secrets', 'integrate', 'git', 'pr', 'sync', 'tracker', 'stats', 'roster', 'retro', 'eval', 'requests', 'daemon', 'init', 'migrate', 'config', 'doctor', 'dash', 'version', 'update', 'help'];

/** Every command group, in the order the overview lists them. */
export const GROUPS: HelpGroup[] = ORDER.map((name) => {
  const g = ALL.find((x) => x.name === name);
  if (!g) throw new Error(`no help table for forge ${name}`);
  return g;
});

/** Flags every command takes. */
export const GLOBAL_FLAGS: [string, string][] = [
  ['--json', 'machine-readable output: errors print as one JSON line on stdout, and strings as JSON strings'],
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
    'Usage: forge <command> [args] [--json] [--help] [--pretty]',
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

export function renderGroup(g: HelpGroup): string {
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
    columns([...(c.flags ?? []), ...GLOBAL_FLAGS], 24),
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

export const README_START = '<!-- forge:commands:start (generated from lib/commands/*.ts by npm run docs:commands; edit those tables) -->';
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
  const start = readme.indexOf(README_START);
  const end = readme.indexOf(README_END);
  if (start < 0 || end < start) throw new ForgeError(`README.md has no ${README_START} … ${README_END} region`);
  return `${readme.slice(0, start + README_START.length)}\n${readmeTable()}\n${readme.slice(end)}`;
}

/** A `usage:` error for a group in these tables (lib/cli.ts routes some groups itself). */
export function usage(name: string, sub?: string): ForgeError {
  const g = GROUPS.find((x) => x.name === name);
  if (!g) throw new Error(`no help table for forge ${name}`);
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
 * (JSON.stringify keeps message text from breaking the line), else `forge: <message>` on stderr.
 * FORGE_DEBUG adds the stack on stderr either way.
 */
export function reportError(err: unknown, argv: readonly string[]): number {
  const e = toCliError(err, argv);
  if (jsonFlag(argv)) process.stdout.write(JSON.stringify({ error: e }) + '\n');
  else process.stderr.write(`forge: ${e.message}\n`);
  const stack = (err as { stack?: unknown } | null)?.stack;
  if (process.env.FORGE_DEBUG && stack) process.stderr.write(stack + '\n');
  return e.exit;
}
