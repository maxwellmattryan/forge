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

/** One `forge sync` in a child process (runForgeChild). */
export const runSyncChild = (root: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> => runForgeChild(root, ['sync'], env);

/** One Office pass in a child process (runForgeChild): it may call gh once per mandate milestone. */
export const runPassChild = (root: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> => runForgeChild(root, ['office', 'pass'], env);

/**
 * One `forge <args>` in a child process: sync and the pass call gh synchronously, which would stall every
 * session's pipe if they ran in the server. Resolves with null on success or the failure's message.
 */
export function runForgeChild(root: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return new Promise((resolve) => {
    let stderr = '';
    const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'forge'), ...args], { cwd: root, env: syncChildEnv(root, env), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
    timer.unref?.();
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 2000) stderr += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve(e.message);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve(code === 0 ? null : stderr.trim().split('\n').pop() || `exit ${code ?? signal}`);
    });
  });
}
