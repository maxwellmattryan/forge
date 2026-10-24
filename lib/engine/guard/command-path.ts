// The PATH configured commands get: sanitised, and captured once from the login shell at `forge dash`
// start (docs/CONFIG.md "Command environment"). A relative or empty entry resolves in the command's
// cwd, the job's worktree, where the job's own code could plant a binary, so none survives.
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_ROOT } from '#core/paths.ts';
import { posixShell } from '#core/os/platform.ts';
import { run } from '#core/os/process.ts';

/** The PATH `forge dash` captured from the login shell; daemon sessions and their `forge` calls inherit it. */
export const COMMAND_PATH_ENV = 'FORGE_COMMAND_PATH';
/** Where COMMAND_PATH_ENV came from: `login-shell (<shell>)` or `inherited: <reason>` (forge doctor shows it). */
export const COMMAND_PATH_SOURCE_ENV = 'FORGE_COMMAND_PATH_SOURCE';

/**
 * `value` without empty, relative or repeated entries (compared case-insensitively on win32), joined
 * with the platform's delimiter; `first`, when given, goes in front and its later copy is dropped.
 */
export function sanitizePath(value: string | null | undefined, platform: NodeJS.Platform = process.platform, first?: string): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [...(first ? [first] : []), ...String(value ?? '').split(p.delimiter)]) {
    if (!entry || !p.isAbsolute(entry)) continue;
    const key = platform === 'win32' ? entry.toUpperCase() : entry;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.join(p.delimiter);
}

/** Brackets the PATH in the login shell's output, which a profile can fill with anything else. */
const MARK = '__FORGE_COMMAND_PATH__';
// printf and "$PATH" only: a builtin and a variable every sh, bash, zsh and fish 3 has (fish 3 joins
// a quoted PATH with colons).
const PRINT_PATH = `printf '%s\\n%s\\n%s\\n' ${MARK} "$PATH" ${MARK}`;

/** The PATH between the last pair of marker lines in `stdout`, or null. lastIndexOf, not a regex, over profile output. */
function markedPath(stdout: string): string | null {
  const end = stdout.lastIndexOf(`\n${MARK}`);
  if (end < 0) return null;
  const start = stdout.lastIndexOf(`${MARK}\n`, end);
  if (start < 0 || (start > 0 && stdout[start - 1] !== '\n')) return null;
  const value = stdout.slice(start + MARK.length + 1, end);
  return value.includes('\n') ? null : value;
}

export interface CaptureOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  /** The capture's cwd: the home dir, never a job's worktree, so no repo file steers the profile. */
  home?: string;
}

/**
 * The PATH a login shell builds (posixShell() -lc, once, stdin closed, in `home`), sanitised with this
 * plugin's bin/ first, and where it came from. A run that times out, fails or prints no marker pair
 * falls back to `env.PATH`, sanitised the same way, with the reason; on win32 nothing is spawned.
 */
export function captureLoginPath(opts: CaptureOptions = {}): { path: string; source: string } {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const bin = (platform === 'win32' ? path.win32 : path.posix).join(PLUGIN_ROOT, 'bin');
  const inherited = (reason: string) => ({ path: sanitizePath(env.PATH, platform, bin), source: `inherited: ${reason}` });
  if (platform === 'win32') return inherited('win32');
  const shell = posixShell({ env, platform });
  const res = run(shell, ['-lc', PRINT_PATH], { cwd: opts.home ?? os.homedir(), env, input: '', allowFail: true, timeoutMs });
  if (res.timedOut) return inherited(`timed out after ${Math.ceil(timeoutMs / 1000)} s (${shell})`);
  if (res.status === null) return inherited(`exited without starting (${shell}: ${res.stderr.trim().slice(0, 120)})`);
  if (res.status !== 0) return inherited(`exited ${res.status} (${shell})`);
  const found = markedPath(res.stdout);
  if (found === null || !sanitizePath(found, platform)) return inherited(`no PATH in the output of ${shell} -lc`);
  return { path: sanitizePath(found, platform, bin), source: `login-shell (${shell})` };
}

/** captureLoginPath into `env` (default this process's), so its children and their `forge` calls inherit it. */
export function adoptCommandPath(env: NodeJS.ProcessEnv = process.env, opts: Omit<CaptureOptions, 'env'> = {}): { path: string; source: string } {
  const got = captureLoginPath({ ...opts, env });
  env[COMMAND_PATH_ENV] = got.path;
  env[COMMAND_PATH_SOURCE_ENV] = got.source;
  return got;
}
