// What a daemon session may run: daemon.* validation (the command, its flags and allowedTools) and
// the trust digest that pins the files deciding what `forge` executes from the main checkout.
// Imports no config.ts, which re-exports these.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validEffort } from './models.ts';
import { paths } from '../paths.ts';
import { DAEMON_AUTH, EFFORTS } from '../job/schema.ts';
import { isMap } from '../shape.ts';
import { isClaudeExecutable } from '../os/process.ts';
import { splitWords } from '../text.ts';

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
    const bad = tools.filter((t: any) => typeof t !== 'string' || !t.trim() || t.includes(','));
    if (bad.length) problems.push(`daemon.allowedTools entries must be non-empty strings without commas (got ${bad.map((t: any) => JSON.stringify(t)).join(', ')})`);
    if (!tools.includes('Agent')) problems.push('daemon.allowedTools must include Agent: the orchestrator runs every role as a subagent');
    const broad = tools.filter((t: any) => typeof t === 'string' && broadBash(t));
    if (broad.length)
      problems.push(
        `daemon.allowedTools must not include ${broad.map((t: any) => JSON.stringify(t)).join(', ')}: those reach arbitrary code execution, file writes or GitHub writes in an unattended session; use the scoped forms and \`forge git\` (docs/CONFIG.md "Daemon")`,
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
  if (!DAEMON_AUTH.includes(d.auth)) problems.push(`daemon.auth must be one of ${DAEMON_AUTH.join(' | ')} (got ${JSON.stringify(d.auth)})`);
  problems.push(...jobBudgetProblems(d.jobBudget));
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
 * Fingerprint of what decides the code `forge` runs from the main checkout: the checkout's
 * realpath, `.forge/config.yml` (commands run through a shell; daemon.* starts sessions), the
 * secret scanner's allowlist `.forge/secrets-allow.txt` (a session that could edit it could allow
 * its own leak), the custom tracker modules imported from `.forge/trackers/` and the verifiers in
 * `.forge/verifiers/`, which gate the pipeline. An unreadable entry hashes as a
 * marker rather than throwing, so a tampered file can't turn the check into a crash.
 * `configBytes` is config.yml as already read (null: absent).
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
  if (configBytes === undefined) file('config', p.config);
  else add('config', configBytes ?? '!ENOENT');
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
  return h.digest('hex');
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
 * follows them, so a link loop never ends).
 */
function walk(dir: string, prefix = ''): { rel: string; link: boolean; dir: boolean }[] {
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
      const me = { rel, link: e.isSymbolicLink(), dir: e.isDirectory() };
      return me.dir ? [me, ...walk(dir, rel)] : [me];
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
      '.forge/config.yml, .forge/secrets-allow.txt, .forge/trackers/ or .forge/verifiers/ changed since a human started the daemon (or this is another checkout). Only a human may change what Forge executes: stop here and leave the change for them to review.',
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
    else if (flag === '--plugin-dir' && value !== '{pluginRoot}') problems.push(`daemon.command must not pass --plugin-dir ${value ?? ''}: only {pluginRoot} may be loaded, since ${why}`);
    else if ((flag === '--allowedTools' || flag === '--allowed-tools') && value !== '{allowedTools}')
      problems.push(`daemon.command must pass ${flag} {allowedTools}, not a literal list, so daemon.allowedTools is validated`);
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
