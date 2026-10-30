// forge doctor's config checks that need no machine state, in-process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addProject } from '../project/machine-index.ts';
import type { ServiceOptions } from '../project/login-service.ts';
import { commandEnvCheck, commandPathCheck, daemonBillingCheck, daemonIsolationCheck, doctor, envCopyCheck, instructionsPolicyCheck, requiredChecksCheck } from './doctor.ts';
import { buildBundle } from './bundle.ts';
import { droppedVariables } from '../guard/command-env.ts';
import { defaults } from '#core/config/load.ts';
import type { Config, DoctorReport, ProtectedRule } from '#core/types.ts';
import type { BranchRules } from '#integrations/github/types.ts';
import { fakeBin, fakeGh, tempRepo } from '../../../test/helpers.ts';

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

test('doctor warns on deprecated and unknown config keys', async (t) => {
  if (process.platform === 'win32') return;
  const repo = tempRepo();
  const gh = fakeBin('gh', 'exit 1');
  const PATH = process.env.PATH;
  process.env.PATH = `${gh.dir}${path.delimiter}${PATH}`;
  t.after(() => {
    process.env.PATH = PATH;
    repo.cleanup();
  });
  fs.mkdirSync(path.join(repo.dir, '.forge'));
  fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), 'project:\n  notes: read by nobody\npiplene: {}\n');
  const report = await doctor(repo.dir, withPolicy(null), true);
  const rows = report.checks.filter((c) => /^(deprecated|unknown) config key /.test(c.name));
  assert.deepEqual(
    rows.map(({ name, ok, warn }) => ({ name, ok, warn })),
    [
      { name: 'deprecated config key project.notes', ok: true, warn: true },
      { name: 'unknown config key piplene', ok: true, warn: true },
    ],
  );
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

test('daemon billing warns about provider switches', () => {
  const cfg = (enabled: boolean, auth = 'subscription') => ({ daemon: { ...defaults().daemon, enabled, auth } }) as Pick<Config, 'daemon'>;
  assert.equal(daemonBillingCheck(cfg(false), { CLAUDE_CODE_USE_BEDROCK: '1' }), null, 'daemon off');
  assert.equal(daemonBillingCheck(cfg(true), { PATH: '/bin' }), null, 'none set');
  const bedrock = daemonBillingCheck(cfg(true), { CLAUDE_CODE_USE_BEDROCK: '1' });
  assert.deepEqual({ name: bedrock?.name, ok: bedrock?.ok, warn: bedrock?.warn }, { name: 'daemon billing', ok: true, warn: true });
  assert.match(bedrock!.detail, /^CLAUDE_CODE_USE_BEDROCK set but ignored/);
  const key = daemonBillingCheck(cfg(true), { ANTHROPIC_API_KEY: 'k' });
  assert.deepEqual({ ok: key?.ok, warn: key?.warn }, { ok: true, warn: undefined }, 'an API key alone is no warning');
  assert.match(daemonBillingCheck(cfg(true, 'api-key'), { ANTHROPIC_BASE_URL: 'http://proxy' })!.detail, /^ANTHROPIC_BASE_URL set: sessions bill that account or go through that endpoint/);
});

test('daemon isolation warns on a command that loads user settings', () => {
  const lean = defaults().daemon.command;
  const cfg = (enabled: boolean, command = lean) => ({ daemon: { ...defaults().daemon, enabled, command } }) as Pick<Config, 'daemon'>;
  const detail = 'daemon.command loads your user settings, plugins, hooks or MCP servers into every session: add --setting-sources project,local --strict-mcp-config (docs/CONFIG.md "Daemon")';
  const warns = {
    'no --strict-mcp-config': lean.replace(' --strict-mcp-config', ''),
    'no --setting-sources': lean.replace(' --setting-sources project,local', ''),
    'user among the sources': lean.replace('project,local', 'user,project'),
    'user in the = form': lean.replace('--setting-sources project,local', '--setting-sources=user'),
  };
  for (const [name, command] of Object.entries(warns)) assert.deepEqual(daemonIsolationCheck(cfg(true, command)), { name: 'daemon isolation', ok: true, warn: true, detail }, name);
  assert.equal(daemonIsolationCheck(cfg(true)), null, 'the default command');
  assert.equal(daemonIsolationCheck(cfg(true, lean.replace('project,local', "''"))), null, 'no source at all');
  assert.equal(daemonIsolationCheck(cfg(false, warns['no --strict-mcp-config'])), null, 'daemon off');
  assert.equal(daemonIsolationCheck(cfg(true, "claude 'unterminated")), null, 'a command that does not split is a config problem, not this row');
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
  assert.match(check.detail, /do not get HTTPS_PROXY; add the names they need to commandEnv\.inherit; /);
  assert.match(check.detail, /nor DATABASE_URL, which can carry credentials: .+ a config sink/, 'a credential carrier gets its own clause');
  for (const name of ['JAVA_HOME', 'GH_TOKEN', 'CMDENV_DB_SRC', 'HOME']) assert.ok(!check.detail.includes(name), `${name} is not listed`);
  assert.ok(!check.detail.includes('postgres://'), 'never a value');
  const quiet = commandEnvCheck(config, { JAVA_HOME: '/jdk', HOME: '/home/me', PATH: '/usr/bin' }, 'linux');
  assert.equal(quiet.ok, true);
  assert.equal(quiet.warn, undefined);
  const agent = commandEnvCheck(config, { SSH_AUTH_SOCK: '/tmp/agent.sock', PATH: '/usr/bin' }, 'linux');
  assert.equal(agent.warn, true);
  assert.match(agent.detail, /^configured commands do not get SSH_AUTH_SOCK, which can carry credentials: /);
  assert.ok(!agent.detail.includes('add the names they need'), 'no plain advice to inherit an SSH agent');

  // A support bundle names BUILD_LIKE's fixed names only and counts the rest.
  const machine = { ACME_CLIENT_SDK_HOME: '/opt/acme', CORP_TOOLS_ROOT: '/opt/corp', NVM_DIR: '/n', REDIS_URL: 'redis://x', PATH: '/usr/bin' };
  assert.match(commandEnvCheck(config, machine, 'linux').detail, /do not get ACME_CLIENT_SDK_HOME, CORP_TOOLS_ROOT, NVM_DIR; /);
  const bundled = commandEnvCheck(config, machine, 'linux', { bundle: true });
  assert.equal(bundled.warn, true);
  assert.match(bundled.detail, /do not get NVM_DIR, 2 more \*_HOME or \*_ROOT names; .+; nor REDIS_URL, which/);
  for (const name of ['ACME_CLIENT_SDK_HOME', 'CORP_TOOLS_ROOT']) assert.ok(!bundled.detail.includes(name), `${name} is counted, not named`);
  assert.match(commandEnvCheck(config, { CORP_TOOLS_ROOT: '/opt/corp' }, 'linux', { bundle: true }).detail, /do not get 1 \*_HOME or \*_ROOT name; /);

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

const PROTECT_DEVELOP =
  "gh api -X PUT 'repos/{owner}/{repo}/branches/develop/protection' -F 'required_status_checks[strict]=false' -f 'required_status_checks[contexts][]=<check name>' -F 'required_pull_request_reviews[required_approving_review_count]=1' -F enforce_admins=false -F restrictions=null";

test('merge required checks advice', () => {
  const keyed = defaults();
  keyed.merge.requiredChecks = ['test'];
  const empty = defaults();
  const read = (checks: BranchRules['checks'], reviews: number | null): BranchRules => ({ status: 'read', checks, reviews });
  const test1 = [{ name: 'test', appId: null }];
  const quiet: [string, Config, BranchRules | null][] = [
    ['the key set (protection not read)', keyed, null],
    ['a required check and a required review', empty, read(test1, 1)],
    ['a required check, the review count unknown', empty, read(test1, null)],
  ];
  for (const [name, config, rules] of quiet) {
    const row = requiredChecksCheck(config, 'develop', rules);
    assert.deepEqual([row.name, row.ok, row.warn], ['merge required checks', true, undefined], name);
  }
  const plain = `develop has no merge.requiredChecks and no protection rule with required checks and a required review, so Forge merges on whatever CI has reported; set merge.requiredChecks (docs/CONFIG.md "Merge"), or run: ${PROTECT_DEVELOP}`;
  const warns: [string, BranchRules, string][] = [
    ['required checks but no required review', read(test1, 0), plain],
    ['no required check', read([], 2), plain],
    ['no required check, the review count unknown', read([], null), plain],
    [
      'protection that could not be read',
      { status: 'unavailable', checks: [], reviews: null, error: 'gh: Resource not accessible by integration (HTTP 403)' },
      `could not read develop's branch protection (gh: Resource not accessible by integration (HTTP 403)) and merge.requiredChecks is empty, so Forge merges on whatever CI has reported; set merge.requiredChecks (docs/CONFIG.md "Merge"), or run: ${PROTECT_DEVELOP}`,
    ],
  ];
  for (const [name, rules, detail] of warns) assert.deepEqual(requiredChecksCheck(empty, 'develop', rules), { name: 'merge required checks', ok: true, warn: true, detail }, name);
  assert.match(requiredChecksCheck(empty, 'release/1.0', read([], 0)).detail, /branches\/release%2F1\.0\/protection'/, 'the base is encoded in the command');
});

test('doctor warns when the base has no required checks', { skip: process.platform === 'win32' }, async (t) => {
  const repo = tempRepo();
  const gh = fakeGh({
    'auth status': 'Logged in to github.com',
    '--version': 'gh version 2.60.0',
    'api repos/o/r/rules/branches/main?per_page=100': '[]',
    'api repos/o/r/branches/main': '{"protected":false}',
  });
  const PATH = process.env.PATH;
  process.env.PATH = `${gh.dir}${path.delimiter}${PATH}`;
  t.after(() => {
    process.env.PATH = PATH;
    repo.cleanup();
  });
  const config = defaults();
  config.tracker.kind = 'none';
  config.tracker.github.repo = 'o/r';
  const row = (await doctor(repo.dir, config, true)).checks.find((c) => c.name === 'merge required checks');
  assert.deepEqual([row?.ok, row?.warn], [true, true], JSON.stringify(row));
  assert.match(row?.detail ?? '', /^main has no merge\.requiredChecks and no protection rule/);
  assert.ok(gh.calls().some((c) => c.args.join(' ') === 'api repos/o/r/branches/main'), 'protection was read through gh');
});

test("a support bundle's doctor.json counts the variable names that say what a machine has", { skip: process.platform === 'win32' }, async (t) => {
  const repo = tempRepo();
  const gh = fakeBin('gh', 'exit 1');
  const saved = { PATH: process.env.PATH, ACME_CLIENT_SDK_HOME: process.env.ACME_CLIENT_SDK_HOME };
  process.env.PATH = `${gh.dir}${path.delimiter}${saved.PATH}`;
  process.env.ACME_CLIENT_SDK_HOME = '/opt/acme';
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    repo.cleanup();
  });
  const config = withPolicy(null);
  const detail = (r: DoctorReport) => r.checks.find((c) => c.name === 'command environment')?.detail ?? '';
  assert.match(detail(await doctor(repo.dir, config, true)), /ACME_CLIENT_SDK_HOME/, 'forge doctor names it');
  const { entries } = await buildBundle(repo.dir, config, true, { includeText: false });
  const report = JSON.parse(entries.find((e) => e.name === 'doctor.json')!.data.toString('utf8')) as DoctorReport;
  assert.match(detail(report), /\*_HOME or \*_ROOT names?; /);
  assert.ok(!detail(report).includes('ACME_CLIENT_SDK_HOME'), 'the bundle counts it');
});

test('doctor reports the login service once', { skip: process.platform === 'win32' }, async (t) => {
  const repo = tempRepo();
  const other = tempRepo();
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-svc-')));
  const gh = fakeBin('gh', 'exit 1');
  const PATH = process.env.PATH;
  process.env.PATH = `${gh.dir}${path.delimiter}${PATH}`;
  t.after(() => {
    process.env.PATH = PATH;
    repo.cleanup();
    other.cleanup();
    fs.rmSync(top, { recursive: true, force: true });
  });
  const forgeHome = path.join(top, 'fh');
  for (const r of [repo, other]) addProject(forgeHome, fs.realpathSync(r.dir));
  const calls: string[][] = [];
  const service: ServiceOptions = {
    platform: 'darwin',
    userHome: path.join(top, 'home'),
    forgeHome,
    env: {},
    execPath: '/opt/node/bin/node',
    pluginRoot: path.join(top, 'plugin'),
    uid: 501,
    run: (file, args) => (calls.push([file, ...args]), { ok: true, status: 0, stdout: '', stderr: '' }),
    probe: { platform: 'darwin', alive: () => false, startMs: () => null, command: () => null },
  };
  const rows = (await doctor(repo.dir, withPolicy(null), true, undefined, { service })).checks.filter((c) => c.name === 'service');
  assert.deepEqual(rows, [{ name: 'service', ok: true, detail: 'not installed (forge service install starts the dashboard at login); dashboard not running; no restart recorded' }]);
  assert.deepEqual(calls, [], 'nothing installed: no launchctl call');
});
