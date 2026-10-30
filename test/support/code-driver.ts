// A scratch repo under `daemon.driver: code` and a pool over it: in-memory claude children for the sessions (fakeClaude),
// the stub `claude` (test/fixtures/bin/claude) for role runs, test/fixtures/fake-roles.mjs writing each role's output, a
// fake `gh`, and a bare `origin`. The code driver's forge children are real processes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaults, loadConfig } from '#core/config/load.ts';
import { readInfo, sessionFiles } from '#core/job/session-files.ts';
import { createPool, type DaemonPool } from '#office/pool.ts';
import { BIN, cliEnv } from './cli.ts';
import { fakeClaude } from './claude-adapter.ts';
import { fakeGh } from './fake-gh.ts';

const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures');
export const STUB_CLAUDE = path.join(FIXTURES, 'bin', 'claude');
export const FAKE_ROLES = path.join(FIXTURES, 'fake-roles.mjs');

/** What the fake gh answers: the repo, no PR yet, and a created one. */
const GH_ROUTES = { 'repo view': 'o/r\n', 'pr list': '[]', 'pr create': 'https://github.com/o/r/pull/7\n' };

const template = (() => {
  let made: string | null = null;
  return (): string => {
    if (made) return made;
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-code-driver-template-')));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
    const answers = path.join(dir, '.answers.json');
    const command = defaults().daemon.command.replace('claude -p ', `${STUB_CLAUDE} -p `);
    fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, worktrees: { root: '../{repo}.wt' }, daemon: { command, enabled: true, driver: 'code' } }));
    execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: cliEnv(dir), stdio: 'pipe' });
    fs.rmSync(answers);
    git('add', '-A');
    git('commit', '-qm', 'forge');
    made = dir;
    process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
})();

export interface CodeDriverRig {
  root: string;
  pool: DaemonPool;
  /** The in-memory adapter the pool's sessions start their children with. */
  sessions: ReturnType<typeof fakeClaude>;
  gh: ReturnType<typeof fakeGh>;
  /** The env a test's own forge calls take: the fake gh first on PATH. */
  env: NodeJS.ProcessEnv;
  /** Every stub claude record (start or stdin line), oldest first. */
  stub(): any[];
  /** The scope's `forge-daemon` log lines. */
  log(scope: string): any[];
  /** The code driver's id in the scope's record. */
  driverId(scope: string): string | null;
}

/**
 * A copy of the template repo with an origin and a pool over it, closed and removed after the test. `env` reaches every
 * session and forge child (stub knobs such as FAKE_CLAUDE_EXIT); the pool polls every 100 ms and never syncs or
 * reconciles on a timer.
 */
export function codeDriverRig(t: { after: (fn: () => void | Promise<void>) => void }, o: { env?: NodeJS.ProcessEnv | ((root: string) => NodeJS.ProcessEnv); graceMs?: number } = {}): CodeDriverRig {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-code-driver-')));
  const root = path.join(parent, 'repo');
  fs.cpSync(template(), root, { recursive: true });
  const bare = path.join(parent, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'pipe' });
  execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: root, stdio: 'pipe' });
  assert.equal(loadConfig(root).config.daemon.driver, 'code');
  const gh = fakeGh(GH_ROUTES);
  const fakeLog = path.join(parent, 'stub.log');
  const claudeDir = path.join(parent, 'claude');
  fs.mkdirSync(claudeDir);
  const extra = { PATH: gh.env.PATH, FAKE_CLAUDE_LOG: fakeLog, FAKE_CLAUDE_ROLES: FAKE_ROLES, CLAUDE_CONFIG_DIR: claudeDir, ...(typeof o.env === 'function' ? o.env(root) : o.env) };
  const sessions = fakeClaude();
  const pool = createPool(root, { claude: sessions.adapter, env: { ...process.env, ...extra }, pollMs: 100, syncMs: 0, reconcileMs: 0, graceMs: o.graceMs ?? 2000, runPass: async () => null });
  t.after(async () => {
    await pool.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const lines = (file: string): any[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  }) : []);
  return {
    root,
    pool,
    sessions,
    gh,
    env: extra,
    stub: () => lines(fakeLog),
    log: (scope) => lines(sessionFiles(root, scope).log).filter((l) => l.type === 'forge-daemon'),
    driverId: (scope) => {
      const id = readInfo(sessionFiles(root, scope).info).driverId;
      return typeof id === 'string' ? id : null;
    },
  };
}

/** Whether a pid is gone. */
export function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}
