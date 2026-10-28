// The periodic children of `forge dash`, `forge sync` and the Office pass (`forge office pass`): outside
// any daemon scope, as the human who started the dashboard, with git pinned (SYNC_PINS) so a hook or
// program the checkout's config names never runs on their fetches. docs/architecture/daemon.md
// "Periodic sync" and "Periodic Office pass" describe them.
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
