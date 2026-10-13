import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Repo-local settings every scratch repo needs. A user's global `commit.gpgsign` would otherwise
 * make test commits depend on their GPG agent, which fails intermittently under parallel load.
 * @param {(...args: string[]) => unknown} git
 */
export function scratchGitConfig(git) {
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
}

/** A throwaway git repo with one commit; FORGE_ROOT pins the CLI's main checkout to it. */
export function tempRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  scratchGitConfig(git);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return { dir, git, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
