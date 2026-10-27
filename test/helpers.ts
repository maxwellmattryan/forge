import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { BIN, type CliResult } from './support/cli.ts';

// Tests import the shared helpers from here, never from test/support/ directly: this module's
// import side effects (below) are what pin git config, SHELL, FORGE_MODE and NODE_OPTIONS.
export { BIN, cliEnv, forgeSync, type CliResult } from './support/cli.ts';
export { fakeClaude, type FakeClaudeChild } from './support/claude-adapter.ts';
export { fakeBin } from './support/fake-bin.ts';
export { emptyState as fakeDockerState, handle as fakeDockerHandle } from './fixtures/fake-docker.mjs';
export { editConfigFile, gateAnswer, gateCost, gateHarness, type GateHarness } from './support/gate-runner.ts';
export { fakeGh, type GhReply } from './support/fake-gh.ts';
export { forgeInProcess, type InProcessResult } from './support/in-process.ts';
export { jobAt, parkedAt, withLease, withRound, type JobAtOptions } from './support/job-state.ts';
export { MILESTONE_DRAFT, draftJson, gateRequests, initMilestoneRepo, readyGoal, seedBacklog, writeDraftFile } from './support/milestone-draft.ts';
export { serveProjects, type ServedProjects } from './support/machine-server.ts';
export { ghPr, memoryGitHub, type GitHubCall, type MemoryGitHub } from './support/memory-github.ts';
export { recordingMoveEffects, type MoveEffectCall, type MoveSide } from './support/move-effects.ts';
export { FAKE_SCRIPT, SCRIPT_RELEASE, initScriptProject, readyGit, recordingSpawn, scriptCalls, setReleaseBlock } from './support/release-script.ts';

/**
 * Repo-local settings every scratch repo needs. A user's global `commit.gpgsign` would otherwise
 * make test commits depend on their GPG agent, which fails intermittently under parallel load.
 * @param {(...args: string[]) => unknown} git
 */
export function scratchGitConfig(git) {
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  // Git for Windows defaults to autocrlf=true, which rewrites what tests commit and compare byte for byte.
  git('config', 'core.autocrlf', 'false');
  // A detached `git maintenance run --auto` after a commit rewrites .git/objects while repoTemplate
  // copies the directory, and the copy fails with ENOENT.
  git('config', 'maintenance.auto', 'false');
  git('config', 'gc.auto', '0');
}

// Every test file that touches git imports this module, so pinning git's config here covers the
// suite's own git calls, the CLI it spawns and lib's run(): host settings such as commit.gpgsign
// (which fails under parallel test files) or core.hooksPath must not decide whether a test passes.
process.env.GIT_CONFIG_GLOBAL = path.resolve(import.meta.dirname, 'fixtures', 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
// A suite run from a daemon session (as `forge verify` is when the daemon drives a job) inherits
// the session's markers and git pins; the CLI it spawns would then apply daemon rules to scratch
// repos. Tests that exercise daemon mode set these themselves. A suite run through `forge run` or
// `forge verify` also inherits that job's FORGE_PORT_<C> / FORGE_ENDPOINT_<C>, which the CLI passes
// on to the scratch jobs' commands beside their own and which tests that read a command's env
// would otherwise count as the scratch job's own.
for (const k of Object.keys(process.env)) if (/^FORGE_(DAEMON|PORT|ENDPOINT|BACKING)(_|$)|^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) delete process.env[k];
// A suite run from a shell `forge dash` spawned inherits its captured PATH, which every CLI the suite
// starts would give its commands over the PATH the test chose. Tests of the capture set these themselves.
delete process.env.FORGE_COMMAND_PATH;
delete process.env.FORGE_COMMAND_PATH_SOURCE;
// Transcript lookups follow Claude Code's own CLAUDE_CONFIG_DIR; tests that fake a HOME must not
// read the developer's real one instead. Tests that need it set it themselves.
delete process.env.CLAUDE_CONFIG_DIR;
// Every human action resolves who did it, and without this the CLI would ask the developer's real
// gh. Tests of the fallbacks drop it in their own child env.
process.env.FORGE_ACTOR = 'forge-test';
// The machine index (`forge project add`) lives in ~/.forge by default: every test process gets its
// own, overriding any inherited FORGE_HOME, so the suite never writes the developer's. Tests of the
// default set HOME and drop FORGE_HOME in their own child env.
const FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-home-'));
process.env.FORGE_HOME = FORGE_HOME;
process.on('exit', () => fs.rmSync(FORGE_HOME, { recursive: true, force: true }));
// Every `forge dash` the suite starts would otherwise hold the developer's machine awake with a real
// caffeinate or systemd-inhibit. Tests of the sleep assertion pass startServer a fake spawn instead.
process.env.FORGE_KEEP_AWAKE = 'never';
// The suite parses the CLI's stdout, so a developer's own FORGE_MODE=human must not reach it.
process.env.FORGE_MODE = 'agent';
// Configured commands run as `/bin/sh -c`; `$SHELL -lc` only matters under commandEnv.loginShell: true
// and for the login-shell PATH `forge dash` captures. A login profile (nvm, for one) can cost a second
// per run and reorder PATH, and no test needs one, so those run in the same shell without -l.
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
  // A file: URL, because --import reads a bare Windows path (C:\...) as a URL with scheme c:.
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(pathToFileURL(STRIP_HOOK).href)}`.trim();
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
 * A bare repo inside the repo's own .git as its `origin`, with `main` pushed: the push remote a merge
 * re-reads the base from. Removed with the repo. Returns the bare repo's path.
 */
export function addOrigin(repo: ReturnType<typeof tempRepo>): string {
  const bare = path.join(repo.dir, '.git', 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'pipe' });
  repo.git('remote', 'add', 'origin', bare);
  repo.git('push', '-q', 'origin', 'main');
  return bare;
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

/**
 * A scratch dir `<repo root>/.cache/t-<rand>` (0700, real path) for a FORGE_CACHE_DIR test: the start-up
 * and seed caches honour the override only inside the plugin root, so a temp dir would be refused
 * before the permission checks a test means to exercise. `.cache` gets bin/forge's own `.gitignore`.
 */
export function cacheScratch(): { dir: string; cleanup: () => void } {
  const cacheDir = path.resolve(import.meta.dirname, '..', '.cache');
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(path.join(cacheDir, '.gitignore'), '*\n', { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(cacheDir, 't-')));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
