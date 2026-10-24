// Job worktrees: create and remove the root's and members' worktrees, outside the repo under
// `worktrees.root`.
import fs from 'node:fs';
import path from 'node:path';
import { backingDown, hasJobBacking, portsLock } from '../environment/backing.ts';
import { ensureEnvironment, stopBackground } from '../environment/lifecycle.ts';
import { checkRefs, jobEnv, shell, vars } from './job-command.ts';
import { loginShell } from '../guard/command-env.ts';
import { knownValues, redactKnown, removeKnown } from '../guard/known-secrets.ts';
import { readCheckoutRecord, undoCheckout, withCheckoutLock } from './checkout.ts';
import { loadConfig, worktreeRoot } from '#core/config/load.ts';
import { stackSource } from '../pipeline/moves/deps.ts';
import { git as runGit } from '#integrations/git/runner.ts';
import { loadJob, logEvent, setJob, updateJob } from '#core/job/store.ts';
import { exists, resolveFrom } from '#core/paths.ts';
import { jobComponent } from '#core/config/components.ts';
import { allocatePorts, portBearing } from '../environment/ports.ts';
import { commandPort } from '../environment/endpoints.ts';
import { memberClone, memberEntry, memberRepos, memberWorktreePath } from '../project/job-repos.ts';
import { runCommandAsync } from './run.ts';
import { containedWorktree } from './editor.ts';
import { applySeed, dropSeed, lockSeed, refreshSeed, removeSeeded, seedKey, seedPathsPresent, seedRoot, seedTaken } from './seed.ts';
import type { SeedCommandLog, WorktreeSeedResult } from './seed.ts';
import type { Config, Job } from '#core/types.ts';
import type { BackingDownResult, BackingUpEntry } from '../environment/types.ts';
import { ForgeError } from '#core/errors.ts';
import { withLock } from '#core/os/lock.ts';
import { assertSafeRef, fill, tail } from '#core/text.ts';

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
  | { path: string; created: false; port: number | null; ports: Record<string, number>; ok?: boolean; repos?: MemberWorktreeResult[] }
  | {
      path: string;
      created: true;
      port: number;
      /** One port per port-bearing component (lib/engine/environment/ports.ts); `port` is the first entry's. */
      ports: Record<string, number>;
      stackedOn?: string;
      base?: string;
      /** One entry per `backing:` entry, only when the config has some. */
      backing?: BackingUpEntry[];
      setup: { cmd: string; ok: boolean; tail: string }[];
      ok: boolean;
      /** Only when `worktrees.seed.paths` is set: what the worktree seed did (seed.ts). */
      seed?: WorktreeSeedResult;
      repos?: MemberWorktreeResult[];
    };

function branchState(root: string, branch: string, remote: string): { local: boolean; remote: boolean } {
  const local = runGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }).ok;
  const remoteRef = runGit(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`], { allowFail: true }).ok;
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
  if (job.worktree && exists(job.worktree)) return { path: job.worktree, created: false, port: job.port, ports: job.ports };
  const remote = config.git.remote;
  runGit(root, ['fetch', remote, '--prune'], { allowFail: true, write: true });
  // createJob always sets branch and base; the `!`s below rely on it.
  const st = opts.isolate ? null : branchState(root, job.branch!, remote);
  // A new branch stacks on the one dependency that has not merged yet. Checked before anything
  // is created, so a refusal leaves no worktree and no job changes behind.
  const stack = st && !st.local && !st.remote && !opts.from ? stackSource(root, config, job) : null;
  fs.mkdirSync(wtRoot, { recursive: true });
  const defaultStart = () => opts.from ?? (runGit(root, ['rev-parse', '--verify', '--quiet', `${remote}/${job.base}`], { allowFail: true }).ok ? `${remote}/${job.base}` : job.base!);
  // Never an eval clone's, or a member's (createMemberWorktrees).
  const seeding = !opts.isolate && Array.isArray(config.worktrees.seed?.paths) && config.worktrees.seed.paths.length > 0;
  // Only a branch this call creates new at the base tip may refresh the seed: never a job's own
  // commits, a stack, --from, or a base job.json moved off the main checkout's config.
  const fresh = seeding && Boolean(st && !st.local && !st.remote && !stack && !opts.from) && job.base === config.git.base;
  if (opts.isolate || !st) {
    cloneIsolated(root, defaultStart(), dir, job.branch!, job.base!, opts.sparseExclude ?? []);
  } else {
    addWorktree(root, dir, job, remote, st, opts.sparseExclude ?? [], stack ? () => stack.start : defaultStart);
  }
  const startSha = fresh ? commitOf(root, defaultStart()) : null;
  // job.base is what PRs target, integrate merges from and reviewers diff against.
  const stacked = stack ? { stackedOn: stack.dependency, base: stack.base } : {};
  if (stack) {
    job.base = stack.base;
    setJob(root, id, { owned: { base: stack.base } });
    logEvent(root, id, 'stacked', { dependency: stack.dependency, base: stack.base });
  }
  copyUntracked(root, dir, config.worktrees.copy ?? [], opts.sparseExclude ?? []);
  if (config.worktrees.cargo?.sharedTarget) writeSharedCargoTarget(root, config, wtRoot);
  // Chosen and saved under the lock backing ports are allocated under, so a concurrent create never takes it.
  const ports = withLock(portsLock(root), () => {
    const p = allocatePorts(root, config, job);
    setJob(root, id, { owned: { worktree: dir, port: p[portBearing(config, job)[0]] }, fields: { ports: p } });
    return p;
  });
  const port = ports[portBearing(config, job)[0]];
  // The in-memory job feeds setup's placeholders and env below.
  Object.assign(job, { worktree: dir, port, ports });
  logEvent(root, id, 'worktree', { path: dir, port, ports });
  // Before setup, so setup commands (migrations, seeds) can reach the services.
  // Through ensure up, so the environment record says running and a later park stops it.
  const backing = config.backing?.length ? { backing: ensureEnvironment(root, config, job, 'worktree').backing } : {};
  const down = backing.backing?.find((b) => !b.ok);
  if (down) {
    logEvent(root, id, 'worktree-setup-failed', { backing: down.name });
    return { path: dir, created: true, port, ports, ...stacked, ...backing, setup: [], ok: false };
  }
  const setupPort = commandPort(config, job, jobComponent(config, job));
  // Setup sees the job database's url; its stored tail never holds the password or another known value.
  const known = knownValues(root, id, config);
  // Setup and a failed check stop at the first failure; warm runs every command.
  const runCommands: RunCommands = (cmds, keepGoing = false) => {
    const log: SeedCommandLog[] = [];
    for (const cmd of cmds) {
      const res = shell(fill(cmd, vars(root, config, job, dir, setupPort, cmd)), dir, jobEnv(root, config, job, dir, setupPort), { login: loginShell(config) });
      log.push({ cmd, ok: res.ok, tail: redactKnown(tail(res.output, 15), known) });
      if (!res.ok && !keepGoing) break;
    }
    return { log, ok: log.every((l) => l.ok) };
  };
  const plain = (r: { log: SeedCommandLog[]; ok: boolean }) => ({ setup: r.log, ok: r.ok, seed: undefined });
  const { setup, ok, seed } = seeding ? seededSetup(root, config, dir, startSha, runCommands) : plain(runCommands(config.worktrees.setup ?? []));
  const failed = setup.find((s) => !s.ok);
  if (failed) logEvent(root, id, 'worktree-setup-failed', { cmd: failed.cmd });
  if (seed) {
    // The command tails stay in the result: events carry no output.
    const { used, key, method, reason, refreshed, refreshSkipped, durationMs } = seed;
    logEvent(root, id, 'worktree-seed', { used, key, method, reason, refreshed, refreshSkipped, durationMs });
  }
  return { path: dir, created: true, port, ports, ...stacked, ...backing, setup, ok, ...(seed ? { seed } : {}) };
}

type RunCommands = (cmds: readonly string[], keepGoing?: boolean) => { log: SeedCommandLog[]; ok: boolean };

/**
 * `worktrees.setup` with the seed (lib/engine/workspace/seed.ts, docs/CONFIG.md › Worktree seed):
 * clone the seed and run `seed.setup` on a hit, else run setup and, from a fresh base worktree
 * (`startSha` set), refresh the seed. A seed problem never fails the create by itself.
 */
function seededSetup(root: string, config: Config, dir: string, startSha: string | null, runCommands: RunCommands): { setup: SeedCommandLog[]; ok: boolean; seed: WorktreeSeedResult } {
  const started = Date.now();
  const cfg = config.worktrees.seed;
  const key = seedKey(dir, config);
  const sroot = key ? seedRoot(root) : null;
  const seed: WorktreeSeedResult = { used: false, key: key ? key.slice(0, 16) : null, durationMs: 0 };
  // Before a clone or setup touches the seed paths: whatever is there now came with the checkout or
  // from worktrees.copy, so it must never reach a seed, on a miss any more than on a hit.
  const preexisting = seedPathsPresent(dir, cfg.paths);
  const done =(setup: SeedCommandLog[], ok: boolean, over: Partial<WorktreeSeedResult> = {}) => ({ setup, ok, seed: { ...seed, ...over, durationMs: Date.now() - started } });
  if (!key) seed.reason = 'no-key';
  else if (!sroot) seed.reason = 'cache-unusable';
  else {
    const hit = applySeed(sroot, key, dir, cfg.paths);
    if (hit.used) {
      const checks = runCommands(cfg.setup);
      seed.checks = checks.log;
      if (checks.ok) return done([], true, { used: true, method: hit.method });
      // Before setup runs, so it builds into an empty path; the seed goes too, as it failed its check.
      removeSeeded(dir, cfg.paths);
      dropSeed(sroot, key);
      seed.reason = 'check-failed';
    } else seed.reason = hit.reason;
  }
  const setup = runCommands(config.worktrees.setup ?? []);
  if (!setup.ok) return done(setup.log, false);
  // Only a clean miss refreshes. After `exists` the paths may be the main checkout's copies, and a
  // seed that failed its check, or failed to clone, would only be replaced at the next miss.
  if (seed.reason === 'no-key' || seed.reason === 'cache-unusable' || seed.reason === 'no-seed') Object.assign(seed, refresh(config, dir, key, sroot, startSha, preexisting, runCommands));
  return done(setup.log, true);
}

/**
 * Writes the seed from this worktree, only when it is a new branch at the base tip whose seed
 * paths were not there before setup, whose HEAD and tracked files have not changed through setup and
 * warm, and whose key files warm left alone.
 */
function refresh(
  config: Config,
  dir: string,
  key: string | null,
  sroot: string | null,
  startSha: string | null,
  preexisting: boolean,
  runCommands: RunCommands,
): Pick<WorktreeSeedResult, 'warm' | 'refreshed' | 'refreshSkipped'> {
  if (!key) return { refreshSkipped: 'no-key' };
  if (!sroot) return { refreshSkipped: 'cache-unusable' };
  if (!startSha || headOf(dir) !== startSha) return { refreshSkipped: 'not-base' };
  if (preexisting) return { refreshSkipped: 'exists' };
  const lock = lockSeed(sroot);
  if (!lock) return { refreshSkipped: 'busy' };
  try {
    // Checked before warm, which can take minutes, though refreshSeed would refuse it too.
    if (seedTaken(sroot, key)) return { refreshSkipped: 'exists' };
    const warm = runCommands(config.worktrees.seed.warm, true).log;
    if (headOf(dir) !== startSha || !trackedClean(dir)) return { warm, refreshSkipped: 'not-base' };
    if (seedKey(dir, config) !== key) return { warm, refreshSkipped: 'key-changed' };
    const r = refreshSeed(sroot, key, dir, config.worktrees.seed.paths, startSha);
    return r.refreshed ? { warm, refreshed: true } : { warm, refreshSkipped: r.reason ?? 'failed' };
  } catch {
    return { refreshSkipped: 'failed' };
  } finally {
    lock.release();
  }
}

const headOf = (dir: string): string | null => commitOf(dir, 'HEAD');

/**
 * Whether no tracked file in `dir` differs from HEAD or the index: setup and warm run the base
 * checkout's own files (test files, scripts) unsandboxed, so a change to one means somebody wrote
 * the worktree meanwhile. Untracked and ignored paths are the seed's content and don't count.
 * Fails closed, and shows submodule changes whatever the worktree's config says.
 */
function trackedClean(dir: string): boolean {
  const r = runGit(dir, ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=none'], { allowFail: true });
  return r.ok && r.stdout.trim() === '';
}

/** The commit `rev` names in `cwd`, or null. `rev` is HEAD or a ref checkRefs has passed, never an option. */
function commitOf(cwd: string, rev: string): string | null {
  const r = runGit(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { allowFail: true });
  const sha = r.ok ? r.stdout.trim() : '';
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) ? sha : null;
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
      runGit(clone, ['fetch', remote, '--prune'], { allowFail: true, write: true });
      // A worktree deleted by hand stays registered and would keep its branch "checked out".
      runGit(clone, ['worktree', 'prune'], { allowFail: true, write: true });
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      const start = () => (runGit(clone, ['rev-parse', '--verify', '--quiet', `${remote}/${base}`], { allowFail: true }).ok ? `${remote}/${base}` : base);
      if (m.verifyOnly) runGit(clone, ['worktree', 'add', '--detach', dir, start()], { write: true });
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
    runGit(root, ['worktree', 'add', ...checkoutArgs, dir, job.branch!], { write: true });
  } else if (st.remote) {
    runGit(root, ['worktree', 'add', ...checkoutArgs, '--track', '-b', job.branch!, dir, `${remote}/${job.branch}`], { write: true });
  } else {
    runGit(root, ['worktree', 'add', ...checkoutArgs, '--no-track', '-b', job.branch!, dir, start()], { write: true });
  }
  if (sparseExclude.length) {
    sparseCheckout(dir, sparseExclude);
    runGit(dir, ['checkout'], { write: true });
  }
}

function sparseCheckout(dir: string, exclude: string[]): void {
  runGit(dir, ['sparse-checkout', 'set', '--no-cone', '/*', ...exclude.map((p) => `!/${p.replace(/^\/+/, '')}`)], { write: true });
}

/**
 * A git worktree shares the main checkout's object store and refs, so an eval builder could
 * read the real fix with `git log --all`. A standalone shallow clone holds only the base commit.
 * The base branch name points at it too, so `git diff <base>...HEAD` keeps working for reviewers.
 */
function cloneIsolated(root: string, start: string, dir: string, branch: string, base: string, sparseExclude: string[]): void {
  const resolved = runGit(root, ['rev-parse', '--verify', '--quiet', `${start}^{commit}`], { allowFail: true });
  if (!resolved.ok) throw new ForgeError(`eval base ${start} not found in the main checkout`);
  const sha = resolved.stdout.trim();
  // Every call below builds the clone. The wrapper drops an inherited GIT_DIR (e.g. Forge run from a
  // git hook), which would point them at another repository.
  const git = (args: string[], cwd = dir) => runGit(cwd, args, { write: true });
  // Never reuse a leftover directory: cleanup on failure would delete whatever was in it.
  if (exists(dir)) throw new ForgeError(`${dir} already exists; remove it before starting the eval`);
  try {
    git(['init', '-q', dir], root);
    // Commits made in the clone need an identity; the main checkout's local config does not carry over.
    for (const key of ['user.name', 'user.email']) {
      const v = runGit(root, ['config', '--get', key], { allowFail: true }).stdout.trim();
      if (v) git(['config', key, v]);
    }
    git(['fetch', '-q', '--depth', '1', '--no-tags', root, sha]);
    git(['update-ref', `refs/heads/${base}`, sha]);
    if (branch !== base) git(['update-ref', `refs/heads/${branch}`, sha]);
    git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    if (sparseExclude.length) sparseCheckout(dir, sparseExclude);
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
  const listed = runGit(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], { allowFail: true }).stdout;
  const plain = runGit(root, ['ls-files', '--others', '--ignored', '--exclude-standard'], { allowFail: true }).stdout;
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

/**
 * Removes the job's worktrees: the root's and then every member's, or with `repo` only that member's.
 * `removed` is the root path actually removed (null when none was); `branchKept` says why a
 * `--delete-branch` kept the branch; `repos` lists the members handled, only when there are any.
 */
export async function removeWorktree(
  root: string,
  id: string,
  opts: { deleteBranch?: boolean; force?: boolean; repo?: string } = {},
): Promise<{ removed: string | null; branchKept?: string; repos?: { repo: string; removed: string | null; error?: string }[]; backing?: BackingDownResult }> {
  if (opts.repo !== undefined) {
    const job = loadJob(root, id);
    if (!memberEntry(job, opts.repo)) throw new ForgeError(`job ${id} has no repo ${JSON.stringify(opts.repo).slice(0, 110)}`);
    return { removed: null, repos: [removeMemberWorktree(root, loadConfig(root).config, job, opts.repo, opts)] };
  }
  const removedRoot = await removeRootWorktree(root, id, opts);
  const config = loadConfig(root).config;
  const res = { ...removedRoot, ...rootBackingDown(root, config, id) };
  // Beside backing-db.json, which rootBackingDown removes: the values go with the worktree.
  removeKnown(root, id);
  const job = loadJob(root, id);
  const members = memberRepos(job);
  if (!members.length) return res;
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

/** The job's per-job containers, after the git removal: a docker failure is reported, never strands the worktree. */
function rootBackingDown(root: string, config: Config, id: string): { backing?: BackingDownResult } {
  if (!hasJobBacking(root, config, id)) return {};
  try {
    return { backing: backingDown(root, config, id) };
  } catch (e) {
    return { backing: { removed: [], volumes: [], ok: false, error: (e as Error).message } };
  }
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
    runGit(clone, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), dir], { write: true });
    removed = dir;
  }
  runGit(clone, ['worktree', 'prune'], { allowFail: true, write: true });
  if (opts.deleteBranch && !m.verifyOnly) runGit(clone, ['branch', '-D', assertSafeRef(job.branch, 'job.branch')], { allowFail: true, write: true });
  updateJob(root, job.id, (j) => {
    const e = memberEntry(j, name);
    if (e) e.worktree = null;
  });
  logEvent(root, job.id, 'repo-worktree-removed', { repo: name });
  return { repo: name, removed };
}

/**
 * The stored root worktree when it is the job's own `<worktrees.root>/<id>` and resolves there, null
 * when nothing is stored or the stored path does not exist (stale, or from before a `worktrees.root`
 * change). job.json is agent-writable, so any other existing path is refused: another job's worktree,
 * the main checkout, or `<root>/<id>` swapped for a link out.
 */
function ownWorktree(root: string, config: Config, job: Job): string | null {
  const wt = job.worktree;
  if (typeof wt !== 'string' || !wt) return null;
  if (containedWorktree(root, config, job) !== null) return wt;
  if (!exists(wt)) return null;
  throw notOwnWorktree(root, config, job);
}

function notOwnWorktree(root: string, config: Config, job: Job): ForgeError {
  return new ForgeError(`refusing to remove ${JSON.stringify(String(job.worktree).slice(0, 120))}: it is not this job's worktree ${path.join(worktreeRoot(root, config), job.id)}; nothing was removed`);
}

/**
 * Removes only what Forge computes for the job: job.json's `worktree` and `branch` are agent-writable,
 * so every check runs before the checkout undo or anything else changes, and the worktree check runs
 * again right before the delete. `--delete-branch` deletes only `git.branchPrefix` + id; any other
 * branch (another job's, the base, a `--branch` or adopted PR branch a human may own) is kept and
 * reported as `branchKept`, as `forge job delete` does.
 */
async function removeRootWorktree(root: string, id: string, opts: { deleteBranch?: boolean; force?: boolean }): Promise<{ removed: string | null; branchKept?: string }> {
  const job = loadJob(root, id);
  const config = loadConfig(root).config;
  const target = ownWorktree(root, config, job);
  // Eval jobs get a standalone clone (a .git directory) that `git worktree remove` does not know.
  const standalone = Boolean(target && isDir(path.join(target, '.git')));
  let branch: string | null = null;
  let branchKept: string | undefined;
  if (opts.deleteBranch && !standalone) {
    const own = `${config.git.branchPrefix}${id}`;
    if (assertSafeRef(job.branch, 'job.branch') === own) branch = own;
    else branchKept = `${job.branch} is not this job's branch ${own}; Forge deletes only that one`;
  }
  // Before anything is deleted: a fixed path must never be left pointing into a removed worktree,
  // and the undo commands need the worktree to run in.
  if (readCheckoutRecord(root)?.job === id) {
    const runner = (jid: string, name: string, label: string) => runCommandAsync(root, config, jid, name, { label, tail: 20 });
    await withCheckoutLock(root, async () => {
      if (readCheckoutRecord(root)?.job === id) await undoCheckout(root, config, runner);
    });
  }
  stopBackground(root, id);
  // The undo above is async and runs configured commands, so the path could have been swapped since.
  const recheck = () => {
    if (ownWorktree(root, config, job) !== target) throw notOwnWorktree(root, config, job);
  };
  if (target && standalone) {
    // A second layer: deleting a directory is only safe for an eval clone Forge made.
    if (!job.eval || !insideDir(worktreeRoot(root, config), target) || insideDir(target, root) || realpath(target) === realpath(root)) {
      throw new ForgeError(`refusing to delete ${target}: not an eval checkout inside the worktrees root`);
    }
    if (!opts.force && runGit(target, ['status', '--porcelain']).stdout.trim()) {
      throw new ForgeError(`${target} has uncommitted changes; use --force to remove it anyway`);
    }
    recheck();
    fs.rmSync(target, { recursive: true, force: true });
  } else if (target) {
    recheck();
    runGit(root, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), target], { write: true });
  }
  runGit(root, ['worktree', 'prune'], { allowFail: true, write: true });
  if (branch) runGit(root, ['branch', '-D', branch], { allowFail: true, write: true });
  setJob(root, id, { owned: { worktree: null } });
  logEvent(root, id, 'worktree-removed', { branchDeleted: branch !== null });
  return { removed: target, ...(branchKept ? { branchKept } : {}) };
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
