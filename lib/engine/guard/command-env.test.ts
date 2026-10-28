// What a configured command inherits: the allowlist, the same in and out of the daemon,
// commandEnv.inherit's rules, and the shell argv per login setting and platform; and the PATH they get:
// sanitizePath's rules per platform, and the login-shell capture with test/fixtures/bin/fake-login-shell
// as $SHELL. In-process, apart from the fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adoptCommandPath, captureLoginPath, commandEnv, commandShell, loginShell, sanitizePath } from './command-env.ts';
import { PLUGIN_ROOT } from '#core/paths.ts';

const EXACT = [
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'CI',
  'GIT_CONFIG_COUNT', 'GIT_EDITOR', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_DIRS', 'XDG_DATA_DIRS',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'MSYSTEM',
];
const PATTERNS = ['LC_ALL', 'LC_CTYPE', 'NODE_ENV', 'NODE_EXTRA_CA_CERTS', 'FORGE_MODE', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_12'];
const DROPPED = [
  'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_REGION', 'AWS_PROFILE', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'NODE_OPTIONS', 'SSH_AUTH_SOCK',
  'DATABASE_URL', 'HTTP_PROXY', 'JAVA_HOME', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'XDG_RUNTIME_DIR', 'GIT_DIR', 'GIT_SSH_COMMAND', 'npm_config_registry',
  'CORP_SESSION_BLOB', 'FORGE_DAEMON_SCOPE', 'FORGE_DAEMON_TRUST', 'FORGE_PORT_WEB', 'FORGE_ENDPOINT_WEB', 'FORGE_BACKING_DB_URL',
  'FORGE_COMMAND_PATH_SOURCE', 'FORGE_API_TOKEN', 'LC_SECRET', 'NODE_REGISTRY_PASSWORD', 'FORGE_GH_PAT', 'GIT_CONFIG_PARAMETERS', 'Path', 'home',
  'NODE_APIKEY', 'FORGE_APIKEY', 'FORGE_SESSION', 'NODE_AUTH', 'FORGE_JWT', 'LC_COOKIE', 'FORGE_DB_PASS', 'NODE_ADMIN_PWD',
];

test('commandEnv passes only the allowlist, the same in and out of the daemon', () => {
  const kept = [...EXACT, ...PATTERNS];
  const base: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', ...Object.fromEntries([...kept, ...DROPPED].map((k) => [k, `v-${k}`])) };
  const before = structuredClone(base);
  const want = { PATH: '/usr/bin:/bin', ...Object.fromEntries(kept.map((k) => [k, `v-${k}`])) };
  assert.deepEqual(commandEnv({ secrets: {} }, base, 'linux'), want, 'interactive');
  assert.deepEqual(commandEnv({ secrets: {} }, { ...base, FORGE_DAEMON: '1' }, 'linux'), want, 'under the daemon');
  assert.deepEqual(base, before, 'base is not mutated');

  // The captured PATH wins over base.PATH, sanitised, and never reaches the command itself.
  const captured = commandEnv({ secrets: {} }, { PATH: '/usr/bin', FORGE_COMMAND_PATH: '/cap/bin:.::/cap/bin:/usr/bin', FORGE_COMMAND_PATH_SOURCE: 'login-shell (/bin/zsh)' }, 'linux');
  assert.deepEqual(captured, { PATH: '/cap/bin:/usr/bin' });
  assert.deepEqual(commandEnv({ secrets: {} }, { PATH: '/a:./node_modules/.bin:/a' }, 'linux'), { PATH: '/a' }, 'base.PATH is sanitised too');
  assert.deepEqual(commandEnv({ secrets: {} }, { HOME: '/h' }, 'linux'), { HOME: '/h' }, 'no PATH and no capture: no PATH');
});

test('commandEnv.inherit opts names back in, never internal variables, secret sources or credential-like glob matches', () => {
  const base = {
    JAVA_HOME: '/jdk',
    MY_JAVA_HOME: 'x',
    JAVA_KEYSTORE_PASSWORD: 'pw',
    DATABASE_URL: 'postgres://x',
    APP_SECRET_KEY: 'k',
    APP_NAME: 'a',
    APP_JWT: 'j',
    APP_SESSION: 's',
    APP_COOKIE: 'c',
    APP_APIKEY: 'k',
    DOCKER_HOST: 'unix:///d.sock',
    DOCKER_AUTH_CONFIG: '{}',
    DB_HOST: 'h',
    DB_PASS: 'p',
    DB_ADMIN_PWD: 'p',
    KUBE_NAMESPACE: 'n',
    KUBECONFIG: '/k',
    GH_HOST: 'github.com',
    GH_CONFIG_DIR: '/g',
    NETRC: '/n',
    npm_config_registry: 'https://r',
    'npm_config_//registry.npmjs.org/:_authToken': 't',
    CMDENV_DB_SRC: 'planted',
    CMDENV_OTHER: 'o',
    FORGE_DAEMON_SCOPE: 'j1',
    FORGE_DAEMON: '1',
    FORGE_BACKING_DB_URL: 'b',
    FORGE_COMMAND_PATH: '/cap',
  };
  const env = (inherit: unknown[], platform: NodeJS.Platform = 'linux', b: NodeJS.ProcessEnv = base) =>
    commandEnv({ secrets: { DB: { env: 'CMDENV_DB_SRC' } }, commandEnv: { inherit: inherit as string[] } }, b, platform);
  const keys = (e: NodeJS.ProcessEnv) => Object.keys(e).filter((k) => k !== 'PATH').sort();
  assert.deepEqual(keys(env(['JAVA_*', 'DATABASE_URL'])), ['DATABASE_URL', 'JAVA_HOME'], 'whole-name globs, never a credential-like match');
  assert.deepEqual(keys(env(['APP_SECRET_KEY'])), ['APP_SECRET_KEY'], 'an exact name always passes');
  assert.deepEqual(keys(env(['APP_*'])), ['APP_NAME'], 'a glob does not pass APP_SECRET_KEY, APP_JWT, APP_SESSION, APP_COOKIE or APP_APIKEY');
  assert.deepEqual(
    keys(env(['DOCKER_*', 'DB_*', 'KUBE*', 'GH_*', 'NETRC*', 'npm_config_*'])),
    ['DB_HOST', 'DOCKER_HOST', 'GH_HOST', 'KUBE_NAMESPACE', 'npm_config_registry'],
    'a glob never passes a name that holds or points at a credential',
  );
  assert.deepEqual(keys(env(['DOCKER_AUTH_CONFIG', 'KUBECONFIG', 'DB_PASS'])), ['DB_PASS', 'DOCKER_AUTH_CONFIG', 'KUBECONFIG'], 'exact names still pass');
  assert.deepEqual(keys(env(['CMDENV_*'])), ['CMDENV_OTHER'], 'a declared source never passes');
  assert.deepEqual(keys(env(['CMDENV_DB_SRC'])), [], 'not even by exact name');
  assert.deepEqual(keys(env(['FORGE_DAEMON*', 'FORGE_DAEMON', 'FORGE_BACKING_*', 'FORGE_COMMAND_PATH'])), [], 'internal variables never pass');
  assert.deepEqual(keys(env(['*', '**', '', 7, 'A B'])), [], 'entries validation refuses are ignored');
  assert.equal(env([]).PATH, '/cap', 'the capture is still the PATH');

  const win = { Path: 'C:\\a;;.\\x;C:\\A;D:\\b', JAVA_HOME: 'C:\\jdk', gh_token: 'g', SystemRoot: 'C:\\Windows', cmdenv_db_src: 'planted', Forge_Daemon: '1' };
  assert.deepEqual(env(['java_*', 'CMDENV_*'], 'win32', win), { Path: 'C:\\a;D:\\b', JAVA_HOME: 'C:\\jdk', SystemRoot: 'C:\\Windows' }, 'win32 folds names and keeps their spelling');
  assert.deepEqual(keys(env(['java_*'], 'linux', win)), [], 'off Windows names compare exactly');
});

test('commandShell runs /bin/sh -c unless commandEnv.loginShell', () => {
  const gitSh = 'C:\\Program Files\\Git\\bin\\sh.exe';
  const win = { platform: 'win32' as const, where: () => null, exists: (p: string) => p === gitSh };
  const rows: [string, Parameters<typeof commandShell>[1], { file: string; args: string[] }][] = [
    ['linux', { env: { SHELL: '/bin/zsh' }, platform: 'linux' }, { file: '/bin/sh', args: ['-c', 'cmd'] }],
    ['darwin', { env: { SHELL: '/bin/zsh' }, platform: 'darwin' }, { file: '/bin/sh', args: ['-c', 'cmd'] }],
    ['linux under the daemon', { env: { FORGE_DAEMON: '1', SHELL: '/bin/zsh' }, platform: 'linux' }, { file: '/bin/sh', args: ['-c', 'cmd'] }],
    ['darwin under the daemon', { env: { FORGE_DAEMON: '1', SHELL: '/bin/zsh' }, platform: 'darwin' }, { file: '/bin/sh', args: ['-c', 'cmd'] }],
    ['login: false', { env: { SHELL: '/bin/zsh' }, platform: 'linux', login: false }, { file: '/bin/sh', args: ['-c', 'cmd'] }],
    ['login', { env: { SHELL: '/bin/zsh' }, platform: 'darwin', login: true }, { file: '/bin/zsh', args: ['-lc', 'cmd'] }],
    ['login under the daemon', { env: { SHELL: '/bin/zsh', FORGE_DAEMON: '1' }, platform: 'linux', login: true }, { file: '/bin/zsh', args: ['-lc', 'cmd'] }],
    ['login with SHELL unset', { env: {}, platform: 'linux', login: true }, { file: '/bin/sh', args: ['-lc', 'cmd'] }],
    ['win32', { ...win, env: { ProgramFiles: 'C:\\Program Files' } }, { file: gitSh, args: ['-c', 'cmd'] }],
    ['win32 under the daemon', { ...win, env: { ProgramFiles: 'C:\\Program Files', FORGE_DAEMON: '1' } }, { file: gitSh, args: ['-c', 'cmd'] }],
    ['win32 login', { ...win, env: { ProgramFiles: 'C:\\Program Files' }, login: true }, { file: gitSh, args: ['-lc', 'cmd'] }],
  ];
  for (const [name, opts, want] of rows) assert.deepEqual(commandShell('cmd', opts), want, name);

  const cfg = (commandEnv: unknown) => ({ commandEnv }) as Parameters<typeof loginShell>[0];
  assert.equal(loginShell(cfg({ inherit: [], loginShell: true })), true);
  for (const v of [{ loginShell: false }, { loginShell: 'true' }, { loginShell: 1 }, {}, null, undefined]) assert.equal(loginShell(cfg(v)), false, JSON.stringify(v));
  assert.equal(loginShell(null), false);
});

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
    // A prompt or terminal escape with no newline of its own must not glue onto the first marker.
    const prompt = captureLoginPath({ env: { ...env, FAKE_SHELL_PROMPT: '\x1b]133;A\x07% ' } });
    assert.deepEqual(prompt, { path: `${bin}:/x/bin:/y`, source: `login-shell (${FAKE})` }, 'profile output without a trailing newline');

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
