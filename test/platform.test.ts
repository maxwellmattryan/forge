// The support matrix (docs/SUPPORT.md): platform tiers, doctor's platform checks, the native Windows
// refusals and the POSIX sh resolver.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tempRepo } from './helpers.ts';
import { defaults } from '#core/config/load.ts';
import { createPool } from '#office/pool.ts';
import { doctor } from '#engine/ops/doctor.ts';
import { SUPPORT_URL, WINDOWS_DAEMON_REFUSAL, daemonPlatformProblem, platformTier, posixShell, versionAtLeast, whereExe } from '#core/os/platform.ts';
import { daemonPlatformNote, dashNotes } from '../lib/cli/commands/dash.ts';
import type { HostInfo } from '#core/os/platform.ts';
import { ForgeError } from '#core/errors.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };

const host = (platform: NodeJS.Platform, procVersion: string | null = null): HostInfo => ({ platform, arch: 'x64', procVersion });
const DARWIN = host('darwin');
const WSL = host('linux', 'Linux version 5.15.153.1-microsoft-standard-WSL2 (root@1234) (gcc (GCC) 11.2.0) #1 SMP');
const WIN = host('win32');
/** Config that needs no gh, so doctor never calls the real one. */
const noGh = () => {
  const c = defaults();
  c.pr.enabled = false;
  return c;
};

test('platformTier classifies each platform', () => {
  assert.equal(platformTier(DARWIN), 'supported');
  assert.equal(platformTier(host('linux', 'Linux version 6.8.0-45-generic (buildd@lcy02) (gcc 13.2.0) #45-Ubuntu SMP')), 'supported');
  assert.equal(platformTier(host('linux', null)), 'supported', 'an unreadable /proc/version is plain Linux');
  assert.equal(platformTier(WSL), 'supported-with-notes');
  assert.equal(platformTier(host('linux', 'Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com)')), 'supported-with-notes');
  assert.equal(platformTier(WIN), 'unsupported');
  assert.equal(platformTier(host('freebsd')), 'unsupported');
});

test('doctor puts the platform tier first', async () => {
  const repo = tempRepo();
  try {
    const config = noGh();
    for (const h of [DARWIN, WSL, WIN, host('freebsd'), host('linux')]) {
      const report = await doctor(repo.dir, config, false, h);
      assert.deepEqual(Object.keys(report), ['ok', 'checks']);
      assert.equal(report.checks[0].name, 'platform', h.platform);
    }
    const mac = (await doctor(repo.dir, config, false, DARWIN)).checks[0];
    assert.equal(mac.ok, true);
    assert.match(mac.detail, /^supported: macOS \(darwin x64\)$/);
    assert.match((await doctor(repo.dir, config, false, host('linux'))).checks[0].detail, /^supported: Linux/);
    const wsl = (await doctor(repo.dir, config, false, WSL)).checks[0];
    assert.equal(wsl.ok, true);
    assert.match(wsl.detail, /^supported with notes: WSL2/);
    const win = await doctor(repo.dir, config, false, WIN);
    assert.equal(win.ok, false, 'an unsupported platform fails doctor');
    assert.equal(win.checks[0].ok, false);
    assert.match(win.checks[0].detail, /^unsupported:/);
    assert.match(win.checks[0].detail, /daemon and forge update are refused/);
    assert.ok(win.checks[0].detail.endsWith(SUPPORT_URL), win.checks[0].detail);
    // On native Windows doctor also says whether the templates' sh resolves.
    const sh = win.checks.find((c) => c.name === 'POSIX sh (command templates)');
    assert.ok(sh, 'the sh check on win32');
    assert.equal(win.checks.indexOf(sh), 1);
    assert.equal((await doctor(repo.dir, config, false, DARWIN)).checks.some((c) => c.name === 'POSIX sh (command templates)'), false);
    const bsd = (await doctor(repo.dir, config, false, host('freebsd'))).checks[0];
    assert.equal(bsd.ok, false);
    assert.match(bsd.detail, /^unsupported:/);
    assert.ok(bsd.detail.endsWith(SUPPORT_URL));
  } finally {
    repo.cleanup();
  }
});

test('doctor warns about /mnt/ on WSL2 only', async () => {
  const NAME = 'repo on the Linux filesystem (WSL2)';
  const repo = tempRepo();
  try {
    const config = noGh();
    const check = async (root: string, cfg = config, h = WSL) => (await doctor(root, cfg, false, h)).checks.find((c) => c.name === NAME);

    const fine = await check(repo.dir);
    assert.ok(fine, 'the check is there on WSL');
    assert.equal(fine.ok, true);
    assert.equal((await doctor(repo.dir, config, false, WSL)).checks[1].name, NAME, 'right after the platform');

    // The repo itself on a Windows drive: its worktrees root (../{repo}.worktrees) is there too.
    const onC = await check('/mnt/c/Users/me/repo');
    assert.equal(onC?.ok, false);
    assert.ok(onC.detail.includes('/mnt/c/Users/me/repo'), onC.detail);
    assert.ok(onC.detail.includes('/mnt/c/Users/me/repo.worktrees'), onC.detail);
    assert.match(onC.detail, /Linux home/);
    assert.ok(onC.detail.endsWith(SUPPORT_URL));

    // Only the worktrees root on a Windows drive.
    const cfg = noGh();
    cfg.worktrees.root = '/mnt/d/worktrees/{repo}';
    const wt = await check(repo.dir, cfg);
    assert.equal(wt?.ok, false);
    assert.ok(wt.detail.startsWith(`/mnt/d/worktrees/${path.basename(repo.dir)} under /mnt/`), wt.detail);
    assert.ok(!wt.detail.includes(fs.realpathSync(repo.dir) + ','), 'the repo itself is not named');

    // A path that merely contains /mnt/ is not on a Windows drive.
    const nested = noGh();
    nested.worktrees.root = path.join(repo.dir, 'mnt', 'x');
    assert.equal((await check(repo.dir, nested))?.ok, true);

    assert.equal(await check('/mnt/c/Users/me/repo', config, DARWIN), undefined, 'absent on darwin');
    assert.equal(await check('/mnt/c/Users/me/repo', config, host('linux')), undefined, 'absent on plain Linux');
  } finally {
    repo.cleanup();
  }
});

test('versionAtLeast and the git/gh minimums', POSIX, async () => {
  assert.equal(versionAtLeast('git version 2.39.5 (Apple Git-154)', [2, 38]), true);
  assert.equal(versionAtLeast('git version 2.45.1.windows.1', [2, 38]), true);
  assert.equal(versionAtLeast('gh version 2.40.0 (2023-12-07)\nhttps://github.com/cli/cli/releases/tag/v2.40.0', [2, 40]), true);
  assert.equal(versionAtLeast('git version 2.37.9', [2, 38]), false);
  assert.equal(versionAtLeast('git version 2.38.0', [2, 38]), true);
  assert.equal(versionAtLeast('git version 3.0.0', [2, 38]), true);
  assert.equal(versionAtLeast('gh version 2.4.0', [2, 40]), false, '2.4 is older than 2.40');
  assert.equal(versionAtLeast('gh version 1.99.0', [2, 40]), false);
  for (const garbage of ['', 'git version', 'not a version', 'v2', '2.']) assert.equal(versionAtLeast(garbage, [2, 38]), false, garbage);
  assert.equal(versionAtLeast(`${'1'.repeat(10_000)}x`, [2, 38]), false, 'a long hostile line');

  const repo = tempRepo();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gh-'));
  const PATH = process.env.PATH;
  try {
    const names = (r: { checks: { name: string }[] }) => r.checks.map((c) => c.name);
    const plain = await doctor(repo.dir, noGh(), false, DARWIN);
    const git = plain.checks.find((c) => c.name === 'git >= 2.38');
    assert.ok(git, 'the git check names its minimum');
    assert.match(git.detail, /^git version \d+\.\d+/);
    assert.ok(!names(plain).includes('git'));
    assert.ok(!names(plain).includes('gh >= 2.40'), 'no gh check when gh is not needed');

    const needsGh = defaults();
    assert.equal(needsGh.pr.enabled, true);
    // A gh stub first on PATH: an old one, then a current one.
    const stub = (version: string) => {
      fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nif [ "$1" = --version ]; then echo "gh version ${version} (2023-12-07)"; else echo "Logged in"; fi\n`, { mode: 0o755 });
    };
    process.env.PATH = `${bin}${path.delimiter}${PATH}`;
    stub('2.39.1');
    const old = await doctor(repo.dir, needsGh, false, DARWIN);
    const auth = names(old).indexOf('gh installed + authenticated');
    assert.ok(auth !== -1);
    assert.equal(old.checks[auth + 1].name, 'gh >= 2.40', 'right after the auth check');
    assert.equal(old.checks[auth + 1].ok, false);
    assert.equal(old.checks[auth + 1].detail, 'gh version 2.39.1 (2023-12-07)');
    stub('2.40.0');
    assert.equal((await doctor(repo.dir, needsGh, false, DARWIN)).checks[auth + 1].ok, true);

    // gh needed but not installed: only the existing auth check, failing.
    fs.rmSync(path.join(bin, 'gh'));
    process.env.PATH = bin;
    const missing = await doctor(repo.dir, needsGh, false, DARWIN);
    assert.ok(names(missing).includes('gh installed + authenticated'));
    assert.ok(!names(missing).includes('gh >= 2.40'), 'no version check without gh');
  } finally {
    process.env.PATH = PATH;
    fs.rmSync(bin, { recursive: true, force: true });
    repo.cleanup();
  }
});

test('the pool refuses to start on native Windows', async () => {
  const repo = tempRepo();
  let spawned = 0;
  const spawn: any = () => {
    spawned++;
    const c: any = new EventEmitter();
    Object.assign(c, { pid: 4_100_000 + spawned, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    return c;
  };
  const killTree = (c: any) =>
    setImmediate(() => {
      c.stdout.end();
      c.stderr.end();
      c.emit('exit', null, 'SIGTERM');
      c.emit('close', null, 'SIGTERM');
    });
  const cfg = defaults();
  cfg.daemon.enabled = true;
  const pool = (platform: NodeJS.Platform) => createPool(repo.dir, { platform, spawn, killTree, loadConfig: () => ({ config: cfg }), pollMs: 3_600_000, graceMs: 100 });
  const win = pool('win32');
  try {
    const state = win.start('boot');
    assert.equal(state.lastError, WINDOWS_DAEMON_REFUSAL);
    assert.equal(state.wanted, false);
    assert.equal(spawned, 0, 'nothing is spawned');
    // Every later start (the dashboard's Start button) is refused the same way.
    assert.equal(win.start('start').lastError, WINDOWS_DAEMON_REFUSAL);
    assert.deepEqual(win.startSession('inbox'), { error: 'start the daemon first' });
    assert.equal(spawned, 0);
  } finally {
    await win.close();
  }
  const mac = pool('darwin');
  try {
    const state = mac.start('boot');
    assert.equal(state.lastError, null);
    assert.equal(state.wanted, true);
    assert.equal(spawned, 1, 'the inbox session starts');
  } finally {
    await mac.close();
    repo.cleanup();
  }
  assert.equal(daemonPlatformProblem('win32'), WINDOWS_DAEMON_REFUSAL);
  assert.ok(WINDOWS_DAEMON_REFUSAL.endsWith(SUPPORT_URL));
  for (const p of ['darwin', 'linux', 'freebsd'] as const) assert.equal(daemonPlatformProblem(p), null, p);
});

test('forge dash notes the daemon refusal on native Windows only', async () => {
  const on = defaults();
  on.daemon.enabled = true;
  const off = defaults();
  off.daemon.enabled = false;
  assert.equal(daemonPlatformNote(on, {}, 'win32'), WINDOWS_DAEMON_REFUSAL);
  assert.equal(daemonPlatformNote(on, { background: true }, 'win32'), WINDOWS_DAEMON_REFUSAL);
  assert.equal(daemonPlatformNote(on, { dev: true }, 'win32'), null, 'a dev dashboard boots no daemon');
  assert.equal(daemonPlatformNote(off, {}, 'win32'), null, 'nothing to refuse without the daemon');
  for (const p of ['darwin', 'linux'] as const) assert.equal(daemonPlatformNote(on, {}, p), null, p);

  // An API key in the shell and no daemon.auth in config.yml: off Windows that asks the billing question
  // (here, non-interactively, a note); on Windows nothing asks it, because no session will run.
  const repo = tempRepo();
  const key = process.env.ANTHROPIC_API_KEY;
  try {
    fs.mkdirSync(path.join(repo.dir, '.forge'), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), 'daemon:\n  enabled: true\n');
    process.env.ANTHROPIC_API_KEY = ['sk', 'test', 'placeholder'].join('-');
    const mac = await dashNotes(repo.dir, on, {}, 'darwin');
    assert.equal(mac.daemonRefused, undefined);
    assert.match(mac.note ?? '', /daemon sessions run on your Claude login/);
    assert.deepEqual(await dashNotes(repo.dir, on, {}, 'win32'), { daemonRefused: WINDOWS_DAEMON_REFUSAL }, 'the billing question is skipped');
    assert.deepEqual(await dashNotes(repo.dir, on, { dev: true }, 'win32'), {});
  } finally {
    if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = key;
    repo.cleanup();
  }
});

test('posixShell resolves sh per platform', () => {
  // Off Windows: $SHELL, else /bin/sh, exactly as before.
  assert.equal(posixShell({ platform: 'darwin', env: { SHELL: '/bin/zsh' } }), '/bin/zsh');
  assert.equal(posixShell({ platform: 'linux', env: {} }), '/bin/sh');
  assert.equal(posixShell({ platform: 'linux', env: { SHELL: '' } }), '/bin/sh');
  assert.equal(posixShell(), process.platform === 'win32' ? posixShell({ platform: 'win32' }) : process.env.SHELL || '/bin/sh');

  // On Windows $SHELL (an MSYS path under Git Bash) is ignored.
  const calls: string[] = [];
  const where = (found: string | null) => (cmd: string) => {
    calls.push(cmd);
    return found;
  };
  const never = () => assert.fail('exists is not consulted when where finds sh');
  const env = { SHELL: '/usr/bin/bash', ProgramFiles: 'D:\\Apps' };
  assert.equal(posixShell({ platform: 'win32', env, where: where('C:\\Program Files\\Git\\usr\\bin\\sh.exe'), exists: never }), 'C:\\Program Files\\Git\\usr\\bin\\sh.exe');
  assert.deepEqual(calls, ['sh']);

  // where.exe itself is spawned by absolute path, so one planted in the repo never runs.
  assert.equal(whereExe({ SystemRoot: 'D:\\WINDOWS' }), 'D:\\WINDOWS\\System32\\where.exe');
  assert.equal(whereExe({}), 'C:\\Windows\\System32\\where.exe');

  // Not on PATH: Git for Windows' own location under %ProgramFiles%.
  const seen: string[] = [];
  const bundled = posixShell({ platform: 'win32', env, where: where(null), exists: (p) => (seen.push(p), true) });
  assert.equal(bundled, 'D:\\Apps\\Git\\bin\\sh.exe');
  assert.deepEqual(seen, ['D:\\Apps\\Git\\bin\\sh.exe']);
  assert.equal(posixShell({ platform: 'win32', env: {}, where: where(null), exists: () => true }), 'C:\\Program Files\\Git\\bin\\sh.exe');

  // Neither: a ForgeError that says why and where to read more.
  assert.throws(
    () => posixShell({ platform: 'win32', env, where: where(null), exists: () => false }),
    (e: unknown) => {
      assert.ok(e instanceof ForgeError);
      assert.equal(e.exitCode, 1);
      assert.match(e.message, /POSIX sh/);
      assert.match(e.message, /Git for Windows \(Git Bash\)/);
      assert.match(e.message, /WSL2/);
      assert.ok(e.message.includes(SUPPORT_URL));
      return true;
    },
  );
});

test('scratch repos never convert line endings', () => {
  assert.match(read('test/fixtures/gitconfig'), /^\[core\]\n\tautocrlf = false$/m);
  assert.match(read('.gitattributes'), /^\* text=auto eol=lf$/m);
  const repo = tempRepo();
  try {
    assert.equal(String(repo.git('config', '--local', 'core.autocrlf')).trim(), 'false');
    // A CRLF file goes in and comes back out byte for byte.
    const file = path.join(repo.dir, 'crlf.txt');
    fs.writeFileSync(file, 'a\r\nb\r\n');
    repo.git('add', 'crlf.txt');
    repo.git('commit', '-qm', 'crlf');
    assert.equal(String(repo.git('cat-file', '-p', 'HEAD:crlf.txt')), 'a\r\nb\r\n');
    fs.rmSync(file);
    repo.git('checkout', '--', 'crlf.txt');
    assert.equal(fs.readFileSync(file, 'utf8'), 'a\r\nb\r\n');
  } finally {
    repo.cleanup();
  }
});
