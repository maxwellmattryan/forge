// A configured command's environment (envFor, jobEnv): commandEnv's allowlist plus the job's
// variables, the same in and out of the daemon; declared secret sources never reach it, even through
// commandEnv.inherit, and the session's git pins do. In-process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tempRepo } from '../../../test/helpers.ts';
import { envFor, jobEnv } from './job-command.ts';
import { defaults } from '#core/config/keys/defaults.ts';
import { sessionEnv } from '#integrations/claude/argv.ts';
import type { Config, Job } from '#core/types.ts';

const job = { id: 'j1', branch: 'forge/j1', base: 'main', port: null, ports: {}, components: [] } as unknown as Job;

/** A config that declares one secret of each kind; only the `env` one names a variable to strip. */
function configWithSecrets(inherit: string[] = []): Config {
  const config = defaults();
  config.secrets = {
    DB: { env: 'CMDENV_DB_SRC' },
    KC: { keychain: { service: 'KC_SERVICE' } },
    OP: { op: 'op://vault/item/OP_FIELD' },
    FILE: { file: 'FILE_SRC' },
  };
  config.commandEnv.inherit = inherit;
  return config;
}

test('envFor and jobEnv drop declared secret source variables in and out of the daemon', () => {
  // Inherited by name and by glob: only the `env` secret's source is a variable Forge reads a secret from.
  const config = configWithSecrets(['KC_SERVICE', 'OP_FIELD', 'FILE_SRC', 'UNRELATED', 'CMDENV_*']);
  const base = { CMDENV_DB_SRC: 'planted-db-value', KC_SERVICE: 'kept', OP_FIELD: 'kept', FILE_SRC: 'kept', UNRELATED: 'yes' };
  for (const daemon of [false, true]) {
    const input = daemon ? { ...base, FORGE_DAEMON: '1' } : { ...base };
    const before = { ...input };
    const env = envFor(config, job, '/wt/j1', 4100, input);
    assert.equal(env.CMDENV_DB_SRC, undefined, `daemon=${daemon}: the declared source is gone`);
    for (const k of ['KC_SERVICE', 'OP_FIELD', 'FILE_SRC', 'UNRELATED']) assert.equal(env[k], input[k as keyof typeof input], `daemon=${daemon}: ${k} is kept`);
    assert.deepEqual(input, before, 'base is not mutated');
  }

  // jobEnv reads this process's environment; nothing else in this file runs alongside.
  const repo = tempRepo();
  const saved = { CMDENV_DB_SRC: process.env.CMDENV_DB_SRC, FORGE_DAEMON: process.env.FORGE_DAEMON };
  try {
    process.env.CMDENV_DB_SRC = 'planted-db-value';
    for (const daemon of [false, true]) {
      if (daemon) process.env.FORGE_DAEMON = '1';
      else delete process.env.FORGE_DAEMON;
      const env = jobEnv(repo.dir, config, job, '/wt/j1', null);
      assert.equal(env.CMDENV_DB_SRC, undefined, `jobEnv daemon=${daemon}: the declared source is gone`);
      assert.equal(env.FORGE_JOB, 'j1');
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    repo.cleanup();
  }
});

test('envFor gives the allowlist plus the job\'s variables in both modes', () => {
  const config = configWithSecrets();
  const base = {
    PATH: '/usr/bin:.',
    HOME: '/home/me',
    GH_TOKEN: 'gh-value',
    NPM_TOKEN: 'npm-value',
    AWS_SECRET_ACCESS_KEY: 'aws-value',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    UNRELATED: 'yes',
    FORGE_DAEMON_TRUST: 'a'.repeat(64),
    FORGE_DAEMON_SCOPE: 'j1',
    FORGE_DAEMON_ANYTHING: 'x',
    FORGE_DAEMONISH: 'kept',
    FORGE_PORT_DASHBOARD: '4101',
    FORGE_ENDPOINT_DASHBOARD: 'http://localhost:4101',
    FORGE_BACKING_POSTGRES_URL: 'postgres://x',
    FORGE_PORTAL: 'kept',
    FORGE_JOB: 'outer-job',
  };
  const want = {
    PATH: '/usr/bin',
    HOME: '/home/me',
    FORGE_DAEMONISH: 'kept',
    FORGE_PORTAL: 'kept',
    FORGE_JOB: 'j1',
    FORGE_WORKTREE: '/wt/j1',
    PORT: '4100',
    FORGE_PORT: '4100',
  };
  for (const daemon of ['', '1']) {
    const input = { ...base, FORGE_DAEMON: daemon };
    const before = { ...input };
    assert.deepEqual(envFor(config, job, '/wt/j1', 4100, input), want, `FORGE_DAEMON=${JSON.stringify(daemon)}`);
    assert.deepEqual(input, before, 'base is not mutated');
  }
  const noPort = envFor(config, job, '/wt/j1', null, base);
  assert.equal(noPort.PORT, '');
  assert.equal(noPort.FORGE_PORT, '');
});

test('envFor keeps the session\'s git pins and drops its credentials', () => {
  const session = sessionEnv({
    PATH: '/usr/bin',
    GH_TOKEN: 'gh-value',
    NPM_TOKEN: 'npm-value',
    AWS_SECRET_ACCESS_KEY: 'aws-value',
    AWS_REGION: 'eu-west-1',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    ZDOTDIR: '/tmp/zdot',
    FORGE_DAEMON_SCOPE: 'j1',
  });
  assert.equal(session.FORGE_DAEMON, '1');
  const { FORGE_DAEMON: _marker, ...interactive } = session;
  for (const [mode, base] of [['daemon', session], ['interactive', interactive]] as const) {
    const env = envFor(configWithSecrets(), job, '/wt/j1', 4100, base);
    for (const k of ['GH_TOKEN', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'SSH_AUTH_SOCK', 'ZDOTDIR', 'FORGE_DAEMON', 'FORGE_DAEMON_SCOPE']) assert.equal(env[k], undefined, `${mode}: ${k} is dropped`);
    assert.equal(env.PATH, base.PATH, mode);
    assert.equal(env.GIT_EDITOR, base.GIT_EDITOR, mode);
    const count = Number(env.GIT_CONFIG_COUNT);
    assert.ok(count >= 2, 'the session pins git config');
    assert.equal(env.GIT_CONFIG_COUNT, base.GIT_CONFIG_COUNT);
    for (let i = 0; i < count; i++) {
      assert.equal(env[`GIT_CONFIG_KEY_${i}`], base[`GIT_CONFIG_KEY_${i}`], `${mode}: GIT_CONFIG_KEY_${i}`);
      assert.equal(env[`GIT_CONFIG_VALUE_${i}`], base[`GIT_CONFIG_VALUE_${i}`], `${mode}: GIT_CONFIG_VALUE_${i}`);
    }
    assert.equal(env.FORGE_JOB, 'j1');
    assert.equal(env.FORGE_WORKTREE, '/wt/j1');
    assert.equal(env.PORT, '4100');
    assert.equal(env.FORGE_PORT, '4100');
  }
});
