import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { enforceBudget } from './budget.ts';
import { isOwnWorktreePath, loadConfig, verifyGroups, worktreeRoot } from './config.ts';
import { e2ePlan } from './e2e.ts';
import { configForJob } from './eval-overlay.ts';
import { stackSource } from './deps.ts';
import { STATUS_ARGV, blockingLines, compactIntegrity, hiddenChanges, integrityError, renderIntegrity, testIntegrity } from './integrity.ts';
import type { CompactIntegrity, IntegrityReport } from './integrity.ts';
import { listJobs, isActive, loadJob, logEvent, setJob, touchJob, updateJob, jobDir } from './jobs.ts';
import { exists, resolveFrom } from './paths.ts';
import { posixShell } from './platform.ts';
import { CONFIG_SCHEMA_VERSION } from './schema.ts';
import { checkBranch, compactProtected, renderProtected } from './protected.ts';
import type { BranchCheck, CompactProtected } from './protected.ts';
import { logSecrets, renderSecrets, scanBranch, secretMode, secretsOk, secretsTail, compactSecrets } from './secrets.ts';
import { jobComponent } from './components.ts';
import { memberClone, memberEntry, memberRepos, memberWorktree, memberWorktreePath, trustedMemberWorktree } from './job-repos.ts';
import type { ComponentConfig, CompactSecrets, Config, Job, JobRepo, SecretScan, VerifyRun, VerifyRunRepo } from './types.ts';
import { ForgeError, assertSafeRef, fill, now, readJson, run, shellArgs, tail, withLock, writeJsonAtomic } from './util.ts';

/** One member repo's part of `forge worktree create`: createMemberWorktrees. */
export interface MemberWorktreeResult {
  repo: string;
  path: string | null;
  created: boolean;
  ok: boolean;
  error?: string;
}

/** What `forge worktree create` returns: createWorktree. `repos` (members only) when the job has members. */
export type CreateWorktreeResult =
  | { path: string; created: false; ok?: boolean; repos?: MemberWorktreeResult[] }
  | { path: string; created: true; port: number; stackedOn?: string; base?: string; setup: { cmd: string; ok: boolean; tail: string }[]; ok: boolean; repos?: MemberWorktreeResult[] };

/** What `forge run` returns: runCommand. */
export interface CommandResult {
  name: string;
  cmd: string;
  ok: boolean;
  exit: number | null;
  durationMs: number;
  log: string;
  tail: string;
}

/** One verify step: a command's result, a skipped step, or a gate verify adds itself (worktree-clean, secrets, protected, integrity). */
export interface VerifyStep {
  name: string;
  ok: boolean;
  exit?: number | null;
  tail?: string;
  skipped?: boolean;
  reason?: string;
  cmd?: string;
  log?: string;
  durationMs?: number;
}

/** What `forge verify` returns: verify. */
export interface VerifyResult {
  ok: boolean;
  round: number;
  attempt: number;
  sha: string;
  file: string;
  steps: Omit<VerifyStep, 'tail'>[];
  failure: VerifyStep | undefined;
  integrity: CompactIntegrity | null;
  secrets: CompactSecrets;
  protected: CompactProtected;
  /** One record per member repo, only when the job has members. */
  repos?: VerifyRunRepo[];
  budget?: NonNullable<ReturnType<typeof enforceBudget>>;
}

function branchState(root: string, branch: string, remote: string): { local: boolean; remote: boolean } {
  const local = run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root, allowFail: true }).ok;
  const remoteRef = run('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`], { cwd: root, allowFail: true }).ok;
  return { local, remote: remoteRef };
}

export function createWorktree(
  root: string,
  config: Config,
  id: string,
  opts: { from?: string; sparseExclude?: string[]; isolate?: boolean } = {},
): CreateWorktreeResult {
  const res = createRootWorktree(root, config, id, opts);
  const members = memberRepos(loadJob(root, id));
  if (!members.length) return res;
  const repos = createMemberWorktrees(root, config, id);
  return { ...res, ok: res.ok !== false && repos.every((r) => r.ok), repos };
}

function createRootWorktree(root: string, config: Config, id: string, opts: { from?: string; sparseExclude?: string[]; isolate?: boolean }): CreateWorktreeResult {
  const job = loadJob(root, id);
  // Before git sees them (a leading - is an option) and before anything is created.
  checkRefs(job);
  const wtRoot = worktreeRoot(root, config);
  const dir = path.join(wtRoot, id);
  if (job.worktree && exists(job.worktree)) return { path: job.worktree, created: false };
  const remote = config.git.remote;
  run('git', ['fetch', remote, '--prune'], { cwd: root, allowFail: true });
  // createJob always sets branch and base; the `!`s below rely on it.
  const st = opts.isolate ? null : branchState(root, job.branch!, remote);
  // A new branch stacks on the one dependency that has not merged yet. Checked before anything
  // is created, so a refusal leaves no worktree and no job changes behind.
  const stack = st && !st.local && !st.remote && !opts.from ? stackSource(root, config, job) : null;
  fs.mkdirSync(wtRoot, { recursive: true });
  const defaultStart = () => opts.from ?? (run('git', ['rev-parse', '--verify', '--quiet', `${remote}/${job.base}`], { cwd: root, allowFail: true }).ok ? `${remote}/${job.base}` : job.base!);
  if (opts.isolate || !st) {
    cloneIsolated(root, defaultStart(), dir, job.branch!, job.base!, opts.sparseExclude ?? []);
  } else {
    addWorktree(root, dir, job, remote, st, opts.sparseExclude ?? [], stack ? () => stack.start : defaultStart);
  }
  // job.base is what PRs target, integrate merges from and reviewers diff against.
  const stacked = stack ? { stackedOn: stack.dependency, base: stack.base } : {};
  if (stack) {
    job.base = stack.base;
    setJob(root, id, { fields: { base: stack.base } });
    logEvent(root, id, 'stacked', { dependency: stack.dependency, base: stack.base });
  }
  copyUntracked(root, dir, config.worktrees.copy ?? [], opts.sparseExclude ?? []);
  if (config.worktrees.cargo?.sharedTarget) writeSharedCargoTarget(root, config, wtRoot);
  const port = allocatePort(root, config, id);
  setJob(root, id, { fields: { worktree: dir, port } });
  logEvent(root, id, 'worktree', { path: dir, port });
  const setupLog: { cmd: string; ok: boolean; tail: string }[] = [];
  for (const cmd of config.worktrees.setup ?? []) {
    const res = shell(fill(cmd, vars(root, config, job, dir, port, cmd)), dir, envFor(job, dir, port));
    setupLog.push({ cmd, ok: res.ok, tail: tail(res.output, 15) });
    if (!res.ok) {
      logEvent(root, id, 'worktree-setup-failed', { cmd });
      return { path: dir, created: true, port, ...stacked, setup: setupLog, ok: false };
    }
  }
  return { path: dir, created: true, port, ...stacked, setup: setupLog, ok: true };
}

/**
 * Each member worktree that is missing, in `repos` order: on the job's branch (the existing local
 * branch, else tracking `<remote>/<branch>`, else new from `<remote>/<base>`), or detached at the base
 * for a verify-only member. Members get no copy, setup, port or shared Cargo target. One member's
 * failure is reported and the rest still run; a rerun creates only what is missing.
 */
function createMemberWorktrees(root: string, config: Config, id: string): MemberWorktreeResult[] {
  const job = loadJob(root, id);
  const remote = config.git.remote;
  const out: MemberWorktreeResult[] = [];
  for (const m of memberRepos(job)) {
    try {
      const clone = memberClone(root, config, m.repo);
      const dir = memberWorktreePath(root, config, m.repo, id, clone);
      if (m.worktree === dir && exists(dir)) {
        out.push({ repo: m.repo, path: dir, created: false, ok: true });
        continue;
      }
      checkRefs(job);
      const base = assertSafeRef(m.base, `repos ${m.repo} base`);
      if (exists(dir)) throw new ForgeError(`${dir} already exists; remove it or run: forge worktree remove ${id} --repo ${m.repo}`);
      run('git', ['fetch', remote, '--prune'], { cwd: clone, allowFail: true });
      // A worktree deleted by hand stays registered and would keep its branch "checked out".
      run('git', ['worktree', 'prune'], { cwd: clone, allowFail: true });
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      const start = () => (run('git', ['rev-parse', '--verify', '--quiet', `${remote}/${base}`], { cwd: clone, allowFail: true }).ok ? `${remote}/${base}` : base);
      if (m.verifyOnly) run('git', ['worktree', 'add', '--detach', dir, start()], { cwd: clone });
      else addWorktree(clone, dir, job, remote, branchState(clone, job.branch!, remote), [], start);
      updateJob(root, id, (j) => {
        const e = memberEntry(j, m.repo);
        if (e) e.worktree = dir;
      });
      logEvent(root, id, 'repo-worktree', { repo: m.repo, path: dir, verifyOnly: m.verifyOnly });
      out.push({ repo: m.repo, path: dir, created: true, ok: true });
    } catch (e) {
      out.push({ repo: m.repo, path: null, created: false, ok: false, error: `repo ${m.repo}: ${(e as Error).message}` });
    }
  }
  return out;
}

function addWorktree(
  root: string,
  dir: string,
  job: Job,
  remote: string,
  st: { local: boolean; remote: boolean },
  sparseExclude: string[],
  start: () => string,
): void {
  const checkoutArgs = sparseExclude.length ? ['--no-checkout'] : [];
  // createJob always sets branch.
  if (st.local) {
    run('git', ['worktree', 'add', ...checkoutArgs, dir, job.branch!], { cwd: root });
  } else if (st.remote) {
    run('git', ['worktree', 'add', ...checkoutArgs, '--track', '-b', job.branch!, dir, `${remote}/${job.branch}`], { cwd: root });
  } else {
    run('git', ['worktree', 'add', ...checkoutArgs, '--no-track', '-b', job.branch!, dir, start()], { cwd: root });
  }
  if (sparseExclude.length) {
    sparseCheckout(dir, sparseExclude);
    run('git', ['checkout'], { cwd: dir });
  }
}

function sparseCheckout(dir: string, exclude: string[], env?: NodeJS.ProcessEnv): void {
  run('git', ['sparse-checkout', 'set', '--no-cone', '/*', ...exclude.map((p) => `!/${p.replace(/^\/+/, '')}`)], { cwd: dir, env });
}

/**
 * A git worktree shares the main checkout's object store and refs, so an eval builder could
 * read the real fix with `git log --all`. A standalone shallow clone holds only the base commit.
 * The base branch name points at it too, so `git diff <base>...HEAD` keeps working for reviewers.
 */
function cloneIsolated(root: string, start: string, dir: string, branch: string, base: string, sparseExclude: string[]): void {
  const resolved = run('git', ['rev-parse', '--verify', '--quiet', `${start}^{commit}`], { cwd: root, allowFail: true });
  if (!resolved.ok) throw new ForgeError(`eval base ${start} not found in the main checkout`);
  const sha = resolved.stdout.trim();
  // An inherited GIT_DIR (e.g. Forge run from a git hook) would point these commands at another repository.
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  const git = (args: string[], cwd = dir) => run('git', args, { cwd, env });
  // Never reuse a leftover directory: cleanup on failure would delete whatever was in it.
  if (exists(dir)) throw new ForgeError(`${dir} already exists; remove it before starting the eval`);
  try {
    git(['init', '-q', dir], root);
    // Commits made in the clone need an identity; the main checkout's local config does not carry over.
    for (const key of ['user.name', 'user.email']) {
      const v = run('git', ['config', '--get', key], { cwd: root, allowFail: true }).stdout.trim();
      if (v) git(['config', key, v]);
    }
    git(['fetch', '-q', '--depth', '1', '--no-tags', root, sha]);
    git(['update-ref', `refs/heads/${base}`, sha]);
    if (branch !== base) git(['update-ref', `refs/heads/${branch}`, sha]);
    git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    if (sparseExclude.length) sparseCheckout(dir, sparseExclude, env);
    git(['reset', '-q', '--hard']);
    // FETCH_HEAD records the main checkout's path.
    fs.rmSync(path.join(dir, '.git', 'FETCH_HEAD'), { force: true });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/**
 * Worktrees only contain tracked files; instructions like a gitignored CLAUDE.md or local .env
 * would otherwise be invisible to agents working there.
 * Paths excluded from a sparse checkout stay excluded: a broad entry like `.forge/**` must not
 * copy hidden eval checks back in.
 */
function copyUntracked(root: string, dir: string, entries: string[], exclude: string[] = []): void {
  const hidden = exclude.map((p) => p.replace(/^\/+|\/+$/g, ''));
  const isHidden = (rel: string) => {
    const r = path.normalize(rel).replace(/\\/g, '/');
    return hidden.some((h) => r === h || r.startsWith(`${h}/`) || h.startsWith(`${r}/`));
  };
  for (const entry of entries) {
    const matches = entry.includes('*') ? globFiles(root, entry) : [entry];
    for (const rel of matches) {
      if (isHidden(rel)) continue;
      const src = path.join(root, rel);
      const dst = path.join(dir, rel);
      if (!exists(src) || exists(dst)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
    }
  }
}

/**
 * Minimal glob: "**" crosses directories, "*" does not. Untracked-only lookups keep it fast
 * because git already knows which ignored files exist.
 */
function globFiles(root: string, pattern: string): string[] {
  const re = new RegExp(
    '^' +
      pattern
        .split('**/')
        .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
        .join('(?:.*/)?') +
      '$',
  );
  const listed = run('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], { cwd: root, allowFail: true }).stdout;
  const plain = run('git', ['ls-files', '--others', '--ignored', '--exclude-standard'], { cwd: root, allowFail: true }).stdout;
  const all = new Set([...listed.split('\n'), ...plain.split('\n')].map((s) => s.replace(/\/$/, '')).filter(Boolean));
  return [...all].filter((f) => re.test(f) && !/(^|\/)(node_modules|target|\.git)(\/|$)/.test(f));
}

/**
 * Cargo discovers config by walking up from the working directory, so one file above all
 * worktrees points every job at a single target dir: dependencies compile once, not per job.
 */
function writeSharedCargoTarget(root: string, config: Config, wtRoot: string): void {
  const td = config.worktrees.cargo.targetDir;
  const target = td === 'main' ? path.join(root, 'target') : td ? resolveFrom(root, td) : path.join(wtRoot, '.cargo-target');
  const cfgDir = path.join(wtRoot, '.cargo');
  const file = path.join(cfgDir, 'config.toml');
  const body = `# Written by Forge: shares one build directory across job worktrees.\n[build]\ntarget-dir = ${JSON.stringify(target)}\n`;
  fs.mkdirSync(cfgDir, { recursive: true });
  if (!exists(file) || fs.readFileSync(file, 'utf8') !== body) fs.writeFileSync(file, body);
}

function allocatePort(root: string, config: Config, id: string): number {
  const taken = new Set(listJobs(root).filter((j) => isActive(j) && j.id !== id && j.port).map((j) => j.port));
  for (let p = config.ports.base; p < config.ports.base + config.ports.span; p++) if (!taken.has(p)) return p;
  throw new ForgeError(`no free port in ${config.ports.base}-${config.ports.base + config.ports.span - 1}`);
}

// Placeholders fill a shell command, and job.json can be edited outside the CLI, so these are
// checked here at the sink rather than trusted from createJob.
function checkRefs(job: Job): void {
  assertSafeRef(job.id, 'job.id');
  assertSafeRef(job.branch, 'job.branch');
  assertSafeRef(job.base, 'job.base');
}

// `{worktree}` is filled unquoted, and job.json's `worktree` is agent-writable: it is trusted only
// when it is literally the path Forge computes for the job, whatever characters the repo path holds.
// Checked only for a template that uses it, so other commands run whatever the stored value is.
function assertOwnWorktree(root: string, config: Config, job: Job, dir: string, template: string): void {
  if (!template.includes('{worktree}') || isOwnWorktreePath(root, config, job.id, dir)) return;
  throw new ForgeError(`job.worktree ${JSON.stringify(dir).slice(0, 120)} is not this job's worktree: {worktree} is filled only with ${JSON.stringify(path.join(worktreeRoot(root, config), job.id)).slice(0, 120)}`);
}

// `{args}` is empty here: only `forge run … -- <args>` fills it (fillCommand), so verify, setup,
// background servers and regenerate never take arguments that could narrow what they run.
function vars(root: string, config: Config, job: Job, dir: string, port: number | null, template: string): Record<string, string | number> {
  checkRefs(job);
  assertOwnWorktree(root, config, job, dir, template);
  return { job: job.id, port: port ?? '', worktree: dir, root, branch: job.branch!, base: job.base!, args: '' };
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

// The daemon's trust check guards the session's own `forge` calls; a configured command that
// calls `forge` (a test suite on scratch repos) must behave as it does for a human.
const DAEMON_MARKER = /^FORGE_DAEMON(_|$)/;

/** A configured command's environment: `base` without the daemon markers (git pins kept), plus the job's variables. */
export function envFor(job: Job, dir: string, port: number | null, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of Object.keys(env)) if (DAEMON_MARKER.test(k)) delete env[k];
  return Object.assign(env, { FORGE_JOB: job.id, FORGE_WORKTREE: dir, PORT: port ? String(port) : '', FORGE_PORT: port ? String(port) : '' });
}

interface ShellResult {
  ok: boolean;
  status: number | null;
  output: string;
}

const joinOutput = (stdout: string, stderr: string): string => `${stdout}${stderr ? `\n${stderr}` : ''}`;

function shell(cmd: string, cwd: string, env: NodeJS.ProcessEnv): ShellResult {
  const res = run(posixShell(), ['-lc', cmd], { cwd, env, allowFail: true });
  return { ok: res.ok, status: res.status, output: joinOutput(res.stdout, res.stderr) };
}

/** run()'s spawnSync limit per stream, kept for the async path. */
const MAX_OUTPUT = 64 * 1024 * 1024;

/**
 * shell() without blocking, so verify can run a group's steps at once. Past MAX_OUTPUT on either
 * stream the child is killed and the step fails, as spawnSync's ENOBUFS does; a spawn error is a
 * failure with no exit code.
 */
function shellAsync(cmd: string, cwd: string, env: NodeJS.ProcessEnv): Promise<ShellResult> {
  // Outside the Promise, so a refused shell throws here as it does in shell().
  const sh = posixShell();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: ShellResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(sh, ['-lc', cmd], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ ok: false, status: null, output: joinOutput('', (e as Error).message) });
    }
    const chunks: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let overflow: string | null = null;
    for (const k of ['stdout', 'stderr'] as const) {
      child[k]!.on('data', (chunk: Buffer) => {
        if (overflow) return;
        sizes[k] += chunk.length;
        if (sizes[k] <= MAX_OUTPUT) return void chunks[k].push(chunk);
        overflow = `spawn ${sh} ENOBUFS: ${k} passed ${MAX_OUTPUT / 1024 / 1024} MiB, so the command was stopped`;
        chunks.stdout = [];
        chunks.stderr = [];
        child.kill('SIGTERM');
        // A grandchild holding the pipes open would otherwise delay close until it exits.
        child.stdout!.destroy();
        child.stderr!.destroy();
      });
    }
    child.on('error', (e) => finish({ ok: false, status: null, output: joinOutput('', e.message) }));
    child.on('close', (code) => {
      if (overflow) return finish({ ok: false, status: null, output: joinOutput('', overflow) });
      const stdout = Buffer.concat(chunks.stdout).toString('utf8');
      const stderr = Buffer.concat(chunks.stderr).toString('utf8');
      finish({ ok: code === 0, status: code, output: joinOutput(stdout, stderr) });
    });
  });
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
}

/** A command ready to run: the filled line, where it runs, and its environment. */
interface PreparedCommand {
  cmd: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Set for a member repo's command. */
  repo?: string;
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
  // Before touchJob: refused arguments leave no trace, not even a heartbeat.
  const cmd = fillCommand(name, template, vars(root, config, job, job.worktree, job.port, template), opts.args ?? []);
  // Agents run commands all through a build; each one proves the session is alive.
  touchJob(root, id);
  return { cmd, cwd, env: envFor(job, job.worktree, job.port) };
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
  const cmd = fillCommand(name, component.commands![name]!, memberVars(root, job, member, worktree), opts.args ?? []);
  touchJob(root, id);
  return { cmd, cwd: path.join(worktree, component.path), env: envFor(job, worktree, null), repo };
}

/** The one component of member `repo` that defines `name`, null when none does; several is refused. */
function memberComponent(config: Config, repo: string, name: string): ComponentConfig | null {
  const found = (config.components ?? []).filter((c) => c?.repo === repo && typeof c.commands?.[name] === 'string' && c.commands[name]);
  if (found.length > 1) throw new ForgeError(`several components of repo ${repo} define "${name}" (${found.map((c) => c.name).join(', ')}); give it to one`);
  return found[0] ?? null;
}

// A member's `{worktree}` is the checked member path (memberWorktree), its `{base}` the member's base,
// and `{branch}` empty for a verify-only member, which has none.
function memberVars(root: string, job: Job, member: JobRepo, worktree: string): Record<string, string | number> {
  checkRefs(job);
  const base = assertSafeRef(member.base, `repos ${member.repo} base`);
  return { job: job.id, port: '', worktree, root, branch: member.verifyOnly ? '' : job.branch!, base, args: '' };
}

/** Everything after: the log file, the `command` event and the result with its tail. */
function recordCommand(root: string, id: string, name: string, p: PreparedCommand, res: ShellResult, started: number, opts: RunOptions): CommandResult {
  const logDir = path.join(jobDir(root, id), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${opts.label ?? (p.repo ? `${p.repo}-${name}` : name)}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  fs.writeFileSync(logFile, `$ ${p.cmd}\n(cwd ${p.cwd})\n\n${res.output}\n\n[exit ${res.status}]\n`);
  const result = { name, cmd: p.cmd, ok: res.ok, exit: res.status, durationMs: Date.now() - started, log: path.relative(jobDir(root, id), logFile), tail: tail(res.output, opts.tail ?? 40) };
  logEvent(root, id, 'command', { name, ...(p.repo ? { repo: p.repo } : {}), ok: res.ok, exit: res.status, durationMs: result.durationMs });
  return result;
}

/**
 * Runs a configured command inside the job's worktree. Full output goes to a log file and only
 * a tail comes back, so agents spend context on failures rather than on passing build noise.
 */
export function runCommand(root: string, config: Config, id: string, name: string, opts: RunOptions = {}): CommandResult {
  const p = prepareCommand(root, config, id, name, opts);
  const started = Date.now();
  return recordCommand(root, id, name, p, shell(p.cmd, p.cwd, p.env), started, opts);
}

/** runCommand without blocking the event loop, so verify can run a group's steps side by side. */
export async function runCommandAsync(root: string, config: Config, id: string, name: string, opts: RunOptions = {}): Promise<CommandResult> {
  const p = prepareCommand(root, config, id, name, opts);
  const started = Date.now();
  const res = await shellAsync(p.cmd, p.cwd, p.env);
  return recordCommand(root, id, name, p, res, started, opts);
}

/**
 * The deterministic gate between build and review: cheap commands catch what would
 * otherwise cost a full round of reviewer agents. Every run is evidence bound to the commit
 * it checked: it records the HEAD sha and keeps earlier attempts instead of overwriting them.
 * Uncommitted changes fail the gate first, because reviewers and the PR only ever see commits.
 * The secret scan (lib/secrets.ts) runs next, always; under `verifySecrets: block` a finding stops
 * every configured step, though the integrity report is still computed. A `verify` entry that is a list runs its steps at the same time; the next entry waits for all of
 * them, and none runs after a group with a failure. Results stay in config order whatever finishes
 * first, so `failure` is the first failing step as configured, not the first to fail.
 */
export async function verify(root: string, base: Config, id: string): Promise<VerifyResult> {
  // Every refusal comes before the clean check, so a config this Forge can't read records nothing:
  // guessing at it could pass a gate whose steps never ran.
  if (base.schemaVersion > CONFIG_SCHEMA_VERSION)
    throw new ForgeError(`config schemaVersion ${base.schemaVersion} is newer than this Forge (${CONFIG_SCHEMA_VERSION}); update Forge before running verify`);
  const job = loadJob(root, id);
  // An eval job's overlay picks its steps, e2e and budget; an invalid one throws here.
  const config = configForJob(root, base, job);
  const groups = verifyGroups(config.verify);
  if (!job.worktree || !exists(job.worktree)) throw new ForgeError(`job ${id} has no worktree yet; run: forge worktree create ${id}`);
  // Every member's worktree is checked before anything runs, so a missing one records nothing.
  const members = memberRepos(job).map((m) => {
    const wt = memberWorktree(root, config, job, m.repo);
    return { ...wt, head: run('git', ['rev-parse', 'HEAD'], { cwd: wt.worktree }).stdout.trim() };
  });
  const sha = run('git', ['rev-parse', 'HEAD'], { cwd: job.worktree }).stdout.trim();
  const status = [...STATUS_ARGV];
  const changed = run('git', status, { cwd: job.worktree }).stdout.trim();
  let hiddenError: string | null = null;
  let hidden = '';
  if (!changed) {
    try {
      hidden = hiddenChanges(job.worktree, config).join('\n');
    } catch (e) {
      hiddenError = (e as Error).message;
    }
  }
  const dirty = changed || hidden;
  const results: VerifyStep[] = [];
  let integrity: IntegrityReport | null = null;
  if (dirty) results.push({ name: 'worktree-clean', ok: false, exit: null, tail: dirty });
  // Before any configured command, clean or not: a likely credential stops the round here, and the
  // staged changes are scanned too, so a key the builder has not committed yet is still reported.
  const mode = secretMode(config);
  const scanStarted = Date.now();
  // Bound to `sha`, the commit this run records as checked, not whatever HEAD is by the time the scan reads it.
  const secrets = scanBranch(root, config, job, { staged: true, head: sha });
  const secretsStep: VerifyStep = { name: 'secrets', ok: secretsOk(secrets, mode), exit: null, durationMs: Date.now() - scanStarted };
  const n = secrets.findings.length;
  if (!secretsStep.ok) secretsStep.tail = secretsTail(secrets);
  else if (secrets.error) secretsStep.reason = `scan incomplete (verifySecrets: warn): ${secrets.error}`;
  else if (n) secretsStep.reason = `${n} possible secret${n === 1 ? '' : 's'} (verifySecrets: warn)`;
  results.push(secretsStep);
  // Right after the secret scan, over the committed diff bound to `sha`: a path the policy refuses
  // stops every configured step, and one that can't be checked never reads as clean.
  const protStarted = Date.now();
  let prot: Pick<BranchCheck, 'refused' | 'escalated' | 'error'>;
  try {
    // Every repo the job pushes (not a verify-only one), over the HEAD this run records for it.
    const branches = members.filter((m) => !m.member.verifyOnly).map((m) => ({ repo: m.member.repo, worktree: m.worktree, base: m.member.base, head: m.head }));
    prot = checkBranch(root, config, job, sha, 'verify', branches);
  } catch (e) {
    prot = { refused: [], escalated: [], error: (e as Error).message };
  }
  const protectedStep: VerifyStep = { name: 'protected', ok: !prot.error && !prot.refused.length, exit: null, durationMs: Date.now() - protStarted };
  if (!protectedStep.ok) protectedStep.tail = prot.error ?? prot.refused.slice(0, 20).map((h) => `${h.path}: rule ${h.rule} (${h.glob}): ${h.reason}`).join('\n');
  else if (prot.escalated.length) protectedStep.reason = `${prot.escalated.length} protected paths need a human`;
  results.push(protectedStep);
  if (!dirty) {
    for (const group of secretsStep.ok && protectedStep.ok ? groups : []) {
      // A failing step never stops its siblings: each finishes and keeps its own log. One that
      // throws is reported only once the others have settled, so none writes after verify returns.
      const settled = await Promise.allSettled(
        group.map((step): Promise<VerifyStep> => (config.commands[step] ? runCommandAsync(root, config, id, step, { label: `verify-${step}` }) : Promise.resolve({ name: step, ok: true, skipped: true }))),
      );
      const thrown = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
      if (thrown) throw thrown.reason;
      const ran = settled.map((s) => (s as PromiseFulfilledResult<VerifyStep>).value);
      results.push(...ran);
      if (ran.some((r) => !r.ok)) break;
    }
    if (results.every((r) => r.ok)) {
      const plan = e2ePlan(config, job, commandTemplate(config, job, 'e2e'));
      if (plan?.run) results.push({ ...runCommand(root, config, id, 'e2e', { label: 'verify-e2e' }), reason: plan.reason });
      else if (plan) results.push({ name: 'e2e', ok: true, skipped: true, reason: plan.reason });
    }
    // Computed whatever the commands returned: a deleted test is evidence even when the build is red.
    integrity = testIntegrity(root, config, job);
    if (hiddenError) integrity = integrityError(integrity, `could not check the worktree for hidden changes: ${hiddenError}`);
    if (!integrity.ok) results.push({ name: 'integrity', ok: false, exit: null, tail: blockingLines(integrity) });
  }
  // A failure in the root never skips a member, nor one member another.
  const memberRuns: MemberVerify[] = [];
  for (const m of members) memberRuns.push(await verifyMember(root, config, job, groups, mode, m));
  const rootFailure = results.find((r) => !r.ok);
  const ok = results.every((r) => r.ok) && memberRuns.every((m) => m.rec.ok);
  const attempt = job.verifyRuns.filter((r) => r.round === job.round).length + 1;
  const lines = [`VERIFY: ${ok ? 'PASS' : 'FAIL'}`, '', `Round ${job.round} · attempt ${attempt} · ${sha.slice(0, 12)} · ${now()}`, ''];
  renderSteps(lines, results, secrets, mode, prot);
  if (integrity) lines.push(renderIntegrity(integrity));
  for (const m of memberRuns) {
    lines.push('', `# Repo ${m.rec.repo} · ${m.rec.sha.slice(0, 12)}`, '');
    renderSteps(lines, m.results, m.secrets, mode, null);
    if (m.integrity) lines.push(renderIntegrity(m.integrity));
  }
  const dir = path.join(jobDir(root, id), 'verify');
  fs.mkdirSync(dir, { recursive: true });
  const latest = path.join(dir, `round-${job.round}.md`);
  // round-<n>.md is the last report verify wrote; a verifiers failure appends a run with its own file.
  const previous = job.verifyRuns.filter((r) => r.round === job.round && r.failure !== 'verifiers').pop();
  if (previous && exists(latest)) fs.renameSync(latest, path.join(dir, `round-${job.round}-attempt-${previous.attempt}.md`));
  fs.writeFileSync(latest, lines.join('\n'));
  const memberFailure = memberRuns.find((m) => !m.rec.ok);
  const repos = memberRuns.length ? { repos: memberRuns.map((m) => m.rec) } : {};
  const rec: VerifyRun = { round: job.round, attempt, sha, ok, at: now(), file: path.relative(jobDir(root, id), latest), failure: rootFailure?.name ?? memberFailure?.rec.failure ?? null, ...repos };
  updateJob(root, id, (j) => {
    j.verify[job.round] = ok ? 'PASS' : 'FAIL';
    j.verifyRuns.push(rec);
    // Every failure, a dirty worktree included, asks for one retry; a pass does not reset it.
    if (!ok) j.verifyRetries[String(job.round)] = (j.verifyRetries[String(job.round)] ?? 0) + 1;
  });
  logEvent(root, id, 'verify', rec);
  logSecrets(root, id, 'verify', secrets, { blocked: mode === 'block', round: job.round });
  for (const m of memberRuns) logSecrets(root, id, 'verify', m.secrets, { blocked: mode === 'block', round: job.round });
  // enforceBudget applies the job's overlay itself.
  const budget = enforceBudget(root, base, id, 'verify');
  return {
    ok,
    round: job.round,
    attempt,
    sha,
    file: path.relative(root, latest),
    steps: results.map(({ tail: _t, ...r }) => r),
    failure: rootFailure ?? memberFailure?.results.find((r) => !r.ok),
    integrity: integrity ? compactIntegrity(integrity) : null,
    secrets: compactSecrets(secrets, mode),
    protected: compactProtected(prot),
    ...repos,
    ...(budget ? { budget } : {}),
  };
}


/** One member repo's verify: its record, its steps for the report, and its scan and integrity report. */
interface MemberVerify {
  rec: VerifyRunRepo;
  results: VerifyStep[];
  secrets: SecretScan;
  integrity: IntegrityReport | null;
}

/**
 * A member repo's checks, in the root's order: worktree-clean, the secret scan over its range, each
 * `verify` group step as the member component's command (skipped when none defines it), then test
 * integrity against the member's base. No e2e or verifiers step: those are root-only. Its protected
 * paths are checked in the root's `protected` step, named `<repo>:<path>`.
 */
async function verifyMember(root: string, config: Config, job: Job, groups: string[][], mode: ReturnType<typeof secretMode>, m: { member: JobRepo & { repo: string }; worktree: string; head: string }): Promise<MemberVerify> {
  const repo = m.member.repo;
  const cwd = m.worktree;
  // The view scanBranch and testIntegrity read: the member's worktree and base under the job's id.
  const view = { id: job.id, worktree: cwd, base: m.member.base };
  // The HEAD the root's protected check saw, so the run records the commit it checked.
  const sha = m.head;
  const changed = run('git', [...STATUS_ARGV], { cwd }).stdout.trim();
  let hiddenError: string | null = null;
  let hidden = '';
  if (!changed) {
    try {
      hidden = hiddenChanges(cwd, config).join('\n');
    } catch (e) {
      hiddenError = (e as Error).message;
    }
  }
  const dirty = changed || hidden;
  const results: VerifyStep[] = [];
  if (dirty) results.push({ name: 'worktree-clean', ok: false, exit: null, tail: dirty });
  const scanStarted = Date.now();
  const secrets = scanBranch(root, config, view, { staged: true, head: sha });
  const secretsStep: VerifyStep = { name: 'secrets', ok: secretsOk(secrets, mode), exit: null, durationMs: Date.now() - scanStarted };
  const n = secrets.findings.length;
  if (!secretsStep.ok) secretsStep.tail = secretsTail(secrets);
  else if (secrets.error) secretsStep.reason = `scan incomplete (verifySecrets: warn): ${secrets.error}`;
  else if (n) secretsStep.reason = `${n} possible secret${n === 1 ? '' : 's'} (verifySecrets: warn)`;
  results.push(secretsStep);
  let integrity: IntegrityReport | null = null;
  if (!dirty) {
    for (const group of secretsStep.ok ? groups : []) {
      const settled = await Promise.allSettled(
        group.map((step): Promise<VerifyStep> =>
          memberComponent(config, repo, step)
            ? runCommandAsync(root, config, job.id, step, { label: `verify-${repo}-${step}`, repo })
            : Promise.resolve({ name: step, ok: true, skipped: true, reason: `no ${step} command for repo ${repo}` }),
        ),
      );
      const thrown = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
      if (thrown) throw thrown.reason;
      const ran = settled.map((s) => (s as PromiseFulfilledResult<VerifyStep>).value);
      results.push(...ran);
      if (ran.some((r) => !r.ok)) break;
    }
    integrity = testIntegrity(root, config, view);
    if (hiddenError) integrity = integrityError(integrity, `could not check the worktree for hidden changes: ${hiddenError}`);
    if (!integrity.ok) results.push({ name: 'integrity', ok: false, exit: null, tail: blockingLines(integrity) });
  }
  const failed = results.find((r) => !r.ok);
  return { rec: { repo, sha, ok: !failed, failure: failed?.name ?? null }, results, secrets, integrity };
}

/** The `## <step>: …` sections of a verify report, the root's (with `prot`) and each member's alike. */
function renderSteps(lines: string[], results: VerifyStep[], secrets: SecretScan, mode: ReturnType<typeof secretMode>, prot: Pick<BranchCheck, 'refused' | 'escalated' | 'error'> | null): void {
  for (const r of results) {
    if (r.name === 'worktree-clean') {
      lines.push('## worktree-clean: FAILED (uncommitted or hidden changes)', '', 'Commit or discard these (or clear the index flags and filters) before verify can run:', '', '```', r.tail!, '```', ''); // the gate's tail lists the changes
      continue;
    }
    if (r.name === 'integrity') continue;
    if (r.name === 'secrets') {
      lines.push(renderSecrets(secrets, mode));
      continue;
    }
    if (r.name === 'protected' && prot) {
      lines.push(renderProtected(prot));
      continue;
    }
    lines.push(`## ${r.name}: ${r.skipped ? `skipped (${r.reason ?? 'no command configured'})` : r.ok ? 'ok' : `FAILED (exit ${r.exit})`}`);
    if ('cmd' in r) lines.push('', '`' + r.cmd + '` · log: `' + r.log + '`');
    if (r.reason && !r.skipped) lines.push('', `Trigger: ${r.reason}`);
    if ('tail' in r && !r.ok) lines.push('', '```', r.tail!, '```'); // 'tail' in r: the step has one
    lines.push('');
  }
}

/**
 * Whether the worktree's HEAD is the commit the latest verify run passed on. Anything that
 * publishes a branch should refuse when it is not: evidence for an older commit is not evidence.
 */
export function verifiedHead(root: string, id: string): { head: string; last: VerifyRun | null; verified: boolean; heads?: Record<string, string> } {
  const job = loadJob(root, id);
  if (!job.worktree || !exists(job.worktree)) throw new ForgeError(`job ${id} has no worktree`);
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: job.worktree }).stdout.trim();
  const last = job.verifyRuns[job.verifyRuns.length - 1] ?? null;
  const verified = Boolean(last && last.ok && last.sha === head);
  const members = memberRepos(job);
  if (!members.length) return { head, last, verified };
  // Every member HEAD must be the one the run checked; a member without its worktree is not verified.
  const config = loadConfig(root).config;
  const heads: Record<string, string> = {};
  let all = verified;
  for (const m of members) {
    const wt = trustedMemberWorktree(root, config, job, m.repo);
    if (!wt) {
      all = false;
      continue;
    }
    heads[m.repo] = run('git', ['rev-parse', 'HEAD'], { cwd: wt }).stdout.trim();
    const rec = last?.repos?.find((r) => r.repo === m.repo);
    if (!rec || rec.sha !== heads[m.repo]) all = false;
  }
  return { head, last, verified: all, heads };
}

/**
 * Long-running commands (dev servers) are detached and tracked by pid so a later session can stop them.
 * Idempotent per command: parallel reviewers share one job port, so a live recorded process is
 * returned instead of starting a second one that would collide on it. A live process whose port
 * does not answer yet is still reused (it may be booting); callers poll until `listening`.
 */
export async function startBackground(
  root: string,
  config: Config,
  id: string,
  name: string,
): Promise<{ pid: number | undefined; port: number | null; log: string; reused: boolean; listening: boolean | null }> {
  const job = loadJob(root, id);
  const template = config.commands[name];
  if (!template) throw new ForgeError(`no "${name}" command configured`);
  if (!job.worktree) throw new ForgeError(`job ${id} has no worktree yet`);
  touchJob(root, id);
  const dir = jobDir(root, id);
  const pidFile = path.join(dir, 'runtime.json');
  // The lock covers check, spawn and write, so two concurrent calls cannot both spawn.
  const rec = withLock(path.join(dir, '.runtime.lock'), () => {
    const rt = readJson(pidFile, {});
    const prev = rt[name];
    if (prev && pidAlive(prev.pid)) return { pid: prev.pid, log: path.resolve(dir, String(prev.log ?? `logs/${name}.log`)), reused: true };
    // Filled before the log is opened, so a refused value leaves nothing behind.
    // Checked above; the narrowing does not reach into this callback.
    const cmd = fill(template, vars(root, config, job, job.worktree!, job.port, template));
    const sh = posixShell();
    const logFile = path.join(dir, 'logs', `${name}.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, 'a');
    const child = spawn(sh, ['-lc', cmd], {
      cwd: job.worktree!,
      env: envFor(job, job.worktree!, job.port),
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    fs.closeSync(fd);
    rt[name] = { pid: child.pid, startedAt: now(), log: path.relative(dir, logFile), port: job.port };
    writeJsonAtomic(pidFile, rt);
    logEvent(root, id, 'background-start', { name, pid: child.pid, port: job.port });
    return { pid: child.pid, log: logFile, reused: false };
  });
  const listening = job.port ? await portAnswers(job.port) : null;
  return { pid: rec.pid, port: job.port, log: rec.log, reused: rec.reused, listening };
}

/**
 * The process group first (the shell's children keep it alive), then the pid. EPERM counts as
 * dead too: a process we may not signal is not ours, so the pid was reused.
 */
export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 0);
      return true;
    } catch {}
  }
  return false;
}

/** Whether something accepts TCP connections on the port, over IPv4 then IPv6. */
async function portAnswers(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', '::1']) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect({ port, host });
      const done = (v: boolean) => {
        clearTimeout(timer);
        sock.destroy();
        resolve(v);
      };
      const timer = setTimeout(() => done(false), 500);
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
    if (ok) return true;
  }
  return false;
}

export function stopBackground(root: string, id: string): string[] {
  const pidFile = path.join(jobDir(root, id), 'runtime.json');
  const rt = readJson(pidFile, {});
  const stopped: string[] = [];
  for (const [name, info] of Object.entries(rt)) {
    try {
      process.kill(-(info as any).pid, 'SIGTERM');
      stopped.push(name);
    } catch {
      try {
        process.kill((info as any).pid, 'SIGTERM');
        stopped.push(name);
      } catch {}
    }
  }
  writeJsonAtomic(pidFile, {});
  if (stopped.length) logEvent(root, id, 'background-stop', { names: stopped });
  return stopped;
}

/**
 * Removes the job's worktrees: the root's and then every member's, or with `repo` only that member's.
 * `removed` stays the root's path; `repos` lists the members handled, only when there are any.
 */
export function removeWorktree(
  root: string,
  id: string,
  opts: { deleteBranch?: boolean; force?: boolean; repo?: string } = {},
): { removed: string | null; repos?: { repo: string; removed: string | null; error?: string }[] } {
  if (opts.repo !== undefined) {
    const job = loadJob(root, id);
    if (!memberEntry(job, opts.repo)) throw new ForgeError(`job ${id} has no repo ${JSON.stringify(opts.repo).slice(0, 110)}`);
    return { removed: null, repos: [removeMemberWorktree(root, loadConfig(root).config, job, opts.repo, opts)] };
  }
  const res = removeRootWorktree(root, id, opts);
  const job = loadJob(root, id);
  const members = memberRepos(job);
  if (!members.length) return res;
  const config = loadConfig(root).config;
  // One member's failure (its clone moved, a dirty worktree without --force) never strands the others.
  const repos = members.map((m) => {
    try {
      return removeMemberWorktree(root, config, job, m.repo, opts);
    } catch (e) {
      return { repo: m.repo, removed: null, error: `repo ${m.repo}: ${(e as Error).message}` };
    }
  });
  return { ...res, repos };
}

/**
 * `git worktree remove` in the member's clone, only for the path Forge computes for this job (a
 * stored path is job.json, which the session can write). The branch is deleted only in a
 * non-verify-only member, and only the job's branch.
 */
function removeMemberWorktree(root: string, config: Config, job: Job, name: string, opts: { deleteBranch?: boolean; force?: boolean }): { repo: string; removed: string | null } {
  const m = memberEntry(job, name)!;
  const clone = memberClone(root, config, name);
  const dir = memberWorktreePath(root, config, name, job.id, clone);
  let removed: string | null = null;
  if (m.worktree && m.worktree !== dir) throw new ForgeError(`repo ${name}: the stored worktree ${JSON.stringify(m.worktree).slice(0, 120)} is not this job's worktree ${dir}`);
  if (exists(dir)) {
    run('git', ['worktree', 'remove', ...(opts.force ? ['--force'] : []), dir], { cwd: clone });
    removed = dir;
  }
  run('git', ['worktree', 'prune'], { cwd: clone, allowFail: true });
  if (opts.deleteBranch && !m.verifyOnly) run('git', ['branch', '-D', assertSafeRef(job.branch, 'job.branch')], { cwd: clone, allowFail: true });
  updateJob(root, job.id, (j) => {
    const e = memberEntry(j, name);
    if (e) e.worktree = null;
  });
  logEvent(root, job.id, 'repo-worktree-removed', { repo: name });
  return { repo: name, removed };
}

function removeRootWorktree(root: string, id: string, opts: { deleteBranch?: boolean; force?: boolean }): { removed: string | null } {
  const job = loadJob(root, id);
  stopBackground(root, id);
  // Eval jobs get a standalone clone (a .git directory) that `git worktree remove` does not know.
  const standalone = Boolean(job.worktree && exists(job.worktree) && isDir(path.join(job.worktree, '.git')));
  if (standalone) {
    // job.worktree is writable job state; deleting a directory is only safe for an eval clone Forge made.
    // standalone implies job.worktree is set, here and below.
    if (!job.eval || !insideDir(worktreeRoot(root, loadConfig(root).config), job.worktree!) || insideDir(job.worktree!, root) || realpath(job.worktree!) === realpath(root)) {
      throw new ForgeError(`refusing to delete ${job.worktree}: not an eval checkout inside the worktrees root`);
    }
    if (!opts.force && run('git', ['status', '--porcelain'], { cwd: job.worktree! }).stdout.trim()) {
      throw new ForgeError(`${job.worktree} has uncommitted changes; use --force to remove it anyway`);
    }
    fs.rmSync(job.worktree!, { recursive: true, force: true });
  } else if (job.worktree && exists(job.worktree)) {
    run('git', ['worktree', 'remove', ...(opts.force ? ['--force'] : []), job.worktree], { cwd: root });
  }
  run('git', ['worktree', 'prune'], { cwd: root, allowFail: true });
  // createJob always sets branch.
  if (opts.deleteBranch && !standalone) run('git', ['branch', '-D', job.branch!], { cwd: root, allowFail: true });
  setJob(root, id, { fields: { worktree: null } });
  logEvent(root, id, 'worktree-removed', { branchDeleted: Boolean(opts.deleteBranch) });
  return { removed: job.worktree };
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Strictly inside: the parent itself does not count. */
function insideDir(parent: string, child: string): boolean {
  const rel = path.relative(realpath(parent), realpath(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Port probing lets `forge doctor` warn when something outside Forge holds a job's port. */
export function portInUse(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, '127.0.0.1');
  });
}
