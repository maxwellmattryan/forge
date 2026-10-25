// Configured commands: fill a command's template and run it in the job's or a member's worktree,
// synchronously for `forge run` and without blocking for verify, logging each run alike.
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
import { memberWorktree } from '../project/job-repos.ts';
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
  return { cmd, cwd, ...withLinks(root, config, job, null, env), ...(applied ? { config: applied.summary } : {}), redact };
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
  return { cmd, cwd: path.join(worktree, component.path), ...withLinks(root, config, job, repo, jobEnv(root, config, job, worktree, port)), repo, redact: knownValues(root, id, config) };
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

/** Everything after: the log file, the `command` event and the result with its tail. */
function recordCommand(root: string, id: string, name: string, p: PreparedCommand, res: ShellResult, started: number, opts: RunOptions, restored: string[] = []): CommandResult {
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
  logEvent(root, id, 'command', { name, ...(p.repo ? { repo: p.repo } : {}), ok: res.ok, exit: res.status, durationMs: result.durationMs });
  return result;
}

/**
 * Runs a configured command inside the job's worktree. Full output goes to a log file and only
 * a tail comes back, so agents spend context on failures rather than on passing build noise.
 */
export function runCommand(root: string, config: Config, id: string, name: string, opts: RunOptions = {}): CommandResult {
  const p = prepareCommand(root, config, id, name, opts);
  const snap = opts.lockGuard === false ? null : lockSnapshot(p);
  const started = Date.now();
  let res: ShellResult;
  let restored: string[] = [];
  try {
    res = shell(p.prelude + p.cmd, p.cwd, p.env, { login: loginShell(config) });
  } finally {
    restored = restoreLocks(root, id, p.repo ?? null, snap);
  }
  return recordCommand(root, id, name, p, res, started, opts, restored);
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
  const snap = opts.lockGuard === false ? null : lockSnapshot(p);
  const started = Date.now();
  let res: ShellResult;
  let restored: string[] = [];
  try {
    res = await shellAsync(p.prelude + p.cmd, p.cwd, p.env, { login: loginShell(config) });
  } finally {
    restored = restoreLocks(root, id, p.repo ?? null, snap);
  }
  return recordCommand(root, id, name, p, res, started, opts, restored);
}
