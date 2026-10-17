// `forge release run` and `forge release status`: execute the release plan step by step with
// checkpoints in `.forge/runtime/release/state.json`, stop on the first failure, and resume there.
// What runs always comes from recomputing the plan (lib/release-plan.ts) from config and the clones:
// release.json and state.json are runtime files an agent session can write, so they are checked,
// never trusted. Every step with a check runs the check first, so a step that happened (a publish
// that crashed before its checkpoint) is never run twice. Publish steps ask on a TTY unless the
// repo sets `release.publish: allow`; nothing here fakes a TTY or skips the question.

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.ts';
import { SUPPORT_URL, posixShell } from './platform.ts';
import {
  type CheckKind,
  type GitReader,
  type PlanOptions,
  type ReleasePlan,
  type ReleaseRepo,
  type ReleaseState,
  type ReleaseStep,
  type StepState,
  RELEASE_FILE_VERSION,
  assertNoSymlinks,
  cloneGit,
  doneCount,
  planHash,
  planRelease,
  planSteps,
  readManifestPackage,
  readPlanFile,
  readState,
  releaseFiles,
  repoBase,
  repoRemote,
  stepCommand,
  strategyOf,
} from './release-plan.ts';
import type { Config } from './types.ts';
import { ForgeError, findOnPath, now, run, writeJsonAtomic } from './util.ts';
import { pidAlive } from './worktree.ts';

export const RUN_DAEMON_REFUSAL = 'forge release run runs release and publish commands, which a daemon session may not do; a human runs it in their own session';
export const RUN_WINDOWS_REFUSAL = `forge release run is not supported on native Windows; run it under WSL2: ${SUPPORT_URL}`;
const LOCK_STALE_MS = 60_000;
const CHECK_TIMEOUT_MS = 120_000;

export type StopReason = 'exit' | 'check' | 'needs_confirmation' | 'declined' | 'manual';

export interface RunStop {
  step: string;
  reason: StopReason;
  detail: string;
  log: string | null;
}

export interface RunResult {
  ok: boolean;
  plan: string;
  state: string;
  done: number;
  total: number;
  ran: string[];
  skipped: string[];
  stopped: RunStop | null;
}

export type SpawnFn = typeof nodeSpawn;

export interface RunOptions extends PlanOptions {
  /** stdin and stderr are both TTYs: only then is a human there to answer. */
  interactive: boolean;
  /** Asks `prompt` and resolves true on yes. Only called when `interactive`. */
  confirm: (prompt: string) => Promise<boolean>;
  spawn?: SpawnFn;
  /** Where step output and prompts go besides the log; stderr by default. */
  echo?: (chunk: string | Buffer) => void;
  env?: NodeJS.ProcessEnv;
}

/** The refusals that come before anything is read: a daemon session, and native Windows. */
export function refuseRun(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): void {
  if (env.FORGE_DAEMON === '1') throw new ForgeError(RUN_DAEMON_REFUSAL);
  if (platform === 'win32') throw new ForgeError(RUN_WINDOWS_REFUSAL);
}

/** The plan as it is now, against release.json and state.json; a mismatch is refused as stale. */
export function freshPlan(root: string, config: Config, file: ReleasePlan, state: ReleaseState | null, opts: PlanOptions = {}): ReleasePlan {
  const now = planRelease(root, config, file.selection, opts);
  // planHash(file) catches a release.json edited without updating its hash.
  const old = [file.hash, planHash(file), state?.planHash].find((h) => h !== undefined && h !== now.hash);
  if (old !== undefined) throw new ForgeError(`the release plan no longer matches config and the repos (plan ${String(old).slice(0, 12)}, now ${now.hash.slice(0, 12)}); run forge release plan`);
  return now;
}

/** `.forge/locks/release/`, taken with mkdir; a dead owner's (or an ownerless stale) lock is taken over once. */
export function takeReleaseLock(root: string): () => void {
  const dir = path.join(paths(root).locks, 'release');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const owner = path.join(dir, 'owner.json');
  const take = (): boolean => {
    try {
      fs.mkdirSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
    fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, startedAt: now() }) + '\n');
    return true;
  };
  if (!take()) {
    let pid: unknown = null;
    try {
      pid = JSON.parse(fs.readFileSync(owner, 'utf8'))?.pid;
    } catch {
      // missing or half-written: judged by the dir's age below
    }
    let stale: boolean;
    if (typeof pid === 'number') stale = !pidAlive(pid);
    else {
      let age = 0;
      try {
        age = Date.now() - fs.statSync(dir).mtimeMs;
      } catch {
        age = Infinity;
      }
      stale = age > LOCK_STALE_MS;
    }
    if (!stale) throw new ForgeError(`another forge release run (pid ${typeof pid === 'number' ? pid : 'unknown'}) is in progress`, 'owned');
    fs.rmSync(dir, { recursive: true, force: true });
    if (!take()) throw new ForgeError('another forge release run took the release lock first', 'owned');
  }
  return () => {
    try {
      const cur = JSON.parse(fs.readFileSync(owner, 'utf8'));
      if (cur?.pid !== process.pid) return;
    } catch {
      return;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

interface CheckResult {
  ok: boolean;
  detail?: string;
  tags?: string[];
  version?: string;
}

const lines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter(Boolean);
const sha = (git: GitReader, dir: string, ref: string): string | null => {
  const r = git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.ok ? r.stdout.trim() : null;
};

/** One check for one repo's step. `env` resolves the registry tools. */
export function runCheck(kind: CheckKind, repo: ReleaseRepo, config: Config, git: GitReader = cloneGit, env: NodeJS.ProcessEnv = process.env): CheckResult {
  const dir = repo.dir;
  const base = repoBase(config, repo.repo);
  const remote = repoRemote(config);
  const tracking = `refs/remotes/${remote}/${base}`;
  const porcelain = (): CheckResult => {
    const st = git(dir, ['status', '--porcelain', '--untracked-files=normal']);
    if (!st.ok) return { ok: false, detail: 'git status failed' };
    const n = lines(st.stdout).length;
    return n ? { ok: false, detail: `${n} uncommitted or untracked path${n === 1 ? '' : 's'}` } : { ok: true };
  };
  const tagged = (): CheckResult => {
    const t = git(dir, ['tag', '--points-at', 'HEAD']);
    const tags = t.ok ? lines(t.stdout) : [];
    return tags.length ? { ok: true, tags } : { ok: false, detail: 'HEAD carries no tag' };
  };
  const atRemote = (): CheckResult => {
    const head = sha(git, dir, 'HEAD');
    const there = sha(git, dir, tracking);
    if (!there) return { ok: false, detail: `no ${remote}/${base}` };
    return head === there ? { ok: true } : { ok: false, detail: `HEAD ${head?.slice(0, 12) ?? 'unknown'} is not ${remote}/${base} ${there.slice(0, 12)}` };
  };
  switch (kind) {
    case 'ready': {
      const b = git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      const branch = b.ok ? b.stdout.trim() : 'a detached HEAD';
      if (branch !== base) return { ok: false, detail: `the clone is on ${branch}, not ${base}` };
      const clean = porcelain();
      if (!clean.ok) return clean;
      if (!git(dir, ['fetch', '--quiet', remote, `refs/heads/${base}`]).ok) return { ok: false, detail: `git fetch ${remote} ${base} failed` };
      return atRemote();
    }
    case 'clean':
      return porcelain();
    case 'tagged':
      return tagged();
    case 'tag-pushed': {
      const t = tagged();
      if (!t.ok) return t;
      const head = sha(git, dir, 'HEAD');
      const heads = git(dir, ['ls-remote', remote, `refs/heads/${base}`]);
      const remoteBase = heads.ok ? lines(heads.stdout).map((l) => l.split(/\s+/)).find((w) => w[1] === `refs/heads/${base}`)?.[0] : undefined;
      if (!head || remoteBase !== head) return { ok: false, detail: `${remote} has ${base} at ${remoteBase?.slice(0, 12) ?? 'nothing'}, not HEAD ${head?.slice(0, 12) ?? 'unknown'}` };
      for (const tag of t.tags!) {
        const ref = `refs/tags/${tag}`;
        const local = git(dir, ['rev-parse', '--verify', '--quiet', ref]);
        const ls = git(dir, ['ls-remote', '--tags', remote, ref]);
        const there = ls.ok ? lines(ls.stdout).map((l) => l.split(/\s+/)).find((w) => w[1] === ref)?.[0] : undefined;
        if (!local.ok || there !== local.stdout.trim()) return { ok: false, detail: `tag ${tag} is not on ${remote}` };
      }
      return t;
    }
    case 'remote-tagged': {
      if (!git(dir, ['fetch', '--quiet', '--tags', remote, `refs/heads/${base}`]).ok) return { ok: false, detail: `git fetch ${remote} ${base} --tags failed` };
      const t = git(dir, ['tag', '--points-at', tracking]);
      const tags = t.ok ? lines(t.stdout) : [];
      return tags.length ? { ok: true, tags } : { ok: false, detail: `${remote}/${base} carries no tag yet` };
    }
    case 'at-remote':
      return atRemote();
    case 'registry': {
      const eco = repo.package?.ecosystem ?? (repo.registry === 'crates.io' || repo.mechanism === 'cargo-release' ? 'cargo' : 'npm');
      const pkg = readManifestPackage(dir, eco);
      if ('reason' in pkg) return { ok: false, detail: pkg.reason };
      const tool = eco === 'npm' ? 'npm' : 'cargo';
      const bin = findOnPath(tool, env);
      if (!bin) return { ok: false, detail: `${tool} not found on PATH` };
      if (eco === 'npm') {
        const r = run(bin, ['view', `${pkg.name}@${pkg.version}`, 'version'], { cwd: dir, allowFail: true, env, timeoutMs: CHECK_TIMEOUT_MS });
        return r.ok && r.stdout.trim() === pkg.version ? { ok: true, version: pkg.version } : { ok: false, detail: `npm has no ${pkg.name}@${pkg.version}` };
      }
      const r = run(bin, ['search', pkg.name, '--limit', '10'], { cwd: dir, allowFail: true, env, timeoutMs: CHECK_TIMEOUT_MS });
      const want = `${pkg.name} = "${pkg.version}"`;
      return r.ok && lines(r.stdout).some((l) => l === want || l.startsWith(`${want} `)) ? { ok: true, version: pkg.version } : { ok: false, detail: `crates.io has no ${pkg.name} ${pkg.version}` };
    }
  }
}

const LOCAL_TOOLS = new Set(['changeset', 'release-please']);

/** The program and arguments a step spawns, or why it can't. */
export function stepArgv(step: ReleaseStep, dir: string, env: NodeJS.ProcessEnv = process.env): { argv: string[] } | { missing: string } {
  if (step.shell !== null) return { argv: [posixShell({ env }), '-lc', step.shell] };
  const [word, ...args] = step.argv ?? [];
  const local = LOCAL_TOOLS.has(word) ? findOnPath(word, { PATH: path.join(dir, 'node_modules', '.bin') }) : null;
  const bin = local ?? findOnPath(word, env);
  return bin ? { argv: [bin, ...args] } : { missing: `${word} not found on PATH` };
}

const logName = (index: number, step: ReleaseStep): string => `${String(index + 1).padStart(2, '0')}-${step.repo ?? 'root'}-${step.kind}.log`;

function openLog(file: string): number {
  const st = (() => {
    try {
      return fs.lstatSync(file);
    } catch {
      return null;
    }
  })();
  if (st && !st.isFile()) throw new ForgeError(`${file} is not a regular file; remove it and run again`);
  const c = fs.constants;
  return fs.openSync(file, c.O_WRONLY | c.O_CREAT | c.O_APPEND | (c.O_NOFOLLOW ?? 0), 0o600);
}

function spawnStep(spawn: SpawnFn, argv: string[], cwd: string, env: NodeJS.ProcessEnv, fd: number, echo: (c: string | Buffer) => void): Promise<{ exit: number | null; error?: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<SpawnFn>;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['inherit', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ exit: null, error: (e as Error).message });
      return;
    }
    const tee = (d: Buffer) => {
      echo(d);
      fs.writeSync(fd, d);
    };
    child.stdout?.on('data', tee);
    child.stderr?.on('data', tee);
    let error: string | undefined;
    child.on('error', (e) => {
      error = e.message;
    });
    child.on('close', (code) => resolve(error !== undefined ? { exit: null, error } : { exit: code }));
  });
}

/** The prompt a publish step shows before it runs. */
export const publishPrompt = (step: ReleaseStep, dir: string): string => `Publish step ${step.id} in ${dir}:\n  ${stepCommand(step)}\nRun it? [y/N] `;

/**
 * `forge release run`: refusals, recompute-and-compare, the lock, then each step from the first one
 * not done. Returns the result the CLI prints; a stop is exit 1, not a thrown error.
 */
export async function runRelease(root: string, config: Config, opts: RunOptions): Promise<{ data: RunResult; exitCode: 0 | 1 }> {
  refuseRun();
  const files = releaseFiles(root);
  assertNoSymlinks(files);
  const file = readPlanFile(files);
  if (!file) throw new ForgeError('no release plan; run forge release plan', 'failed', 'forge release plan');
  let state = readState(files);
  const plan = freshPlan(root, config, file, state, opts);
  const release = takeReleaseLock(root);
  try {
    const env = opts.env ?? process.env;
    const echo = opts.echo ?? ((c) => process.stderr.write(c));
    const spawn = opts.spawn ?? nodeSpawn;
    const git = opts.git ?? cloneGit;
    const at = now();
    state ??= { version: RELEASE_FILE_VERSION, planHash: plan.hash, startedAt: at, updatedAt: at, finishedAt: null, steps: {} };
    const st = state;
    const save = () => {
      assertNoSymlinks(files);
      st.updatedAt = now();
      writeJsonAtomic(files.state, st);
    };
    const set = (id: string, s: Omit<StepState, 'at'>) => {
      st.steps[id] = { ...s, at: now() };
      save();
    };
    const steps = planSteps(plan);
    const repoOf = new Map(plan.repos.flatMap((r) => r.steps.map((s) => [s.id, r] as const)));
    const ran: string[] = [];
    const skipped: string[] = [];
    let stopped: RunStop | null = null;
    const recorded = (c: CheckResult) => ({ ...(c.tags ? { tags: c.tags } : {}), ...(c.version ? { version: c.version } : {}) });
    for (let i = 0; i < steps.length && !stopped; i++) {
      const step = steps[i];
      if (st.steps[step.id]?.status === 'done') continue;
      const repo = repoOf.get(step.id)!;
      const acts = step.argv !== null || step.shell !== null || step.manual !== null;
      const check = () => runCheck(step.check!, repo, config, git, env);
      const failCheck = (c: CheckResult, log: string | null = null) => {
        const detail = `check ${step.check} failed: ${c.detail ?? 'not satisfied'}`;
        set(step.id, { status: 'failed', reason: 'check', detail, ...(log ? { log } : {}) });
        stopped = { step: step.id, reason: 'check', detail, log };
      };
      if (step.check && acts) {
        const c = check();
        if (c.ok) {
          set(step.id, { status: 'done', skipped: true, ...recorded(c) });
          skipped.push(step.id);
          continue;
        }
      }
      if (!acts) {
        // preflight: its check is the whole step.
        const c = step.check ? check() : { ok: true };
        if (!c.ok) failCheck(c);
        else {
          set(step.id, { status: 'done', ...recorded(c) });
          ran.push(step.id);
        }
        continue;
      }
      if (step.manual !== null) {
        if (!opts.interactive) {
          stopped = { step: step.id, reason: 'manual', detail: step.manual, log: null };
          break;
        }
        if (!(await opts.confirm(`${step.manual}\nDone? [y/N] `))) {
          stopped = { step: step.id, reason: 'declined', detail: `${step.id} is not done yet`, log: null };
          break;
        }
        const c = check();
        if (!c.ok) failCheck(c);
        else {
          set(step.id, { status: 'done', ...recorded(c) });
          ran.push(step.id);
        }
        continue;
      }
      if (step.publish && strategyOf(config, step.repo)?.publish !== 'allow') {
        if (!opts.interactive) {
          stopped = { step: step.id, reason: 'needs_confirmation', detail: `run forge release run in a terminal, or set release.publish: allow for ${repo.label} in .forge/config.yml`, log: null };
          break;
        }
        if (!(await opts.confirm(publishPrompt(step, repo.dir)))) {
          stopped = { step: step.id, reason: 'declined', detail: `${step.id} was declined`, log: null };
          break;
        }
      }
      fs.mkdirSync(files.logs, { recursive: true });
      assertNoSymlinks(files);
      const log = path.join(files.logs, logName(i, step));
      const resolved = stepArgv(step, repo.dir, env);
      set(step.id, { status: 'started', log });
      ran.push(step.id);
      const fd = openLog(log);
      let outcome: { exit: number | null; error?: string };
      try {
        if ('missing' in resolved) {
          fs.writeSync(fd, `${resolved.missing}\n`);
          outcome = { exit: null, error: resolved.missing };
        } else {
          fs.writeSync(fd, `$ ${stepCommand(step)}\n`);
          outcome = await spawnStep(spawn, resolved.argv, repo.dir, env, fd, echo);
        }
      } finally {
        fs.closeSync(fd);
      }
      if (outcome.exit !== 0) {
        const detail = outcome.error ?? `${step.id} exited ${outcome.exit}`;
        set(step.id, { status: 'failed', reason: 'exit', exit: outcome.exit, detail, log });
        stopped = { step: step.id, reason: 'exit', detail, log };
        break;
      }
      if (step.check) {
        const c = check();
        if (!c.ok) {
          failCheck(c, log);
          break;
        }
        set(step.id, { status: 'done', exit: 0, log, ...recorded(c) });
      } else set(step.id, { status: 'done', exit: 0, log });
    }
    const done = doneCount(plan, st);
    if (!stopped && done === steps.length) {
      st.finishedAt = now();
      save();
    } else if (!fs.existsSync(files.state)) save();
    return { data: { ok: !stopped, plan: files.md, state: files.state, done, total: steps.length, ran, skipped, stopped }, exitCode: stopped ? 1 : 0 };
  } finally {
    release();
  }
}

/** `forge release status`: read-only progress, recorded tags and versions, and whether the plan is stale. */
export function releaseStatus(root: string, config: Config, opts: PlanOptions = {}) {
  const files = releaseFiles(root);
  assertNoSymlinks(files);
  const file = readPlanFile(files);
  if (!file) return { plan: null };
  const state = readState(files);
  const own = state && state.planHash === file.hash ? state : null;
  let stale = false;
  let staleReason: string | undefined;
  try {
    const now = planRelease(root, config, file.selection, opts);
    stale = now.hash !== file.hash || planHash(file) !== file.hash;
    if (stale) staleReason = `plan ${file.hash.slice(0, 12)}, now ${now.hash.slice(0, 12)}`;
  } catch (e) {
    stale = true;
    staleReason = (e as Error).message;
  }
  if (state && !own && !stale) {
    stale = true;
    staleReason = `state.json belongs to plan ${state.planHash.slice(0, 12)}`;
  }
  const steps = planSteps(file).map((s) => {
    const r = own?.steps[s.id];
    return {
      id: s.id,
      publish: s.publish,
      status: r?.status ?? 'pending',
      at: r?.at ?? null,
      ...(r?.tags ? { tags: r.tags } : {}),
      ...(r?.version ? { version: r.version } : {}),
      ...(r?.reason ? { reason: r.reason } : {}),
    };
  });
  return {
    plan: files.md,
    hash: file.hash.slice(0, 12),
    selection: file.selection,
    total: steps.length,
    done: steps.filter((s) => s.status === 'done').length,
    next: steps.find((s) => s.status !== 'done')?.id ?? null,
    stale,
    ...(staleReason !== undefined ? { staleReason } : {}),
    steps,
    finishedAt: own?.finishedAt ?? null,
  };
}
