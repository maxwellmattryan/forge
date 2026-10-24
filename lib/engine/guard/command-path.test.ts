// The PATH configured commands get: sanitizePath's rules per platform, and the login-shell capture
// with test/fixtures/bin/fake-login-shell as $SHELL. In-process, apart from the fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adoptCommandPath, captureLoginPath, sanitizePath } from './command-path.ts';
import { PLUGIN_ROOT } from '#core/paths.ts';

const FAKE = path.join(PLUGIN_ROOT, 'test', 'fixtures', 'bin', 'fake-login-shell');

test('captureLoginPath reads the login shell\'s PATH and falls back to this process\'s', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-capture-'));
  try {
    const log = path.join(dir, 'calls.log');
    const bin = path.join(PLUGIN_ROOT, 'bin');
    // The fixture's sleep is /bin/sleep on macOS and /usr/bin/sleep on most Linux.
    const own = '/own/bin:.:/usr/bin:/bin';
    const env = { SHELL: FAKE, PATH: own, FAKE_SHELL_LOG: log, FAKE_SHELL_PATH: '/x/bin:.:/y::/x/bin' };
    assert.deepEqual(captureLoginPath({ env }), { path: `${bin}:/x/bin:/y`, source: `login-shell (${FAKE})` });
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.length, 1, 'one run');
    const [cwd, args] = calls[0].split('|');
    assert.equal(cwd, fs.realpathSync(os.homedir()), 'run in the home dir');
    assert.ok(args.startsWith('-lc '), args);

    const fallback = sanitizePath(own, 'linux', bin);
    const slow = captureLoginPath({ env: { ...env, FAKE_SHELL_SLEEP: '5' }, timeoutMs: 300 });
    assert.equal(slow.path, fallback);
    assert.match(slow.source, /^inherited: timed out/);
    const failed = captureLoginPath({ env: { ...env, FAKE_SHELL_EXIT: '3' } });
    assert.equal(failed.path, fallback);
    assert.match(failed.source, /^inherited: exited 3/);
    const silent = captureLoginPath({ env: { SHELL: FAKE, PATH: own, FAKE_SHELL_PATH: '' } });
    assert.equal(silent.path.split(':')[0], bin);
    assert.equal(silent.source, `login-shell (${FAKE})`, 'the real PATH when the profile changes nothing');

    fs.rmSync(log);
    assert.deepEqual(captureLoginPath({ env, platform: 'win32' }), { path: sanitizePath(own, 'win32', path.win32.join(PLUGIN_ROOT, 'bin')), source: 'inherited: win32' });
    assert.equal(fs.existsSync(log), false, 'nothing is spawned on win32');

    const target: NodeJS.ProcessEnv = { ...env };
    const got = adoptCommandPath(target);
    assert.equal(target.FORGE_COMMAND_PATH, got.path);
    assert.equal(target.FORGE_COMMAND_PATH_SOURCE, got.source);
    assert.equal(got.path, `${bin}:/x/bin:/y`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sanitizePath drops empty, relative and duplicate entries', () => {
  const rows: [string, string | undefined, NodeJS.Platform, string | undefined, string][] = [
    ['linux', '/a::.:./node_modules/.bin:/b:/a:rel/bin', 'linux', undefined, '/a:/b'],
    ['darwin keeps case', '/A:/a', 'darwin', undefined, '/A:/a'],
    ['win32 folds case and uses ;', 'C:\\a;;.\\x;C:\\A;D:\\b', 'win32', undefined, 'C:\\a;D:\\b'],
    ['first goes in front, its later copy dropped', '/a:/plugin/bin:/b', 'linux', '/plugin/bin', '/plugin/bin:/a:/b'],
    ['first on an empty PATH', '', 'linux', '/plugin/bin', '/plugin/bin'],
    ['nothing', undefined, 'linux', undefined, ''],
    ['only relative entries', '.:bin', 'linux', undefined, ''],
  ];
  for (const [name, value, platform, first, want] of rows) assert.equal(sanitizePath(value, platform, first), want, name);
});
