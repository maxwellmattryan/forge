// The one place a git process starts in lib/: every call gets the same config pins and a clean
// environment, so no caller can forget either. Imports only node:* and core/os/process.ts, so any module can
// use it without an import cycle (test/invariants/layers.test.ts).
import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { run } from '#core/os/process.ts';
import type { RunResult } from '#core/os/process.ts';

/**
 * Config pinned on every git call. Repo and worktree config are writable from a job's worktree:
 * `core.fsmonitor` names a program git runs, and the rest reshape output Forge parses (path quoting,
 * hunk merging, blank-context rendering, relative paths). The diff pins are git's defaults, so they
 * only override a user's or a worktree's config. Callers parsing diffs add `--no-ext-diff`,
 * `--no-textconv` and `--text` themselves.
 */
export const GIT_PINS: readonly (readonly [string, string])[] = Object.freeze([
  ['core.fsmonitor', 'false'],
  ['core.quotepath', 'off'],
  ['diff.interHunkContext', '0'],
  ['diff.suppressBlankEmpty', 'false'],
  ['diff.relative', 'false'],
] as const);

/**
 * Git config pinned for a daemon session and everything it runs (subagents, `forge`, verify commands),
 * through GIT_CONFIG_* (lib/office/session/lifecycle.ts sessionEnv). Those entries outrank every config file, and the
 * allowlist has no `git -c`, so a hook or fsmonitor program the session writes into the repo (e.g. a
 * `core.hooksPath` dir such as `.githooks/`, which Claude Code doesn't protect the way it does `.git/`)
 * never runs. Drivers that only .git/config or ~/.gitconfig can define (filter, diff, merge) are left alone.
 */
export const SESSION_PINS: readonly (readonly [string, string])[] = Object.freeze([
  // The null device on every platform (\\.\nul on Windows), never a directory a hook could live in.
  ['core.hooksPath', os.devNull],
  ['core.fsmonitor', 'false'],
] as const);

/** `pins` as git's leading `-c key=value` options. */
export const pinArgs = (pins: readonly (readonly [string, string])[] = GIT_PINS): string[] => pins.flatMap(([k, v]) => ['-c', `${k}=${v}`]);

/** `git status` that hides nothing a worktree's config could hide: untracked files and submodules. */
export const STATUS_ARGV: readonly string[] = Object.freeze(['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none']);

/** Variables that would point a git child at another repository, index or object store. */
const LOCATION_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE'];

/** `base` without the location variables, e.g. ones inherited when Forge runs from a git hook. */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const k of LOCATION_VARS) delete env[k];
  return env;
}

/**
 * An env for calls that must see the committed history as it is: replace objects and grafts are
 * repository state the job's worktree can write, and either can make two commits look related.
 */
export function historyEnv(base: NodeJS.ProcessEnv = gitEnv()): NodeJS.ProcessEnv {
  return { ...base, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: path.join(os.devNull, 'forge-no-grafts') };
}

export interface GitOpts {
  /** Used as given (built from gitEnv() or historyEnv()); without it, gitEnv(). */
  env?: NodeJS.ProcessEnv;
  /** The call changes refs, the index, the worktree, config or objects, so it may take optional locks. */
  write?: boolean;
  allowFail?: boolean;
  input?: string;
  timeoutMs?: number;
}

/**
 * The argv and env a git call runs with: the pins, then `args` unchanged. A read gets
 * GIT_OPTIONAL_LOCKS=0, so it never refreshes (and so never locks) the index of a worktree whose
 * builder is running git at the same moment.
 */
export function gitInvocation(args: string[], opts: Pick<GitOpts, 'env' | 'write'> = {}): { argv: string[]; env: NodeJS.ProcessEnv } {
  const env = { ...(opts.env ?? gitEnv()) };
  if (!opts.write) env.GIT_OPTIONAL_LOCKS = '0';
  return { argv: [...pinArgs(), ...args], env };
}

/** git through run(): errors name the caller's arguments, not the pins. */
export function git(cwd: string | undefined, args: string[], opts: GitOpts = {}): RunResult {
  const { argv, env } = gitInvocation(args, opts);
  return run('git', argv, { cwd, env, allowFail: opts.allowFail, input: opts.input, timeoutMs: opts.timeoutMs, shownArgs: args });
}

/** git through spawnSync, for the callers that need Buffer output, a maxBuffer cap or inherited stdio. */
export function gitSpawnSync(
  cwd: string | undefined,
  args: string[],
  opts: Pick<GitOpts, 'env' | 'write'> & Omit<SpawnSyncOptions, 'env' | 'cwd'> = {},
): SpawnSyncReturns<string | Buffer> {
  const { env: given, write, ...rest } = opts;
  const { argv, env } = gitInvocation(args, { env: given, write });
  return spawnSync('git', argv, { ...rest, cwd, env });
}
