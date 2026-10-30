// The code driver's `forge` children (startForge): each runs in a job's own scope, as a job session's, with an
// IPC channel when it relays prompts. Anything that runs git runs here, never in the server: git's helpers block
// the process. The periodic sync and Office pass children, and the intake runner's calls, are in ../inbox/children.ts.
// docs/architecture/daemon.md "Code driver" describes them.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { PLUGIN_ROOT } from '#core/paths.ts';

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
