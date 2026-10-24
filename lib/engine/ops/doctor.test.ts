// forge doctor's config checks that need no machine state, in-process.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { commandEnvCheck, commandPathCheck, doctor, envCopyCheck, instructionsPolicyCheck } from './doctor.ts';
import { droppedVariables } from '../guard/command-env.ts';
import { defaults } from '#core/config/load.ts';
import type { Config, ProtectedRule } from '#core/types.ts';
import { fakeBin, tempRepo } from '../../../test/helpers.ts';

const CI_RULE: ProtectedRule = { paths: ['.github/workflows/**'], action: 'escalate', reason: 'CI/CD configuration' };

/** defaults() with `rules` as the configured policy, and no tracker or PRs, so doctor never asks gh. */
function withPolicy(rules: ProtectedRule[] | null): Config {
  const c = defaults();
  c.tracker.kind = 'none';
  c.pr.enabled = false;
  if (rules) c.policy.protectedPaths = rules;
  return c;
}

test('doctor hints at an existing policy that leaves instruction files out', async (t) => {
  assert.equal(instructionsPolicyCheck(withPolicy(null)), null, 'the default list covers every probe');
  assert.equal(instructionsPolicyCheck(withPolicy([])), null, 'an empty policy was turned off deliberately');

  const ci = instructionsPolicyCheck(withPolicy([CI_RULE]));
  assert.deepEqual(ci, {
    name: 'protected instruction files',
    ok: true,
    warn: true,
    detail:
      'policy.protectedPaths does not cover AGENTS.md, lib/AGENTS.md, CLAUDE.md, CLAUDE.local.md, .claude/settings.json, lib/.claude/skills/x/SKILL.md, .mcp.json: add an escalate rule for **/AGENTS.md, **/CLAUDE.md, **/CLAUDE.local.md, .claude, **/.claude/** and .mcp.json by hand (docs/CONFIG.md "Protected paths")',
  });
  const md = instructionsPolicyCheck(withPolicy([{ paths: ['**/*.md'], action: 'refuse', reason: 'docs' }]));
  assert.ok(md?.detail.startsWith('policy.protectedPaths does not cover .claude/settings.json, .mcp.json: '), md?.detail);

  // doctor() itself, with a gh that answers nothing, so the release row never reaches the network.
  if (process.platform === 'win32') return;
  const repo = tempRepo();
  const gh = fakeBin('gh', 'exit 1');
  const PATH = process.env.PATH;
  process.env.PATH = `${gh.dir}${path.delimiter}${PATH}`;
  t.after(() => {
    process.env.PATH = PATH;
    repo.cleanup();
  });
  const row = (c: Config) => doctor(repo.dir, c, true).then((r) => r.checks.find((x) => x.name === 'protected instruction files'));
  assert.deepEqual(await row(withPolicy([CI_RULE])), ci);
  assert.equal(await row(withPolicy(null)), undefined);
});

test('worktrees.copy that can copy .env files is a warning', () => {
  const cfg = (copy: string[]) => ({ worktrees: { copy } }) as unknown as Pick<Config, 'worktrees'>;
  const warns = [['.env'], ['apps/web/.env.local'], ['.envrc'], ['**/.env*'], ['.*'], ['config/.env/'], ['CLAUDE.md', '.env?production']];
  for (const copy of warns) {
    const check = envCopyCheck(cfg(copy));
    assert.ok(check, `${JSON.stringify(copy)} warns`);
    assert.equal(check.name, 'worktrees.copy');
    assert.equal(check.ok, true);
    assert.equal(check.warn, true);
    const hits = copy.filter((e) => e !== 'CLAUDE.md');
    for (const e of hits) assert.ok(check.detail.includes(e), `the detail names ${e}`);
    assert.ok(!check.detail.includes('CLAUDE.md'), 'an entry that cannot copy .env is not named');
    assert.match(check.detail, /secrets/);
  }
  for (const copy of [[], ['CLAUDE.md', 'packages/*/CLAUDE.md'], ['env'], ['*.md'], ['docs/*.txt'], ['.github/']]) assert.equal(envCopyCheck(cfg(copy)), null, `${JSON.stringify(copy)} is no warning`);
});

test('doctor reports the command PATH source and the variables commands do not get', () => {
  const config = defaults();
  config.secrets = { DB: { env: 'CMDENV_DB_SRC' } };
  config.commandEnv.inherit = ['JAVA_*'];
  const env = { JAVA_HOME: '/jdk', DATABASE_URL: 'postgres://x', HTTPS_PROXY: 'http://proxy', GH_TOKEN: 'gh', CMDENV_DB_SRC: 'db', HOME: '/home/me', PATH: '/usr/bin' };
  const check = commandEnvCheck(config, env, 'linux');
  assert.equal(check.name, 'command environment');
  assert.equal(check.ok, true);
  assert.equal(check.warn, true);
  assert.deepEqual(droppedVariables(config, env, 'linux'), ['DATABASE_URL', 'HTTPS_PROXY']);
  assert.match(check.detail, /DATABASE_URL, HTTPS_PROXY/);
  assert.match(check.detail, /commandEnv\.inherit/);
  for (const name of ['JAVA_HOME', 'GH_TOKEN', 'CMDENV_DB_SRC', 'HOME']) assert.ok(!check.detail.includes(name), `${name} is not listed`);
  assert.ok(!check.detail.includes('postgres://'), 'never a value');
  const quiet = commandEnvCheck(config, { JAVA_HOME: '/jdk', HOME: '/home/me', PATH: '/usr/bin' }, 'linux');
  assert.equal(quiet.ok, true);
  assert.equal(quiet.warn, undefined);

  const timedOut = commandPathCheck({ FORGE_COMMAND_PATH_SOURCE: 'inherited: timed out after 5 s', FORGE_COMMAND_PATH: '/a' }, 'linux');
  assert.equal(timedOut.name, 'command PATH');
  assert.equal(timedOut.ok, true);
  assert.equal(timedOut.warn, true);
  assert.match(timedOut.detail, /^inherited: timed out after 5 s/);
  const relative = commandPathCheck({ PATH: '/a:.' }, 'linux');
  assert.equal(relative.warn, true);
  assert.match(relative.detail, /^this process's PATH/);
  assert.match(relative.detail, /: \.$/);
  const captured = commandPathCheck({ FORGE_COMMAND_PATH_SOURCE: 'login-shell (/bin/zsh)', FORGE_COMMAND_PATH: '/a' }, 'linux');
  assert.equal(captured.warn, undefined);
  assert.equal(captured.detail, 'login-shell (/bin/zsh)');
  assert.equal(commandPathCheck({ FORGE_COMMAND_PATH_SOURCE: 'inherited: win32', Path: 'C:\\a' }, 'win32').warn, undefined, 'win32 is no failed capture');
});
