import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

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
// Transcript lookups follow Claude Code's own CLAUDE_CONFIG_DIR; tests that fake a HOME must not
// read the developer's real one instead. Tests that need it set it themselves.
delete process.env.CLAUDE_CONFIG_DIR;
// Forge runs configured commands as `$SHELL -lc`. A login profile (nvm, for one) can cost a second
// per command and reorder PATH, and no test needs one, so commands run in the same shell without -l.
const NO_LOGIN_SHELL = path.resolve(import.meta.dirname, 'fixtures', 'bin', 'no-login-shell');
if (process.env.SHELL !== NO_LOGIN_SHELL) {
  process.env.FORGE_TEST_SHELL = process.env.SHELL || '/bin/sh';
  process.env.SHELL = NO_LOGIN_SHELL;
}
// The suite starts the CLI thousands of times; on Node versions that cache compiled TypeScript this
// roughly halves each start. Entries are keyed by source content, so an edited file is never stale.
// The cache sits in this checkout's ignored node_modules/.cache, not a shared temp dir another user
// could fill first: its entries are code this process runs.
process.env.NODE_COMPILE_CACHE ??= path.resolve(import.meta.dirname, '..', 'node_modules', '.cache', 'forge', 'compile-cache');
// Node 22's compile cache skips TypeScript, so there every start strips lib/ again: 150 ms against
// 40 ms (newer Node gains less, about a quarter). The hook keeps stripped modules on disk;
// NODE_OPTIONS carries it into every node the suite starts (the CLI, and anything the CLI starts).
const STRIP_HOOK = path.resolve(import.meta.dirname, 'fixtures', 'strip-cache.mjs');
if (!process.env.FORGE_TEST_STRIP_CACHE) {
  process.env.FORGE_TEST_STRIP_CACHE = path.resolve(import.meta.dirname, '..', 'node_modules', '.cache', 'forge', 'strip-cache');
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(STRIP_HOOK)}`.trim();
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

/**
 * tempRepo's shape, built once per file by `init` and then copied for each caller: a directory copy
 * instead of git init, a commit and `forge init write` every time. Copies are made before any
 * worktree exists (worktrees record absolute paths), so `init` must not create one, and config that
 * names the repo should use `{repo}` (as `worktrees.root: ../{repo}.wt` does) rather than its path.
 * @param {(dir: string) => void} init
 */
export function repoTemplate(init: (dir: string) => void): () => ReturnType<typeof tempRepo> {
  let template: string | null = null;
  return () => {
    if (!template) {
      const t = tempRepo();
      init(t.dir);
      template = t.dir;
      process.on('exit', () => fs.rmSync(t.dir, { recursive: true, force: true }));
    }
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-')));
    fs.cpSync(template, dir, { recursive: true });
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    return { dir, git, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  };
}

/** What forgeAsync resolves to: the exit status (null when killed) and both streams. */
export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The CLI without blocking the event loop, so the tests of one file can overlap their spawns.
 * FORGE_ROOT pins it to `root`; `env` adds to (or overrides) the inherited environment.
 */
export function forgeAsync(root: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: root, ...env }, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (err as any).code : 0;
      resolve({ status: typeof code === 'number' ? code : null, stdout, stderr });
    });
  });
}

/**
 * Polls until `predicate` returns something truthy, and returns it: a fixed sleep is either too
 * short under load or wasted time when the machine is idle.
 */
export async function waitFor<T>(predicate: () => T | Promise<T>, { timeoutMs = 10_000, intervalMs = 25, what = 'condition' }: { timeoutMs?: number; intervalMs?: number; what?: string } = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await predicate();
    if (v) return v;
    if (Date.now() >= deadline) throw new Error(`waitFor: ${what} still false after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** The task.yml of a hidden check that copies `check/files/` in and runs `command`. */
export function evalTaskYml(name: string, command = 'true'): string {
  return [`title: ${name}`, `request: Do ${name}`, 'base: null', 'tags: []', 'check:', '  files: check/files', `  command: ${JSON.stringify(command)}`, ''].join('\n');
}

const evalRepo = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { build: 'true', test: 'true', lint: 'true' }, worktrees: { root: '../{repo}.wt' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
  for (const name of ['t', 'u']) {
    const tdir = path.join(dir, '.forge', 'evals', name);
    fs.mkdirSync(path.join(tdir, 'check', 'files'), { recursive: true });
    fs.writeFileSync(path.join(tdir, 'check', 'files', `${name}.txt`), `${name}\n`);
    fs.writeFileSync(path.join(tdir, 'task.yml'), evalTaskYml(name));
  }
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge and eval tasks'], { cwd: dir, stdio: 'pipe' });
});

/**
 * A scratch repo with Forge initialised (build, test and lint all `true`) and two committed eval
 * tasks, `t` and `u`. Its eval clones live in the `<dir>.wt` sibling, which cleanup removes too.
 */
export function evalScratch(): { dir: string; git: (...args: string[]) => Buffer; cleanup: () => void } {
  const r = evalRepo();
  return {
    dir: r.dir,
    git: r.git,
    cleanup: () => {
      r.cleanup();
      fs.rmSync(`${r.dir}.wt`, { recursive: true, force: true });
    },
  };
}
