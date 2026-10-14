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

// Every test file that touches git imports this module, so pinning git's config here covers the
// suite's own git calls, the CLI it spawns and lib's run(): host settings such as commit.gpgsign
// (which fails under parallel test files) or core.hooksPath must not decide whether a test passes.
process.env.GIT_CONFIG_GLOBAL = path.resolve(import.meta.dirname, 'fixtures', 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
// A suite run from a daemon session (as `forge verify` is when the daemon drives a job) inherits
// the session's markers and git pins; the CLI it spawns would then apply daemon rules to scratch
// repos. Tests that exercise daemon mode set these themselves.
for (const k of Object.keys(process.env)) if (/^FORGE_DAEMON(_|$)|^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) delete process.env[k];

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
