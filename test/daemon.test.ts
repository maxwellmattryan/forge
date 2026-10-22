// lib/daemon.ts's pure helpers: permission grants and modes, effort in argv, the session env, the
// deny list, and marking agents lost. The pool that runs sessions is tested in
// test/integration/pool/daemon.test.ts, and `forge daemon` / `forge dash` in test/integration/cli/daemon.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoTemplate } from './helpers.ts';
import { defaults, resolveEffort } from '../lib/config.ts';
import { escapeControls } from '../lib/commands/daemon.ts';
import { createJob, loadJob, markAgentsLost, recordAgent, updateJob } from '../lib/jobs.ts';
import { DENY_TOOLS, GIT_PINS, PROMPT_TOOL, apiKeyVars, buildArgv, sessionEnv, sessionGrant, PERMISSION_MODES, commandPermissionMode, modeReach, withPermissionMode, withEffort, LOST_SUMMARY } from '../lib/daemon.ts';

/** A bare git repo, copied per test. */
const scratch = repoTemplate(() => {});

test('a session grant never widens a tool to its every call', () => {
  const rules = (list) => sessionGrant([{ type: 'addRules', behavior: 'allow', destination: 'session', rules: list }]).rules;
  assert.deepEqual(rules([{ toolName: 'Bash', ruleContent: 'cp:*' }, { toolName: 'WebFetch', ruleContent: 'domain:example.com' }]), [
    { toolName: 'Bash', ruleContent: 'cp:*' },
    { toolName: 'WebFetch', ruleContent: 'domain:example.com' },
  ]);
  assert.deepEqual(rules([{ toolName: 'Bash' }, { toolName: 'Edit' }]), [], 'a bare tool rule allows every call: dropped');
  assert.deepEqual(rules([{ toolName: 'Bash', ruleContent: '*' }, { toolName: 'Bash', ruleContent: ':*' }, { toolName: 'Bash', ruleContent: '**' }, { toolName: 'Bash', ruleContent: ' ' }, { toolName: 'Bash', ruleContent: '' }]), [], 'so does a wildcard-only pattern');
  assert.deepEqual(sessionGrant([{ type: 'addRules', behavior: 'deny', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }] }, { type: 'setMode', mode: 'bypassPermissions' }]).rules, [], 'deny rules and mode changes are never forwarded');
});

test('commandPermissionMode reads daemon.command, and a chosen mode replaces it in argv', () => {
  assert.equal(commandPermissionMode('claude {session}'), 'default', "claude's default when the flag is absent");
  assert.equal(commandPermissionMode('claude {session} --permission-mode dontAsk'), 'dontAsk');
  assert.equal(commandPermissionMode('claude {session} --permission-mode=plan'), 'plan');
  assert.equal(commandPermissionMode('claude {session} --permission-mode manual'), 'default', 'manual is the name claude now lists for default');
  assert.equal(commandPermissionMode(`claude "open`), 'default', 'an unparsable template');
  assert.equal(commandPermissionMode(undefined), 'default');
  const vars = { pluginRoot: '/p', session: { id: 'abc', resume: false }, allowedTools: ['Agent'] };
  const tail = ['--disallowedTools', DENY_TOOLS.join(','), ...PROMPT_TOOL];
  assert.deepEqual(buildArgv('c {session} --permission-mode default --x', { ...vars, permissionMode: 'auto' }), ['c', '--session-id', 'abc', '--x', '--permission-mode', 'auto', ...tail]);
  assert.deepEqual(buildArgv('c --permission-mode=dontAsk {session}', { ...vars, permissionMode: 'default' }), ['c', '--session-id', 'abc', '--permission-mode', 'default', ...tail]);
  assert.deepEqual(buildArgv('c {session}', { ...vars, permissionMode: 'dontAsk' }), ['c', '--session-id', 'abc', '--permission-mode', 'dontAsk', ...tail], 'appended when absent');
  assert.deepEqual(buildArgv('c {session} --permission-mode plan', { ...vars, permissionMode: null }), ['c', '--session-id', 'abc', '--permission-mode', 'plan', ...tail], "no choice keeps the template's");
  assert.deepEqual(withPermissionMode(['--permission-mode', 'x'], 'auto'), ['--permission-mode', 'x', '--permission-mode', 'auto'], 'the executable is never dropped');
  assert.deepEqual(PERMISSION_MODES, ['default', 'auto', 'dontAsk'], 'never bypassPermissions or acceptEdits');
});

test("an effective effort replaces daemon.command's --effort in argv", () => {
  const vars = { pluginRoot: '/p', session: { id: 'abc', resume: false }, allowedTools: ['Agent'] };
  const tail = ['--disallowedTools', DENY_TOOLS.join(','), ...PROMPT_TOOL];
  const level = (job, runtime) => {
    const c = defaults();
    c.runtime.effort = runtime;
    return resolveEffort(c, { effort: job }).level;
  };
  const high = buildArgv('c {session} --permission-mode default', { ...vars, permissionMode: 'auto', effort: level('high', 'medium') });
  assert.deepEqual(high, ['c', '--session-id', 'abc', '--permission-mode', 'auto', '--effort', 'high', ...tail], "after Forge's --permission-mode, before --disallowedTools");
  assert.equal(high.filter((w) => w === '--effort').length, 1);
  assert.deepEqual(buildArgv('c {session}', { ...vars, effort: level(null, 'medium') }), ['c', '--session-id', 'abc', '--effort', 'medium', ...tail], 'job null inherits runtime.effort');
  assert.deepEqual(buildArgv('c {session}', { ...vars, effort: level(null, null) }), ['c', '--session-id', 'abc', ...tail], 'nothing set: no --effort');
  assert.deepEqual(buildArgv('c {session} --effort low', { ...vars, effort: level(null, null) }), ['c', '--session-id', 'abc', '--effort', 'low', ...tail], "nothing set: the template's own stays");
  for (const template of ['c --effort low {session}', 'c {session} --effort=low', 'c --effort low {session} --effort=max --effort xhigh']) {
    for (const [job, runtime, want] of [['high', null, 'high'], [null, 'medium', 'medium'], ['max', 'low', 'max']]) {
      const argv = buildArgv(template, { ...vars, effort: level(job, runtime) });
      assert.deepEqual(argv, ['c', '--session-id', 'abc', '--effort', want, ...tail], `${template} with job ${job} / runtime ${runtime}`);
    }
  }
  assert.deepEqual(withEffort(['--effort', 'x'], 'high'), ['--effort', 'x', '--effort', 'high'], 'the executable is never dropped');
  for (const bad of ['ultra', '--dangerously-skip-permissions', 'high --add-dir /', '', 3, ['high']])
    assert.deepEqual(buildArgv('c {session}', { ...vars, effort: bad as any }), ['c', '--session-id', 'abc', ...tail], `${JSON.stringify(bad)} adds nothing`);
});

test('modeReach orders modes by what they allow without a human', () => {
  assert.ok(modeReach('dontAsk') < modeReach('default'));
  assert.equal(modeReach('plan'), modeReach('dontAsk'));
  assert.equal(modeReach('manual'), modeReach('default'));
  assert.ok(modeReach('default') < modeReach('auto'));
  assert.ok(modeReach('auto') < modeReach('bypassPermissions'), 'an unknown mode counts as the widest');
  assert.ok(modeReach('auto') < modeReach(null));
});

test('sessionEnv drops API keys unless daemon.auth is api-key', () => {
  const env = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-x', ANTHROPIC_AUTH_TOKEN: 'tok', OTHER: '1' };
  const sub = sessionEnv(env);
  assert.equal(sub.ANTHROPIC_API_KEY, undefined, 'the key would make claude bill the API account instead of the login');
  assert.equal(sub.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(sub.OTHER, '1');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-x', 'the caller\'s env is untouched');
  assert.deepEqual(sessionEnv(env, 'subscription').ANTHROPIC_API_KEY, undefined);
  const api = sessionEnv(env, 'api-key');
  assert.equal(api.ANTHROPIC_API_KEY, 'sk-ant-x');
  assert.equal(api.ANTHROPIC_AUTH_TOKEN, 'tok');
  assert.deepEqual(apiKeyVars(env), ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
  assert.deepEqual(apiKeyVars({ ANTHROPIC_API_KEY: '' }), [], 'an empty value does not count');
});

test('sessionEnv pins agent output mode', () => {
  assert.equal(sessionEnv({ PATH: '/usr/bin', FORGE_MODE: 'human' }).FORGE_MODE, 'agent', 'an inherited human mode is overridden');
  assert.equal(sessionEnv({ PATH: '/usr/bin' }).FORGE_MODE, 'agent', 'set even when the caller has none');
  assert.equal(sessionEnv({ PATH: '/usr/bin' }, 'api-key').FORGE_MODE, 'agent');
});

test('sessionEnv pins git hooks and fsmonitor off, after any config the caller exports', () => {
  const env = sessionEnv({ PATH: '/usr/bin', HOME: '/h' });
  assert.equal(env.HOME, '/h');
  assert.equal(env.FORGE_DAEMON, '1');
  assert.equal(env.GIT_EDITOR, 'true', 'git merge|rebase --continue never waits on an editor');
  assert.equal(env.GIT_CONFIG_COUNT, String(GIT_PINS.length));
  assert.deepEqual(GIT_PINS.map((_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]), [
    ['core.hooksPath', os.devNull],
    ['core.fsmonitor', 'false'],
  ]);
  const kept = sessionEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' });
  assert.equal(kept.GIT_CONFIG_KEY_0, 'safe.directory', "the caller's pins stay");
  assert.equal(kept.GIT_CONFIG_KEY_1, 'core.hooksPath');
  assert.equal(kept.GIT_CONFIG_COUNT, String(1 + GIT_PINS.length));
  assert.equal(sessionEnv({ GIT_CONFIG_COUNT: 'junk' }).GIT_CONFIG_COUNT, String(GIT_PINS.length));

  // A hook the session writes into a tracked core.hooksPath dir (not a Claude Code protected path) never runs.
  const repo = scratch();
  try {
    fs.mkdirSync(path.join(repo.dir, '.githooks'));
    const marker = path.join(repo.dir, 'hook-ran');
    fs.writeFileSync(path.join(repo.dir, '.githooks', 'pre-commit'), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    repo.git('config', 'core.hooksPath', '.githooks');
    const commit = (e) => spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'x'], { cwd: repo.dir, env: e, encoding: 'utf8' });
    assert.equal(commit(sessionEnv(process.env)).status, 0);
    assert.equal(fs.existsSync(marker), false, 'pinned: the hook is skipped');
    assert.equal(commit(process.env).status, 0);
    assert.equal(fs.existsSync(marker), true, 'unpinned control: the same hook runs');
  } finally {
    repo.cleanup();
  }
});

test('DENY_TOOLS covers the repo budget files', () => {
  for (const rule of ['Edit(.forge/runtime/spend.json)', 'Edit(.forge/runtime/audit.jsonl)']) assert.ok(DENY_TOOLS.includes(rule), rule);
});

test('marking agents lost stops when another session has claimed the job', () => {
  const repo = scratch();
  /** Makes the job's owner `session`, as `forge job claim` from that session would. */
  const ownBy = (id, session) => {
    const at = new Date().toISOString();
    updateJob(repo.dir, id, (j) => {
      j.lease = { driver: session, epoch: (j.lease?.epoch ?? 0) + 1, since: at, renewedAt: at, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
    });
  };
  try {
    const id = createJob(repo.dir, defaults(), { title: 'Job' }).id;
    const mine = crypto.randomUUID();
    ownBy(id, crypto.randomUUID());
    recordAgent(repo.dir, id, { role: 'builder', phase: 'start' }, defaults());
    assert.deepEqual(markAgentsLost(repo.dir, id, ['builder'], LOST_SUMMARY, defaults(), mine), []);
    assert.equal(loadJob(repo.dir, id).agents.builder.status, 'running');
    ownBy(id, mine);
    assert.deepEqual(markAgentsLost(repo.dir, id, ['builder'], LOST_SUMMARY, defaults(), mine), ['builder']);
    assert.equal(loadJob(repo.dir, id).agents.builder.status, 'lost');
  } finally {
    repo.cleanup();
  }
});

// Moved from the `forge daemon log` CLI test, which still proves no raw control character reaches the terminal.
test('escapeControls escapes C0, DEL and C1 control characters', () => {
  assert.equal(escapeControls('a\u0000b\u001bc\u0085d '), 'a\\u0000b\\u001bc\\u0085d ');
});
