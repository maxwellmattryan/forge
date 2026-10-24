// What a configured command inherits: the daemon filter's table, commandEnv's daemon/interactive
// pair, and the shell argv per mode and platform. Pure and in-process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { commandEnv, commandShell, daemonDrops } from './command-env.ts';

test('the daemon filter drops credentials and keeps the rest', () => {
  const dropped = [
    'GH_TOKEN',
    'github_token',
    'NPM_TOKEN',
    'NODE_AUTH_TOKEN',
    'CARGO_REGISTRY_TOKEN',
    'CLIENT_SECRET',
    'SECRET_KEY_BASE',
    'PGPASSWORD',
    'OPENAI_API_KEY',
    'SIGNING_KEY',
    'GITLAB_PAT',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'OP_SESSION_my',
    'SSH_AUTH_SOCK',
    'DATABASE_URL',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'KUBECONFIG',
    'DOCKER_AUTH_CONFIG',
    'GH_CONFIG_DIR',
    'NETRC',
    'BASH_ENV',
    'ENV',
    'ZDOTDIR',
  ];
  const kept = ['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'PATH', 'HOME', 'SHELL', 'LANG', 'TMPDIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_EDITOR', 'KEYBOARD', 'NODE_OPTIONS'];
  for (const name of dropped) assert.equal(daemonDrops(name), true, `${name} is dropped`);
  for (const name of kept) assert.equal(daemonDrops(name), false, `${name} is kept`);

  const base = Object.fromEntries([...dropped, ...kept].map((k) => [k, 'v']));
  const interactive = commandEnv({ secrets: {} }, base);
  assert.deepEqual(Object.keys(interactive).sort(), Object.keys(base).sort(), 'outside the daemon the filter does not apply');
  const daemon = commandEnv({ secrets: {} }, { ...base, FORGE_DAEMON: '1' });
  assert.deepEqual(Object.keys(daemon).sort(), [...kept].sort(), 'under the daemon only the kept rows stay (the marker is stripped too)');
});

test('commandShell runs /bin/sh -c under the daemon and the login shell otherwise', () => {
  const gitSh = 'C:\\Program Files\\Git\\bin\\sh.exe';
  const win = { platform: 'win32' as const, where: () => null, exists: (p: string) => p === gitSh };
  const rows: [string, Parameters<typeof commandShell>[1], { file: string; args: string[] }][] = [
    ['daemon on linux', { env: { FORGE_DAEMON: '1', SHELL: '/bin/zsh' }, platform: 'linux' }, { file: '/bin/sh', args: ['-c', 'cmd'] }],
    ['daemon on darwin', { env: { FORGE_DAEMON: '1', SHELL: '/bin/zsh' }, platform: 'darwin' }, { file: '/bin/sh', args: ['-c', 'cmd'] }],
    ['daemon ignores login: false', { env: { FORGE_DAEMON: '1', SHELL: '/bin/zsh' }, platform: 'linux', login: false }, { file: '/bin/sh', args: ['-c', 'cmd'] }],
    ['no marker', { env: { SHELL: '/bin/zsh' }, platform: 'darwin' }, { file: '/bin/zsh', args: ['-lc', 'cmd'] }],
    ['a marker other than 1', { env: { FORGE_DAEMON: '0', SHELL: '/bin/zsh' }, platform: 'linux' }, { file: '/bin/zsh', args: ['-lc', 'cmd'] }],
    ['SHELL unset', { env: {}, platform: 'linux' }, { file: '/bin/sh', args: ['-lc', 'cmd'] }],
    ['login: false outside the daemon', { env: { SHELL: '/bin/zsh' }, platform: 'linux', login: false }, { file: '/bin/zsh', args: ['-c', 'cmd'] }],
    ['win32 without the marker', { ...win, env: { ProgramFiles: 'C:\\Program Files' } }, { file: gitSh, args: ['-lc', 'cmd'] }],
    ['win32 with the marker', { ...win, env: { ProgramFiles: 'C:\\Program Files', FORGE_DAEMON: '1' } }, { file: gitSh, args: ['-lc', 'cmd'] }],
  ];
  for (const [name, opts, want] of rows) assert.deepEqual(commandShell('cmd', opts), want, name);
});
