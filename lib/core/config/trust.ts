// What a daemon session may run: daemon.* validation (the command, its flags and allowedTools) and
// the trust digest that pins the files deciding what `forge` executes from the main checkout.
// Imports no config.ts, which re-exports these.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validEffort } from './models.ts';
import { defaults } from './keys/defaults.ts';
import { allInstructionFiles } from './validators/instructions.ts';
import { paths } from '../paths.ts';
import { DAEMON_AUTH, EFFORTS, KEEP_AWAKE_MODES } from '../job/schema.ts';
import * as yaml from '../format/yaml.ts';
import { isMap } from '../shape.ts';
import { isClaudeExecutable } from '../os/process.ts';
import { splitWords } from '../text.ts';
import type { Config } from './types.ts';

/**
 * Checked whether or not the daemon is enabled, so a migrated launcher surfaces in
 * `forge config validate` / `forge doctor`. Every message starts with `daemon.`,
 * `dashboard.launcher` or `runtime.effort`: each one blocks a session start. runtime.effort is
 * here because it becomes a word of every session's argv, so an invalid one fails closed.
 * When `root` is given, an absolute executable inside it is refused too.
 */
export function daemonProblems(c: unknown, root?: string): string[] {
  const cfg: Record<string, any> = isMap(c) ? c : {};
  const problems: string[] = [];
  const d = cfg.daemon ?? {};
  if (cfg.dashboard && typeof cfg.dashboard === 'object' && 'launcher' in cfg.dashboard)
    problems.push('dashboard.launcher was replaced by daemon.command in config schemaVersion 2; run `forge migrate` and see docs/CONFIG.md "Daemon"');
  if (d.enabled !== undefined && typeof d.enabled !== 'boolean') problems.push(`daemon.enabled must be true or false (got ${JSON.stringify(d.enabled)})`);
  let words: string[] | null = null;
  try {
    words = typeof d.command === 'string' ? splitWords(d.command, 'daemon.command') : null;
  } catch (e) {
    problems.push((e as Error).message);
  }
  if (typeof d.command !== 'string' || !d.command.trim()) problems.push('daemon.command must be a non-empty command template');
  else if (!words) {
    // Already reported: the template doesn't split.
  } else if (d.command.includes('{prompt}'))
    problems.push('daemon.command contains {prompt}: that is a dashboard.launcher shell template, and the daemon sends its turn on stdin instead; rewrite it as described in docs/CONFIG.md "Daemon"');
  else if (!isClaudeExecutable(words[0] ?? '') || (root && insideRepo(root, words[0])))
    problems.push(`daemon.command must run claude: its first word must be claude (on PATH) or an absolute path to claude outside the repo (got ${JSON.stringify(words[0] ?? '')})`);
  else if (!words.includes('{session}')) problems.push('daemon.command must contain {session} as its own word so the daemon can pin and resume its session id');
  const tools = d.allowedTools;
  if (!Array.isArray(tools)) problems.push(`daemon.allowedTools must be a list of tool names (got ${JSON.stringify(tools)})`);
  else {
    const bad = tools.filter(badEntry);
    if (bad.length) problems.push(`daemon.allowedTools entries must be non-empty strings without commas (got ${bad.map((t: any) => JSON.stringify(t)).join(', ')})`);
    if (!tools.includes('Agent')) problems.push('daemon.allowedTools must include Agent: the orchestrator runs every role as a subagent');
    const broad = tools.filter((t: any) => typeof t === 'string' && broadBash(t));
    if (broad.length)
      problems.push(
        `daemon.allowedTools must not include ${broad.map((t: any) => JSON.stringify(t)).join(', ')}: those reach arbitrary code execution, file writes or GitHub writes in an unattended session; use the scoped forms and \`forge git\` (docs/CONFIG.md "Daemon")`,
      );
    const unscoped = tools.filter((t: any) => typeof t === 'string' && unscopedEntry(t));
    if (unscoped.length)
      problems.push(
        `daemon.allowedTools must not include ${unscoped.map((t: any) => JSON.stringify(t)).join(', ')}: list bare Edit and Write, which the daemon scopes to the job folders and worktrees at spawn; MCP tools are allowed per call from the dashboard (docs/CONFIG.md "Daemon")`,
      );
  }
  if (words) problems.push(...wideningFlags(words));
  const max = d.maxConcurrent;
  if (!(Number.isInteger(max) && max >= 1 && max <= 16)) problems.push(`daemon.maxConcurrent must be an integer from 1 to 16 (got ${JSON.stringify(max)})`);
  const idle = d.idleStopMinutes;
  if (idle !== null && !(typeof idle === 'number' && Number.isFinite(idle) && idle > 0))
    problems.push(`daemon.idleStopMinutes must be null or a positive number (got ${JSON.stringify(idle)})`);
  const turn = d.turnTimeoutMinutes;
  if (turn !== null && !(typeof turn === 'number' && Number.isFinite(turn) && turn > 0))
    problems.push(`daemon.turnTimeoutMinutes must be null or a positive number (got ${JSON.stringify(turn)})`);
  const prompt = d.permissionTimeoutMinutes;
  if (prompt !== null && !(typeof prompt === 'number' && Number.isFinite(prompt) && prompt > 0))
    problems.push(`daemon.permissionTimeoutMinutes must be null or a positive number (got ${JSON.stringify(prompt)})`);
  const fresh = d.freshAfterTokens;
  if (fresh !== null && !(Number.isInteger(fresh) && fresh > 0)) problems.push(`daemon.freshAfterTokens must be null or a positive integer (got ${JSON.stringify(fresh)})`);
  if (!DAEMON_AUTH.includes(d.auth)) problems.push(`daemon.auth must be one of ${DAEMON_AUTH.join(' | ')} (got ${JSON.stringify(d.auth)})`);
  problems.push(...jobBudgetProblems(d.jobBudget), ...dailyUsdProblems(d.dailyUsd));
  if (!(KEEP_AWAKE_MODES as readonly unknown[]).includes(d.keepAwake)) problems.push(`daemon.keepAwake must be auto or never (got ${JSON.stringify(d.keepAwake)})`);
  const effort = cfg.runtime?.effort ?? null;
  if (effort !== null && !validEffort(effort))
    problems.push(`runtime.effort must be one of ${EFFORTS.join(' | ')}, or null (got ${JSON.stringify(effort)})`);
  return problems;
}

const JOB_BUDGET_KEYS = ['tokens', 'usd', 'minutes'];

/** daemon.jobBudget: null, or a map of tokens (an integer), usd and minutes, each null or a number >= 0. */
function jobBudgetProblems(b: unknown): string[] {
  if (b === null || b === undefined) return [];
  if (typeof b !== 'object' || Array.isArray(b)) return [`daemon.jobBudget must be null or a map of ${JOB_BUDGET_KEYS.join(', ')} (got ${JSON.stringify(b)})`];
  const problems: string[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (!JOB_BUDGET_KEYS.includes(k)) problems.push(`daemon.jobBudget.${k} is not a key (use ${JOB_BUDGET_KEYS.join(', ')})`);
    else if (v === null) continue;
    else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) problems.push(`daemon.jobBudget.${k} must be null or a number >= 0 (got ${JSON.stringify(v)})`);
    else if (k === 'tokens' && !Number.isInteger(v)) problems.push(`daemon.jobBudget.tokens must be null or an integer >= 0 (got ${v})`);
  }
  return problems;
}

const DAILY_USD_KEYS = ['inbox', 'office', 'chat'];

/** daemon.dailyUsd: null, or a map of inbox, office and chat, each null or a number >= 0 (dollars per UTC day). */
function dailyUsdProblems(b: unknown): string[] {
  if (b === null || b === undefined) return [];
  if (typeof b !== 'object' || Array.isArray(b)) return [`daemon.dailyUsd must be null or a map of ${DAILY_USD_KEYS.join(', ')} (got ${JSON.stringify(b)})`];
  const problems: string[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (!DAILY_USD_KEYS.includes(k)) problems.push(`daemon.dailyUsd.${k} is not a key (use ${DAILY_USD_KEYS.join(', ')})`);
    else if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) problems.push(`daemon.dailyUsd.${k} must be null or a number >= 0 (got ${JSON.stringify(v)})`);
  }
  return problems;
}

/**
 * The main-checkout paths that decide what `forge` runs or what every later agent reads with no
 * review: the trust digest hashes them, the post-turn check (lib/office/session/confine.ts) watches
 * them, and a daemon session's file tools may not write them. `forgeWrites` are the entries under
 * them that `forge` itself writes, which neither check counts. `anyDepth` names files watched
 * wherever they sit in the checkout.
 */
export const PROTECTED = Object.freeze({
  files: Object.freeze(['.forge/config.yml', '.forge/secrets-allow.txt', 'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']),
  dirs: Object.freeze(['.forge/trackers', '.forge/verifiers', '.forge/notes', '.forge/reviewers', '.forge/evals', '.forge/ci']),
  forgeWrites: Object.freeze(['.forge/evals/runs', '.forge/evals/recall/runs']),
  anyDepth: Object.freeze(['CLAUDE.md', 'CLAUDE.local.md']),
});

/** Carries the supervisor's trustDigest into the daemon session's environment. */
export const TRUST_ENV = 'FORGE_DAEMON_TRUST';

/**
 * Fingerprint of what decides the code `forge` runs from the main checkout, and of what every
 * later agent reads with no review: the checkout's realpath, `.forge/config.yml` (commands run
 * through a shell; daemon.* starts sessions), the secret scanner's allowlist
 * `.forge/secrets-allow.txt` (a session that could edit it could allow its own leak), the custom
 * tracker modules imported from `.forge/trackers/` and the verifiers in `.forge/verifiers/`, which
 * gate the pipeline, then the rest of PROTECTED (notes, reviewer checklists, evals, CI checks, the
 * root's CLAUDE.md, CLAUDE.local.md and AGENTS.md) and every configured instruction file. An
 * unreadable entry hashes as a marker rather than throwing, so a tampered file can't turn the check
 * into a crash. `configBytes` is config.yml as already read (null: absent).
 */
export function trustDigest(root: string, configBytes?: Buffer | null): string {
  const h = crypto.createHash('sha256');
  const add = (label: string, data: string | Buffer) => h.update(`${label}\0${Buffer.byteLength(data)}\0`).update(data);
  let real = path.resolve(root);
  try {
    real = fs.realpathSync(root);
  } catch {}
  add('root', real);
  const p = paths(root);
  const file = (label: string, f: string) => {
    try {
      add(label, fs.readFileSync(f));
    } catch (e) {
      add(label, `!${(e as any).code ?? 'unreadable'}`);
    }
  };
  let config: Buffer | null = null;
  if (configBytes === undefined) {
    try {
      config = fs.readFileSync(p.config);
      add('config', config);
    } catch (e) {
      add('config', `!${(e as any).code ?? 'unreadable'}`);
    }
  } else {
    config = configBytes;
    add('config', configBytes ?? '!ENOENT');
  }
  file('secrets-allow', path.join(p.dir, 'secrets-allow.txt'));
  // Verifiers gate the pipeline: a session that could weaken a block verifier could pass its own work.
  for (const [label, base] of [['trackers', p.trackers], ['verifiers', p.verifiers]] as const) {
    for (const { rel, link, dir } of walk(base)) {
      const f = path.join(base, rel);
      if (link) {
        try {
          add(`link ${label === 'trackers' ? '' : 'verifiers/'}${rel}`, fs.readlinkSync(f));
        } catch {}
      } else if (!dir) file(`${label}/${rel}`, f);
    }
  }
  // The entries hashed above keep their labels and order, so a digest over them alone is unchanged in form.
  const early = ['.forge/config.yml', '.forge/secrets-allow.txt', '.forge/trackers', '.forge/verifiers'];
  for (const f of PROTECTED.files.filter((x) => !early.includes(x))) file(f, path.join(root, f));
  const skip = (rel: string) => PROTECTED.forgeWrites.includes(rel);
  for (const d of PROTECTED.dirs.filter((x) => !early.includes(x))) {
    const base = path.join(root, d);
    for (const { rel, link, dir } of walk(base, '', (r) => skip(`${d}/${r}`))) {
      const f = path.join(base, rel);
      if (link) {
        try {
          add(`link ${d}/${rel}`, fs.readlinkSync(f));
        } catch {}
      } else if (!dir) file(`${d}/${rel}`, f);
    }
  }
  const instructions = configuredInstructions(config);
  if (instructions === null) add('instructions', '!unparsable');
  else for (const f of instructions) file(`instructions/${f}`, path.join(root, f));
  return h.digest('hex');
}

/** Every role's instruction files as config.yml's bytes name them (the defaults when absent), or null when they don't parse. Never throws. */
function configuredInstructions(bytes: Buffer | null): string[] | null {
  try {
    const raw = bytes === null ? {} : (yaml.parse(bytes.toString('utf8')) ?? {});
    const listed = isMap(raw) && isMap(raw.project) && raw.project.instructions !== undefined ? raw.project.instructions : defaults().project.instructions;
    return allInstructionFiles({ project: { instructions: listed } } as Pick<Config, 'project'>);
  } catch {
    return null;
  }
}

/** Symlinks under `.forge/trackers/`, which a daemon session refuses. */
export function trackerSymlinks(root: string): string[] {
  return symlinksUnder(paths(root).trackers);
}

/** Paths under dir that are symlinks. */
function symlinksUnder(dir: string): string[] {
  return walk(dir).filter((e) => e.link).map((e) => e.rel);
}

/**
 * Every entry under `dir`, sorted, without following symlinks (`readdir`'s recursive mode
 * follows them, so a link loop never ends). An entry `skip` names is left out with everything under it.
 */
function walk(dir: string, prefix = '', skip: (rel: string) => boolean = () => false): { rel: string; link: boolean; dir: boolean }[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(path.join(dir, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((e) => {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (skip(rel)) return [];
      const me = { rel, link: e.isSymbolicLink(), dir: e.isDirectory() };
      return me.dir ? [me, ...walk(dir, rel, skip)] : [me];
    });
}

/**
 * In a daemon session (FORGE_DAEMON=1), every `forge` call must see the files the supervisor
 * fingerprinted when a human started it. The session can write files in this checkout, so
 * without this an agent misled by tracker text could rewrite `commands.*` and have
 * `forge verify` run them, or edit `daemon.*` for the next spawn. Fails closed. config.yml is
 * read once and `configText` returned, so the caller parses exactly the bytes that were checked.
 */
export function daemonTrust(root: string, env: NodeJS.ProcessEnv = process.env): { problem: string | null; configText?: string | null } {
  if (env.FORGE_DAEMON !== '1') return { problem: null };
  const refuse = (why: string) => ({ problem: `forge refuses to run in this daemon session: ${why}` });
  const want = env[TRUST_ENV];
  if (typeof want !== 'string' || !/^[0-9a-f]{64}$/.test(want))
    return refuse(`${TRUST_ENV} is missing, so it can't check that .forge/config.yml is the one a human started the daemon with`);
  // A symlink's target can change without the link changing, so the digest couldn't pin it.
  const links = trackerSymlinks(root);
  if (links.length) return refuse(`.forge/trackers/ contains symlinks (${links.join(', ')}), which the daemon can't pin; a human replaces them with files`);
  let bytes: Buffer | null = null;
  try {
    bytes = fs.readFileSync(paths(root).config);
  } catch (e) {
    if ((e as any).code !== 'ENOENT') return refuse(`.forge/config.yml is unreadable (${(e as any).code})`);
  }
  if (trustDigest(root, bytes) !== want)
    return refuse(
      'a file Forge trusts (.forge/config.yml, .forge/secrets-allow.txt, .forge/trackers/, .forge/verifiers/, .forge/notes/, .forge/reviewers/, .forge/evals/, .forge/ci/, CLAUDE.md, CLAUDE.local.md, AGENTS.md or a project.instructions file) changed since a human started the daemon (or this is another checkout). Only a human may change what Forge executes or what every agent reads: stop here and leave the change for them to review.',
    );
  return { problem: null, configText: bytes === null ? null : bytes.toString('utf8') };
}

// Bash rules that on their own reach code execution (`git -c`, `git rebase --exec`, `git grep -O`,
// config-defined drivers), file writes into .git (`--output` on the diff family, `git mv`; either can rewrite
// .git/config) or arbitrary GitHub writes (`gh api`). Known forms, not an exhaustive list.
const BROAD_BASH = [
  /^\*?$/,
  /^(git|gh)$/,
  /^git -/,
  /^git (config|grep|submodule|bisect|difftool|mergetool|filter-branch)\b/,
  // `git mv a x/../.git/config` reports "invalid path" yet still renames the file and exits 0.
  /^git (diff|log|show|range-diff|whatchanged|format-patch|mv)\b/,
  /^git rebase(?! --(continue|abort|skip)\b)/,
  /^gh (api|extension|alias|auth|secret|codespace)\b/,
];

function broadBash(tool: string): boolean {
  const m = /^Bash(?:\((.*)\))?$/.exec(tool.trim());
  if (!m) return false;
  const spec = (m[1] ?? '').trim().replace(/(:\*|\s*\*)$/, '').trim();
  return BROAD_BASH.some((re) => re.test(spec));
}

/** An allowedTools entry claude can't take: not a non-empty string, or one with a comma (the list is passed comma-joined). */
function badEntry(t: unknown): boolean {
  return typeof t !== 'string' || !t.trim() || t.includes(',');
}

/** A scoped file rule would widen what the spawn scopes (Edit(//**) reaches ~/.ssh), and an MCP tool writes where no rule sees. */
function unscopedEntry(t: string): boolean {
  return /^(Edit|Write|MultiEdit|NotebookEdit)\(/.test(t.trim()) || t.trim().startsWith('mcp__');
}

/**
 * Why one daemon.allowedTools entry would be refused, as a short fixed reason, or null: the per-entry checks
 * daemonProblems applies (the list-wide one, that Agent is listed, is not here). `forge daemon prompts` runs
 * it over the rules it might suggest, so a suggestion never fails validation once pasted.
 */
export function allowedToolProblem(t: unknown): string | null {
  if (badEntry(t)) return 'not a non-empty string without commas';
  if (broadBash(t as string)) return 'reaches arbitrary code execution, file writes or GitHub writes';
  if (unscopedEntry(t as string)) return 'a scoped file rule or an MCP tool';
  return null;
}

/**
 * Modes that never approve more than allowedTools lists without a human: `default` asks one in the
 * dashboard (`manual` is the name claude now lists for it), `dontAsk` refuses. `auto` is left out:
 * only a human in the dashboard may put a session there (lib/integrations/claude/argv.ts PERMISSION_MODES).
 */
const SAFE_PERMISSION_MODES = ['dontAsk', 'default', 'manual', 'plan'];

/**
 * Claude flags that widen what the unattended session may do beyond `daemon.allowedTools`:
 * skip or relax permission checks, load extra settings/hooks/MCP tools/plugins/agents, grant more
 * directories, or bypass the allowedTools list with a literal one.
 */
function wideningFlags(words: string[]): string[] {
  const problems: string[] = [];
  const why = 'it widens the unattended session\'s permissions beyond daemon.allowedTools (docs/CONFIG.md "Daemon")';
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith('--')) continue;
    const eq = w.indexOf('=');
    const flag = eq > 0 ? w.slice(0, eq) : w;
    const value = eq > 0 ? w.slice(eq + 1) : words[i + 1];
    if (['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--settings', '--mcp-config', '--add-dir', '--permission-prompt-tool', '--agents'].includes(flag))
      problems.push(`daemon.command must not pass ${flag}: ${why}`);
    else if (flag === '--permission-mode' && !SAFE_PERMISSION_MODES.includes(value ?? ''))
      problems.push(`daemon.command must not pass --permission-mode ${value ?? ''}: ${why}; use default or manual (ask a human in the dashboard) or dontAsk (refuse)`);
    // A literal cap would replace the job's own (buildArgv drops it anyway; refusing it says so up front).
    else if (flag === '--max-budget-usd')
      problems.push('daemon.command must not pass --max-budget-usd: Forge passes its own from the job\'s dollar budget (docs/CONFIG.md "Daemon")');
    else if (flag === '--plugin-dir' && value !== '{pluginRoot}') problems.push(`daemon.command must not pass --plugin-dir ${value ?? ''}: only {pluginRoot} may be loaded, since ${why}`);
    else if ((flag === '--allowedTools' || flag === '--allowed-tools') && value !== '{allowedTools}')
      problems.push(`daemon.command must pass ${flag} {allowedTools}, not a literal list, so daemon.allowedTools is validated`);
    // Only claude's three scopes: a source name Forge doesn't know could load settings nobody reviewed.
    else if (flag === '--setting-sources' && !settingSources(value).every((s) => SETTING_SOURCES.includes(s)))
      problems.push(`daemon.command must pass --setting-sources a comma-separated subset of ${SETTING_SOURCES.join(', ')} (got ${JSON.stringify(value ?? '')})`);
    // claude reads these flags' values variadically: a bare word after the value becomes one more
    // tool or plugin dir. {session} expands to --session-id/--resume, so it may follow.
    if (['--allowedTools', '--allowed-tools', '--plugin-dir'].includes(flag)) {
      const next = words[i + (eq > 0 ? 1 : 2)];
      if (next !== undefined && !next.startsWith('-') && next !== '{session}')
        problems.push(`daemon.command must not put ${JSON.stringify(next)} after ${flag}'s value: claude would read it as another value`);
    }
  }
  return problems;
}

/** The setting scopes `--setting-sources` may name. */
const SETTING_SOURCES = ['user', 'project', 'local'];

/** A --setting-sources value's names: split on commas, empty parts dropped; a missing value is no source. */
function settingSources(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * The `daemon isolation` doctor warning: `daemon.command` loads the user's settings, plugins, hooks or
 * MCP servers into every session when it lacks --strict-mcp-config or --setting-sources, or when its
 * --setting-sources names `user`. Null for a lean command, or one that is not a string or doesn't
 * split (daemonProblems reports that). Reads only the template, never the environment; never blocks.
 */
export function daemonIsolationWarning(c: unknown): string | null {
  const command = isMap(c) && isMap(c.daemon) ? c.daemon.command : undefined;
  if (typeof command !== 'string') return null;
  let words: string[];
  try {
    words = splitWords(command, 'daemon.command');
  } catch {
    return null;
  }
  const args = words.slice(1);
  const sources: string[][] = [];
  args.forEach((w, i) => {
    if (w === '--setting-sources') sources.push(settingSources(args[i + 1]));
    else if (w.startsWith('--setting-sources=')) sources.push(settingSources(w.slice('--setting-sources='.length)));
  });
  const lean = args.includes('--strict-mcp-config') && sources.length > 0 && !sources.some((s) => s.includes('user'));
  return lean
    ? null
    : 'daemon.command loads your user settings, plugins, hooks or MCP servers into every session: add --setting-sources project,local --strict-mcp-config (docs/CONFIG.md "Daemon")';
}

function insideRepo(root: string, file: string): boolean {
  if (!path.isAbsolute(file)) return false;
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const rel = path.relative(real(root), real(file));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}
