// The periodic children of `forge dash`, `forge sync` and the Office pass (`forge office pass`): outside
// any daemon scope, as the human who started the dashboard, with git pinned (SYNC_PINS) so a hook or
// program the checkout's config names never runs on their fetches. docs/architecture/daemon.md
// "Periodic sync" and "Periodic Office pass" describe them. Its process runner (runChildOutput, which keeps
// stdout) also runs an office run's CLI children (lib/office/foreman/runs/cli.ts), under their own env.
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
export async function runChild(file: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; stop?: ChildStop | undefined }): Promise<string | null> {
  const r = await runChildOutput(file, args, o);
  if (r.error !== null) return r.error;
  return r.code === 0 ? null : r.stderr.trim().split('\n').pop() || `exit ${r.code ?? r.signal}`;
}

/** The most stdout runChildOutput keeps; a child that prints more is killed and reported as cut. */
export const STDOUT_MAX = 4 * 1024 * 1024;

/** How a child ended: its code or signal, its stdout (when asked for), its first 2000 characters of stderr, and a spawn error or a cut stdout. */
export interface ChildOutput {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** The spawn's error message, or why stdout was cut; null otherwise. */
  error: string | null;
  /** It ran past CHILD_TIMEOUT_MS (or `timeoutMs`) and was killed. */
  timedOut: boolean;
}

/**
 * runChild's process, with its stdout kept (at most STDOUT_MAX: a child that prints more is killed) when
 * `stdout` is true: the office runs' CLI children print one JSON value there.
 */
export function runChildOutput(
  file: string,
  args: string[],
  o: { cwd: string; env: NodeJS.ProcessEnv; stop?: ChildStop | undefined; stdout?: boolean; timeoutMs?: number },
): Promise<ChildOutput> {
  return new Promise((resolve) => {
    let stderr = '';
    const out: Buffer[] = [];
    let outBytes = 0;
    let cut: string | null = null;
    let timedOut = false;
    let settled = false;
    let grace: NodeJS.Timeout | null = null;
    const child = spawn(file, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', o.stdout ? 'pipe' : 'ignore', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, o.timeoutMs ?? CHILD_TIMEOUT_MS);
    timer.unref?.();
    // Not spawn's own `signal` option: that sends one signal and never escalates to SIGKILL.
    const onAbort = () => {
      child.kill('SIGTERM');
      grace ??= setTimeout(() => child.kill('SIGKILL'), o.stop!.graceMs);
    };
    const finish = (r: Omit<ChildOutput, 'stdout' | 'stderr' | 'timedOut'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      o.stop?.signal.removeEventListener('abort', onAbort);
      resolve({ ...r, error: r.error ?? cut, stdout: Buffer.concat(out).toString('utf8'), stderr, timedOut });
    };
    child.stdout?.on('data', (d: Buffer) => {
      if (cut !== null) return;
      outBytes += d.length;
      if (outBytes > STDOUT_MAX) {
        cut = `stdout passed ${STDOUT_MAX / 1024 / 1024} MiB`;
        child.kill('SIGKILL');
        return;
      }
      out.push(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 2000) stderr += d.toString('utf8');
    });
    child.on('error', (e) => finish({ code: null, signal: null, error: e.message }));
    child.on('close', (code, signal) => finish({ code, signal, error: null }));
    if (o.stop?.signal.aborted) onAbort();
    else o.stop?.signal.addEventListener('abort', onAbort, { once: true });
  });
}
