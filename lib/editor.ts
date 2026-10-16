// The dashboard's Open in editor: which command runs, and the only directory it may be given.
// job.json's `worktree` is agent-writable (docs/ARCHITECTURE.md "Dashboard security"), so the
// path the editor gets is the job's own worktree under the worktrees root, resolved, or nothing.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { worktreeRoot } from './config.ts';
import type { Config, Job } from './types.ts';
import { ForgeError, splitWords } from './util.ts';

/**
 * FORGE_EDITOR from the human's own environment (trusted like $EDITOR), else `code`, split into
 * argv without a shell: `;`, `$(…)` and the like stay literal words.
 */
export function editorArgv(env: NodeJS.ProcessEnv = process.env): string[] {
  const argv = splitWords(env.FORGE_EDITOR?.trim() || 'code', 'FORGE_EDITOR');
  if (!argv.length || !argv[0]) throw new ForgeError('FORGE_EDITOR names no command');
  return argv;
}

const realDir = (p: string): string | null => {
  try {
    const real = fs.realpathSync(p);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
};

/**
 * The job's worktree resolved through symlinks, when it is exactly `<worktreesRoot>/<id>`: never
 * another job's, an arbitrary directory, a link out, or a value git or an editor reads as an option.
 * Null otherwise.
 */
export function containedWorktree(root: string, config: Config, job: Pick<Job, 'id' | 'worktree'>): string | null {
  const wt = job.worktree;
  if (typeof wt !== 'string' || !wt || wt.includes('\0') || !path.isAbsolute(wt)) return null;
  const real = realDir(wt);
  const base = realDir(worktreeRoot(root, config));
  if (real === null || base === null) return null;
  // Compared with the root's resolved path plus the id, so `<root>/<id>` itself can't be a link out.
  return real === path.join(base, job.id) ? real : null;
}

/**
 * Starts the editor detached with the directory as its last argument, no shell, and resolves once
 * it has spawned. A missing binary rejects with the spawn error (code ENOENT).
 */
export function openEditor(argv: string[], dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], [...argv.slice(1), dir], { shell: false, detached: true, stdio: 'ignore', cwd: dir });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });
}
