// Child processes and pids: run a binary without a shell, find one on PATH, and signal, wait for and
// identify processes.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ForgeError } from '../errors.ts';

/** What run() returns. `timedOut` is set only when `timeoutMs` ran out and the child was killed. */
export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
  timedOut?: true;
}

export interface RunOpts {
  cwd?: string;
  input?: string;
  allowFail?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** The arguments error messages name, when `args` starts with a wrapper's own options (lib/integrations/git/runner.ts's pins). */
  shownArgs?: string[];
}

/** `<cmd> <first arg> timed out after <n> s`, with the timeout rounded up to whole seconds. */
export function timedOutMessage(cmd: string, args: readonly string[], timeoutMs: number): string {
  return `${[cmd, args[0]].filter(Boolean).join(' ')} timed out after ${Math.ceil(timeoutMs / 1000)} s`;
}

/**
 * Runs a binary without a shell so arguments can never be reinterpreted.
 */
export function run(cmd: string, args: string[], opts: RunOpts = {}): RunResult {
  const shown = opts.shownArgs ?? args;
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeoutMs,
  });
  const code = (res.error as NodeJS.ErrnoException | undefined)?.code;
  // A timeout kills the child and sets res.error (ETIMEDOUT); it is a hang, not a failure to start.
  if (code === 'ETIMEDOUT' && opts.timeoutMs !== undefined) {
    const message = timedOutMessage(cmd, shown, opts.timeoutMs);
    if (opts.allowFail) return { ok: false, stdout: '', stderr: message, status: null, timedOut: true };
    throw new ForgeError(message, 'external');
  }
  // A child that exits before reading its `input` makes spawnSync report EPIPE beside the real exit
  // status (a race under load, not a failure to start): the exit status is the answer.
  const unreadInput = code === 'EPIPE' && res.status !== null;
  if (res.error && !unreadInput) {
    if (opts.allowFail) return { ok: false, stdout: '', stderr: String(res.error.message), status: null };
    throw new ForgeError(`${cmd} failed to start: ${res.error.message}`, 'external');
  }
  const out = { ok: res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status };
  if (!out.ok && !opts.allowFail) {
    throw new ForgeError(`${cmd} ${shown.join(' ')} exited ${res.status}: ${(out.stderr || out.stdout).trim()}`, 'external');
  }
  return out;
}

export function hasBinary(cmd: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Where `cmd` would be found on `env.PATH`, by stat and access only (nothing runs, unlike
 * hasBinary). Relative PATH entries are skipped: they would search the cwd, which a checkout controls.
 */
export function findOnPath(cmd: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (!cmd || cmd.includes('/') || cmd.includes('\\') || cmd.includes('\0')) return null;
  const win = platform === 'win32';
  const exts = win ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [];
  const names = win ? [...(path.extname(cmd) ? [cmd] : []), ...exts.map((e) => cmd + e)] : [cmd];
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const n of names) {
      const file = path.join(dir, n);
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (!win) fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {
        // missing or not executable: keep looking
      }
    }
  }
  return null;
}

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

/**
 * The process group first (the shell's children keep it alive), then the pid. EPERM counts as
 * dead too: a process we may not signal is not ours, so the pid was reused. Pid 1 is never a
 * process Forge started, and its group signal would be kill(-1), every process we may signal.
 */
export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return false;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 0);
      return true;
    } catch {}
  }
  return false;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch {}
}

/** SIGTERM to `pid`'s group, up to `graceMs` for it to go, then SIGKILL to the group. */
export function killAndWait(pid: number, graceMs: number): void {
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (pidAlive(pid) && Date.now() < deadline) sleepSync(50);
  if (pidAlive(pid)) signalGroup(pid, 'SIGKILL');
}

/** killAndWait without blocking the event loop. */
export async function killAndWaitAsync(pid: number, graceMs: number): Promise<void> {
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (pidAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (pidAlive(pid)) signalGroup(pid, 'SIGKILL');
}

/** How far a process's start time may be from a recorded one and still be that process (ps reports whole seconds). */
export const START_SLACK_MS = 30_000;

/** `ps -o lstart=`'s format under LC_ALL=C: `Tue Oct 21 09:14:03 2026`. */
const LSTART = /^\s*(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s*$/;

/** When `pid` started, in ms, from `ps -o lstart=`; null on Windows, for a bad pid, or when ps fails or prints something else. */
export function processStartMs(pid: number): number | null {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return null;
  const ps = run('ps', ['-o', 'lstart=', '-p', String(pid)], { allowFail: true, env: { ...process.env, LC_ALL: 'C' }, timeoutMs: 5000 });
  const m = ps.ok ? LSTART.exec(ps.stdout) : null;
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * The daemon's executable: a bare `claude` (found on PATH) or an absolute path to one. Relative
 * paths are refused because the child runs with the repo as cwd, where they would name repo files.
 * This catches mistakes such as a migrated shell template; it is not a security boundary (see
 * docs/ARCHITECTURE.md "Daemon security").
 */
export function isClaudeExecutable(word: string): boolean {
  if (/^claude(?:\.exe)?$/.test(word)) return true;
  return path.isAbsolute(word) && /[\\/]claude(?:\.exe)?$/.test(word);
}
