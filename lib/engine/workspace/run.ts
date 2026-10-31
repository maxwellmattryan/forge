// Configured commands: fill a command's template and run it in the job's or a member's worktree,
// synchronously for `forge run` and without blocking for verify, logging each run alike.
// A root run on a clean committed tree records its pass in the check cache, which verify's steps reuse
// (lib/engine/verify/cache.ts, the one module of lib/engine/verify/ this file imports).
import fs from 'node:fs';
import path from 'node:path';
import { checkRefs, jobEnv, shell, shellAsync, vars, type ShellResult } from './job-command.ts';
import { loginShell } from '../guard/command-env.ts';
import { knownValues, redactKnown } from '../guard/known-secrets.ts';
import { loadJob, logEvent, renewLease, jobDir } from '#core/job/store.ts';
import { jobComponent } from '#core/config/components.ts';
import { applySinks } from '../environment/config-sinks-apply.ts';
import type { SinkSummary } from '../environment/config-sinks-apply.ts';
import { commandPort, endpointPlaceholders, jobEndpoints } from '../environment/endpoints.ts';
import { applyLinks, pathPrelude, restoreLockfiles, snapshotLockfiles } from '../project/links.ts';
import type { AppliedLinks, LockSnapshot } from '../project/links.ts';
import { memberRepos, memberWorktree } from '../project/job-repos.ts';
import { checkKey, findPass, recordPass, treeState } from '../verify/cache.ts';
import type { CacheMiss, CheckKey } from '../verify/cache.ts';
import type { ComponentConfig, Config, Job, JobRepo } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { assertSafeRef, fill, shellArgs, tail } from '#core/text.ts';

/** What `forge run` returns: runCommand. */
export interface CommandResult {
  name: string;
  cmd: string;
  ok: boolean;
  exit: number | null;
  durationMs: number;
  log: string;
  tail: string;
  /** The active local links applied, `<ecosystem>:<name>`; only when there are some. */
  links?: string[];
  /** Lockfiles written back after the command; only when non-empty. */
  restored?: string[];
  /** The component's config sinks rendered before the command: names, relative paths and a count, never values. */
  config?: SinkSummary;
  /** Reused from the check cache (lib/engine/verify/cache.ts): the command did not run, and `log` is the original run's. */
  cached?: true;
  /** When the reused pass ran, and how long it took. */
  cachedAt?: string;
  cachedDurationMs?: number;
  /** Under `checks: 'reuse'`, why the command ran instead of reusing a pass. */
  cacheMiss?: CacheMiss;
}

/**
 * Fills a command template. Arguments are opt-in: only a template that says `{args}` takes them,
 * so a configured command touching outside systems can't be steered with flags a session picks.
 * They are quoted one by one (shellArgs), and fill() makes a single pass, so an argument's text is
 * never filled again. A template whose `{args}` the shell would not read as plain words is refused:
 * one not standing as its own word (`\{args}`, `x{args}`), one inside quotes (`" {args} "`, where
 * `$(…)` expands), and any template with a heredoc or a quoting form where `\'` doesn't close the quote.
 */
function fillCommand(name: string, template: string, v: Record<string, string | number>, args: string[]): string {
  if (!args.length) return fill(template, v);
  if (!template.includes('{args}')) throw new ForgeError(`forge run: commands.${name} takes no arguments; put {args} in the template where they go`);
  if (/<<|\$'|\\'/.test(template))
    throw new ForgeError(`forge run: commands.${name} has a heredoc (<<) or a $'…' or \\' quote, where the arguments would not stay literal; take it out of the template to pass arguments`);
  if (!placeholdersArePlainWords(template))
    throw new ForgeError(`forge run: commands.${name} puts {args} inside quotes or another word, where the arguments would not stay literal; write {args} unquoted, as its own word`);
  return fill(template, { ...v, args: shellArgs(args) });
}

/**
 * Whether every `{args}` stands as a whole unquoted word: after the start, a blank, a newline or
 * `(`, before the end, a blank, a newline or `;` `&` `|` `)`, and outside '…' and "…". The quote
 * scan is kept beside the whole-word rule because a placeholder with blanks on both sides can still
 * sit inside "…" (`echo " {args} "`); a backslash escapes the next character outside single quotes.
 */
function placeholdersArePlainWords(template: string): boolean {
  for (const m of template.matchAll(/\{args\}/g)) {
    const before = m.index === 0 ? '' : template[m.index - 1];
    const after = template[m.index + m[0].length] ?? '';
    if (!/^[ \t\n(]?$/.test(before) || !/^[ \t\n;&|)]?$/.test(after)) return false;
  }
  // Every `{args}` is now preceded by a blank, `(` or the start, never a backslash, so the escape
  // skip below can't step over one.
  let quote: string | null = null;
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (quote !== null && template.startsWith('{args}', i)) return false;
    if (c === '\\' && quote !== "'") i++;
    else if (quote === null && (c === "'" || c === '"')) quote = c;
    else if (quote !== null && c === quote) quote = null;
  }
  return true;
}

/**
 * A job touching exactly one root-repo component uses that component's command, else the top-level one.
 */
export function commandTemplate(config: Config, job: Job, name: string): string | null {
  return jobComponent(config, job)?.commands?.[name] ?? config.commands[name] ?? null;
}

/** `forge run`'s options. `args` only ever comes from `forge run <job> <name> -- <args>`. */
export interface RunOptions {
  tail?: number;
  label?: string;
  args?: string[];
  /** A member repo: run its component's command in its worktree (`forge run … --repo`). */
  repo?: string;
  /** false: the caller (verify) snapshots and restores lockfiles itself, once per group. */
  lockGuard?: false;
  /**
   * The check cache (lib/engine/verify/cache.ts), root worktree only: `record` keeps a pass on a clean
   * committed tree (`forge run`), `reuse` also returns a matching pass instead of running (verify's steps).
   */
  checks?: 'record' | 'reuse';
}

/** A command ready to run: the filled line, where it runs, and its environment. */
interface PreparedCommand {
  cmd: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Set for a member repo's command. */
  repo?: string;
  /** Run before `cmd`, after the login profile when `commandEnv.loginShell` sources one: the PATH line that puts the link shims first. */
  prelude: string;
  links: AppliedLinks | null;
  /** The component's config sinks rendered for this command, when it has any. */
  config?: SinkSummary;
  /** Known values to redact from the log and tail: this render's secrets and the job's recorded ones. */
  redact: string[];
  /** The worktree the command runs in (the job's or the member's), whose tree the check cache keys on. */
  worktree: string;
  /** The job has member repos, so the check cache neither records nor reuses. */
  members: boolean;
}

/** The env and PATH prelude of a consumer repo's links, rendered fresh for this command. */
function withLinks(root: string, config: Config, job: Job, repo: string | null, env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; prelude: string; links: AppliedLinks | null } {
  const links = applyLinks(root, config, job, repo);
  if (!links) return { env, prelude: '', links };
  return { env: { ...env, ...links.env }, prelude: links.binDir ? pathPrelude(links.binDir) : '', links };
}

/** Everything before the command starts, shared by the sync and async runners so both log alike. */
function prepareCommand(root: string, config: Config, id: string, name: string, opts: RunOptions): PreparedCommand {
  if (opts.repo !== undefined) return prepareMemberCommand(root, config, id, name, opts.repo, opts);
  const job = loadJob(root, id);
  const component = jobComponent(config, job);
  const template = commandTemplate(config, job, name);
  if (!template) throw new ForgeError(`no "${name}" command configured (commands.${name} in .forge/config.yml)`);
  if (!job.worktree) throw new ForgeError(`job ${id} has no worktree yet; run: forge worktree create ${id}`);
  const cwd = component?.path ? path.join(job.worktree, component.path) : job.worktree;
  const port = commandPort(config, job, component);
  // Before renewLease: refused arguments leave no trace, not even a renewal.
  const v = vars(root, config, job, job.worktree, port, template);
  const cmd = fillCommand(name, template, v, opts.args ?? []);
  // After the arguments and before the renewal: a refused sink leaves no trace either.
  const applied = component ? applySinks(root, config, job, component, { env: jobEnv(root, config, job, job.worktree, port), fillCmd: (t) => fill(t, v) }) : null;
  // Agents run commands all through a build; each one renews a live lease (never a dead one).
  renewLease(root, id);
  if (applied) logEvent(root, id, 'config-sinks', applied.summary);
  // Sink env sits over the inherited environment and under the links' (names are disjoint by validation).
  const env = { ...jobEnv(root, config, job, job.worktree, port), ...applied?.env };
  const redact = [...new Set([...(applied?.values ?? []), ...knownValues(root, id, config)])];
  return { cmd, cwd, ...withLinks(root, config, job, null, env), ...(applied ? { config: applied.summary } : {}), redact, worktree: job.worktree, members: memberRepos(job).length > 0 };
}

/**
 * A member repo's command: the `name` command of the one component whose `repo` is the member, run in
 * `<member worktree>/<component.path>`. Members have no top-level commands to fall back on.
 */
function prepareMemberCommand(root: string, config: Config, id: string, name: string, repo: string, opts: RunOptions): PreparedCommand {
  const job = loadJob(root, id);
  const { member, worktree } = memberWorktree(root, config, job, repo);
  const component = memberComponent(config, repo, name);
  if (!component) throw new ForgeError(`no component of repo ${repo} defines a "${name}" command (components[].commands.${name} with repo: ${repo})`);
  const port = commandPort(config, job, component);
  const cmd = fillCommand(name, component.commands![name]!, memberVars(root, config, job, member, worktree, port), opts.args ?? []);
  renewLease(root, id);
  return { cmd, cwd: path.join(worktree, component.path), ...withLinks(root, config, job, repo, jobEnv(root, config, job, worktree, port)), repo, redact: knownValues(root, id, config), worktree, members: true };
}

/** The one component of member `repo` that defines `name`, null when none does; several is refused. */
export function memberComponent(config: Config, repo: string, name: string): ComponentConfig | null {
  const found = (config.components ?? []).filter((c) => c?.repo === repo && typeof c.commands?.[name] === 'string' && c.commands[name]);
  if (found.length > 1) throw new ForgeError(`several components of repo ${repo} define "${name}" (${found.map((c) => c.name).join(', ')}); give it to one`);
  return found[0] ?? null;
}

// A member's `{worktree}` is the checked member path (memberWorktree), its `{base}` the member's base,
// `{branch}` empty for a verify-only member, which has none, and `{port}` its component's (commandPort).
function memberVars(root: string, config: Config, job: Job, member: JobRepo, worktree: string, port: number | null): Record<string, string | number> {
  checkRefs(job);
  const base = assertSafeRef(member.base, `repos ${member.repo} base`);
  return { ...endpointPlaceholders(jobEndpoints(root, config, job), { shell: true }), job: job.id, port: port ?? '', worktree, root, branch: member.verifyOnly ? '' : job.branch!, base, args: '' };
}

/** The check cache's view of one run: the key and clean tree it was taken on, and under `reuse`, a hit or why it missed. */
interface CacheLookup {
  key?: CheckKey;
  /** Set only when the worktree was clean before the run, so only then can a pass be recorded. */
  tree?: string;
  hit?: CommandResult;
  miss?: CacheMiss;
}

/**
 * Before the command runs, shared by both runners: only a root command of a job without member repos
 * is keyed, on a clean committed tree. A hit logs its `command` event with the reused pass's time and
 * `durationMs: 0`, so the speed metrics never count a busy span that didn't happen.
 */
function lookupChecks(root: string, config: Config, id: string, name: string, p: PreparedCommand, opts: RunOptions): CacheLookup {
  if (!opts.checks) return {};
  const reuse = opts.checks === 'reuse';
  if (opts.repo !== undefined || p.members) return reuse ? { miss: 'unsupported' } : {};
  const state = treeState(p.worktree, config);
  if (!('tree' in state)) return reuse ? { miss: 'dirty' } : {};
  const key = checkKey({ name, args: opts.args ?? [], cmd: p.cmd, prelude: p.prelude, cwd: p.cwd, login: loginShell(config), env: p.env, redact: p.redact, config });
  if (!reuse) return { key, tree: state.tree };
  const found = findPass(root, id, key, state.tree);
  if ('miss' in found) return { key, tree: state.tree, miss: found.miss };
  const { at, durationMs, log } = found.pass;
  logEvent(root, id, 'command', { name, ok: true, exit: 0, durationMs: 0, cached: true, cachedAt: at, cachedDurationMs: durationMs });
  return { hit: { name, cmd: p.cmd, ok: true, exit: 0, durationMs: 0, log, tail: '', cached: true, cachedAt: at, cachedDurationMs: durationMs } };
}

/**
 * After a pass: recorded only when the tree it started on is still the committed tree and the worktree
 * is still clean, so a command that commits, edits or hides a change while it runs records nothing.
 * A refused write (a linked `checks/` directory) never costs the run its result.
 */
function recordChecks(root: string, config: Config, id: string, p: PreparedCommand, c: CacheLookup, result: CommandResult): void {
  if (!result.ok || !c.key || !c.tree) return;
  const after = treeState(p.worktree, config);
  if (!('tree' in after) || after.tree !== c.tree) return;
  try {
    recordPass(root, id, c.key, c.tree, result);
  } catch {
    // Not recorded is only a later miss.
  }
}

/** Everything after: the log file, the `command` event and the result with its tail. */
function recordCommand(root: string, id: string, name: string, p: PreparedCommand, res: ShellResult, started: number, opts: RunOptions, restored: string[], c: CacheLookup): CommandResult {
  const logDir = path.join(jobDir(root, id), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${opts.label ?? (p.repo ? `${p.repo}-${name}` : name)}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const linksLine = p.links?.binDir ? `(links ${p.links.binDir})\n` : '';
  // The command saw the secrets; what Forge keeps of its output never holds one verbatim.
  const output = redactKnown(res.output, p.redact);
  fs.writeFileSync(logFile, `$ ${p.cmd}\n(cwd ${p.cwd})\n${linksLine}\n${output}\n\n[exit ${res.status}]\n`);
  const result: CommandResult = { name, cmd: p.cmd, ok: res.ok, exit: res.status, durationMs: Date.now() - started, log: path.relative(jobDir(root, id), logFile), tail: tail(output, opts.tail ?? 40) };
  if (p.links?.labels.length) result.links = p.links.labels;
  if (restored.length) result.restored = restored;
  if (p.config) result.config = p.config;
  if (c.miss) result.cacheMiss = c.miss;
  logEvent(root, id, 'command', { name, ...(p.repo ? { repo: p.repo } : {}), ok: res.ok, exit: res.status, durationMs: result.durationMs, ...(c.miss ? { cacheMiss: c.miss } : {}) });
  return result;
}

/**
 * Runs a configured command inside the job's worktree. Full output goes to a log file and only
 * a tail comes back, so agents spend context on failures rather than on passing build noise.
 */
export function runCommand(root: string, config: Config, id: string, name: string, opts: RunOptions = {}): CommandResult {
  const p = prepareCommand(root, config, id, name, opts);
  const c = lookupChecks(root, config, id, name, p, opts);
  if (c.hit) return c.hit;
  const snap = opts.lockGuard === false ? null : lockSnapshot(p);
  const started = Date.now();
  let res: ShellResult;
  let restored: string[] = [];
  try {
    res = shell(p.prelude + p.cmd, p.cwd, p.env, { login: loginShell(config) });
  } finally {
    restored = restoreLocks(root, id, p.repo ?? null, snap);
  }
  const result = recordCommand(root, id, name, p, res, started, opts, restored, c);
  recordChecks(root, config, id, p, c, result);
  return result;
}

/** The consumer's tracked lockfiles before a command with active cargo or npm links, else null. */
function lockSnapshot(p: PreparedCommand): LockSnapshot | null {
  return p.links?.worktree && p.links.lockfiles.length ? snapshotLockfiles(p.links.worktree, p.links.lockfiles) : null;
}

/** Writes back what a linked build rewrote (a `[patch]` rewrites Cargo.lock) and logs it; returns the paths. */
export function restoreLocks(root: string, id: string, repo: string | null, snap: LockSnapshot | null): string[] {
  if (!snap) return [];
  const paths = restoreLockfiles(snap);
  if (paths.length) logEvent(root, id, 'link-lockfiles-restored', { repo, paths });
  return paths;
}

/** runCommand without blocking the event loop, so verify can run a group's steps side by side. */
export async function runCommandAsync(root: string, config: Config, id: string, name: string, opts: RunOptions = {}): Promise<CommandResult> {
  const p = prepareCommand(root, config, id, name, opts);
  const c = lookupChecks(root, config, id, name, p, opts);
  if (c.hit) return c.hit;
  const snap = opts.lockGuard === false ? null : lockSnapshot(p);
  const started = Date.now();
  let res: ShellResult;
  let restored: string[] = [];
  try {
    res = await shellAsync(p.prelude + p.cmd, p.cwd, p.env, { login: loginShell(config) });
  } finally {
    restored = restoreLocks(root, id, p.repo ?? null, snap);
  }
  const result = recordCommand(root, id, name, p, res, started, opts, restored, c);
  recordChecks(root, config, id, p, c, result);
  return result;
}
