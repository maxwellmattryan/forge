import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.mjs';
import { defaults, loadConfig, validateConfig } from '../lib/config.mjs';
import { CONFIG_SCHEMA_VERSION, migrateConfig } from '../lib/schema.mjs';
import { migrate } from '../lib/commands/init.mjs';
import * as yaml from '../lib/yaml.mjs';

const DEFAULT_COMMAND =
  'claude -p --input-format stream-json --output-format stream-json --verbose --plugin-dir {pluginRoot} {session} --permission-mode dontAsk --allowedTools {allowedTools}';

test('AC1: defaults carry the daemon block and no dashboard.launcher', () => {
  const d = defaults();
  assert.deepEqual(d.daemon, {
    enabled: false,
    command: DEFAULT_COMMAND,
    allowedTools: ['Agent', 'Skill', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash(forge:*)', 'Bash(git:*)', 'Bash(gh:*)'],
    maxConcurrent: 1,
    idleStopMinutes: 30,
  });
  assert.deepEqual(d.dashboard, { port: 7400 });
  assert.equal(CONFIG_SCHEMA_VERSION, 2);
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
    assert.equal(loaded.config.schemaVersion, 2);
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
    assert.match(text, /^schemaVersion: 2$/m);
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
  one('maxConcurrent 2', (c) => (c.daemon.maxConcurrent = 2), /maxConcurrent must be 1/);
  one('idleStop 0', (c) => (c.daemon.idleStopMinutes = 0), /idleStopMinutes/);
  one('idleStop string', (c) => (c.daemon.idleStopMinutes = '30'), /idleStopMinutes/);
  one('idleStop negative', (c) => (c.daemon.idleStopMinutes = -1), /idleStopMinutes/);
  one('enabled string', (c) => (c.daemon.enabled = 'yes'), /daemon\.enabled/);
  one('leftover launcher', (c) => (c.dashboard.launcher = null), /^dashboard\.launcher/);
  assert.deepEqual(problems((c) => (c.daemon.idleStopMinutes = null)), [], 'null means never');
  assert.deepEqual(problems((c) => (c.daemon.idleStopMinutes = 0.5)), []);
});
