// The periodic `forge sync` child of `forge dash`: outside any daemon scope, as the human who started
// the dashboard, with git pinned (SYNC_PINS) so a hook or program the checkout's config names never
// runs on its fetches. docs/architecture/daemon.md "Periodic sync" describes it.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { PLUGIN_ROOT } from '#core/paths.ts';
import { SYNC_PINS, pinEnv } from '#integrations/git/runner.ts';

/** A sync that runs longer than this is killed; the next interval tries again. */
const SYNC_TIMEOUT_MS = 10 * 60_000;

/** The child's env: `env` pinned to `root` in agent mode, with no daemon marker or scope, and SYNC_PINS after any git config the caller set. */
export function syncChildEnv(root: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, FORGE_ROOT: root, FORGE_MODE: 'agent' };
  for (const k of Object.keys(out)) if (k.startsWith('FORGE_DAEMON')) delete out[k];
  return pinEnv(out, SYNC_PINS);
}

/**
 * One `forge sync` in a child process: it calls gh synchronously, which would stall every session's
 * pipe if it ran in the server. Resolves with null on success or the failure's message.
 */
export function runSyncChild(root: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return new Promise((resolve) => {
    let stderr = '';
    const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'forge'), 'sync'], { cwd: root, env: syncChildEnv(root, env), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => child.kill('SIGKILL'), SYNC_TIMEOUT_MS);
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
