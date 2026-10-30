// The `forge` children of `forge dash`: the periodic ones, `forge sync` and the Office pass (`forge office pass`), outside
// any daemon scope, as the human who started the dashboard, with git pinned (SYNC_PINS) so a hook or program the
// checkout's config names never runs on their fetches; and the code driver's (startForge), each in a job's own scope,
// as a job session's. Anything that runs git runs here, never in the server: git's helpers block the process.
// docs/architecture/daemon.md "Periodic sync", "Periodic Office pass" and "Code driver" describe them.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { PLUGIN_ROOT } from '#core/paths.ts';
import { SYNC_PINS, pinEnv } from '#integrations/git/runner.ts';

/** A child that runs longer than this is killed; the next interval tries again. */
const CHILD_TIMEOUT_MS = 10 * 60_000;

/** The child's env: `env` pinned to `root` in agent mode, with no daemon marker or scope, and SYNC_PINS after any git config the caller set. */
export function syncChildEnv(root: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, FORGE_ROOT: root, FORGE_MODE: 'agent' };
  for (const k of Object.keys(out)) if (k.startsWith('FORGE_DAEMON')) delete out[k];
  return pinEnv(out, SYNC_PINS);
}

/** How a caller stops a running child: when `signal` aborts it gets SIGTERM, then SIGKILL after `graceMs`. */
export interface ChildStop {
  signal: AbortSignal;
  graceMs: number;
}

/** One `forge sync` in a child process (runForgeChild). */
export const runSyncChild = (root: string, env: NodeJS.ProcessEnv = process.env, stop?: ChildStop): Promise<string | null> => runForgeChild(root, ['sync'], env, stop);

/** One Office pass in a child process (runForgeChild): it may call gh once per mandate milestone. */
export const runPassChild = (root: string, env: NodeJS.ProcessEnv = process.env, stop?: ChildStop): Promise<string | null> => runForgeChild(root, ['office', 'pass'], env, stop);

/**
 * One `forge <args>` in a child process: sync and the pass call gh synchronously, which would stall every
 * session's pipe if they ran in the server. Resolves with null on success or the failure's message.
 */
export function runForgeChild(root: string, args: string[], env: NodeJS.ProcessEnv = process.env, stop?: ChildStop): Promise<string | null> {
  return runChild(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'forge'), ...args], { cwd: root, env: syncChildEnv(root, env), stop });
}

/**
 * One child process, killed after CHILD_TIMEOUT_MS, and stopped (SIGTERM, then SIGKILL after `stop.graceMs`)
 * once `stop.signal` aborts, at once when it already has. Resolves once the child has exited, with null on a
 * zero exit or the failure's message: its last stderr line, else `exit <code or signal>`.
 */
export function runChild(file: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; stop?: ChildStop | undefined }): Promise<string | null> {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    let grace: NodeJS.Timeout | null = null;
    const child = spawn(file, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
    timer.unref?.();
    // Not spawn's own `signal` option: that sends one signal and never escalates to SIGKILL.
    const onAbort = () => {
      child.kill('SIGTERM');
      grace ??= setTimeout(() => child.kill('SIGKILL'), o.stop!.graceMs);
    };
    const finish = (message: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      o.stop?.signal.removeEventListener('abort', onAbort);
      resolve(message);
    };
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 2000) stderr += d.toString('utf8');
    });
    child.on('error', (e) => finish(e.message));
    child.on('close', (code, signal) => finish(code === 0 ? null : stderr.trim().split('\n').pop() || `exit ${code ?? signal}`));
    if (o.stop?.signal.aborted) onAbort();
    else o.stop?.signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** How one forge child ended: its exit code or signal, its last stdout line parsed, and its stderr's start. */
export interface ForgeExit {
  exit: number | null;
  signal: NodeJS.Signals | null;
  /** The last non-empty stdout line parsed as JSON, or null (none, cut at the cap, or not JSON). */
  json: unknown;
  stderr: string;
}

/** A running forge child: `done` settles once it exited and its output closed; `stop` interrupts its whole process group. */
export interface ForgeRun {
  done: Promise<ForgeExit>;
  pid: number | null;
  /** SIGTERM to the group, SIGKILL after the grace; resolves once it exited. */
  stop(): Promise<void>;
  /** A message on its IPC channel; false without one, or once it is gone. */
  send(msg: unknown): boolean;
}

const STDOUT_CAP = 1024 * 1024;
const STDERR_CAP = 2000;
/** How long after the exit a child's output may take to close before its result is read as it is. */
const DRAIN_MS = 2000;

/**
 * One `forge <args> --json` child for the code driver (lib/office/code/job-driver.ts), with `env` as given (a job session's,
 * built by the caller), cwd `root`, argv only and never a shell. It leads its own process group (detached), so a stop
 * reaches the role child a runner started too, unless that one leads its own; with `onMessage` it gets an IPC channel.
 */
export function startForge(root: string, args: string[], o: { env: NodeJS.ProcessEnv; timeoutMs: number | null; graceMs: number; onMessage?: (m: unknown) => void }): ForgeRun {
  const stdio: ('ignore' | 'pipe' | 'ipc')[] = ['ignore', 'pipe', 'pipe'];
  if (o.onMessage) stdio.push('ipc');
  let stdout = '';
  let stdoutFull = false;
  let stderr = '';
  let exited = false;
  let killTimer: NodeJS.Timeout | null = null;
  let spawnError: string | null = null;
  const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'forge'), ...args, '--json'], { cwd: root, env: o.env, stdio, detached: true, windowsHide: true });
  const pid = typeof child.pid === 'number' ? child.pid : null;
  const group = (sig: NodeJS.Signals) => {
    if (exited || pid === null) return;
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {}
    }
  };
  const term = () => {
    group('SIGTERM');
    killTimer ??= setTimeout(() => group('SIGKILL'), o.graceMs);
  };
  const timeout = typeof o.timeoutMs === 'number' && o.timeoutMs > 0 ? setTimeout(term, o.timeoutMs) : null;
  child.stdout?.on('data', (d: Buffer) => {
    if (stdoutFull) return;
    stdout += d.toString('utf8');
    if (stdout.length > STDOUT_CAP) [stdout, stdoutFull] = ['', true];
  });
  child.stderr?.on('data', (d: Buffer) => {
    if (stderr.length < STDERR_CAP) stderr = (stderr + d.toString('utf8')).slice(0, STDERR_CAP);
  });
  if (o.onMessage) {
    const onMessage = o.onMessage;
    child.on('message', (m) => {
      try {
        onMessage(m);
      } catch {}
    });
  }
  const closed = (s: NodeJS.ReadableStream | null) => new Promise<void>((resolve) => (!s ? resolve() : (s.once('close', () => resolve()), s.once('error', () => resolve()))));
  const streams = Promise.all([closed(child.stdout), closed(child.stderr)]);
  const done = new Promise<ForgeExit>((resolve) => {
    const finish = async (exit: number | null, signal: NodeJS.Signals | null) => {
      exited = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      // Not 'close': it also waits on the IPC channel, which need not close with the process.
      let drain: NodeJS.Timeout | undefined;
      await Promise.race([streams, new Promise<void>((r) => (drain = setTimeout(r, DRAIN_MS)))]);
      clearTimeout(drain);
      resolve({ exit, signal, json: lastJson(stdoutFull ? '' : stdout), stderr: spawnError ?? stderr });
    };
    child.once('error', (e) => {
      spawnError = e.message;
      if (pid === null) void finish(null, null);
    });
    child.once('exit', (code, signal) => void finish(code, signal));
  });
  return {
    done,
    pid,
    stop: async () => {
      term();
      await done;
    },
    send: (msg) => {
      if (exited || !child.connected) return false;
      try {
        return child.send(msg as never);
      } catch {
        return false;
      }
    },
  };
}

/** The last non-empty line of `text` as JSON, or null. */
function lastJson(text: string): unknown {
  const line = text.trimEnd().split('\n').pop()?.trim();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
