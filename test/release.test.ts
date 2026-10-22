// scripts/release.ts: the version bump, the drafted notes and the checks on the CI runs it trusts. The git and
// gh steps around them are covered by the commit test in test/main-update.test.ts and by docs/RELEASES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { draftSection, dropNotes, insertSection, nextVersion, parseArgs, runProblems, schemaFileAt, schemaVersions, setVersion, versionsLine } from '../scripts/release.ts';
import type { Run } from '../scripts/release.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

test('nextVersion bumps by name or takes a greater X.Y.Z', () => {
  assert.equal(nextVersion('0.18.7', 'patch'), '0.18.8');
  assert.equal(nextVersion('0.18.7', 'minor'), '0.19.0');
  assert.equal(nextVersion('0.18.7', 'major'), '1.0.0');
  assert.equal(nextVersion('0.18.7', '0.18.10'), '0.18.10');
  assert.equal(nextVersion('0.18.7', '1.0.0'), '1.0.0');
  for (const bad of ['0.18.7', '0.18.6', '0.9.9', '1.0', '1.0.0-rc.1', 'next', '']) assert.throws(() => nextVersion('0.18.7', bad), JSON.stringify(bad));
  assert.throws(() => nextVersion('0.18', 'patch'));
});

test('setVersion rewrites only the version lines and keeps formatting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-bump-'));
  try {
    fs.mkdirSync(path.join(dir, '.claude-plugin'));
    const pkg = '{\n  "name": "forge",\n  "version": "0.18.7",\n  "keywords": ["a", "b"]\n}\n';
    const lock = '{\n  "name": "forge",\n  "version": "0.18.7",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "forge",\n      "version": "0.18.7"\n    },\n    "node_modules/x": {\n      "version": "0.18.7"\n    }\n  }\n}\n';
    const plugin = '{\n  "name": "forge",\n  "version": "0.18.7"\n}\n';
    fs.writeFileSync(path.join(dir, 'package.json'), pkg);
    fs.writeFileSync(path.join(dir, 'package-lock.json'), lock);
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), plugin);
    setVersion(dir, '0.18.7', '0.19.0');
    assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), pkg.replace('0.18.7', '0.19.0'), 'the inline array keeps its line');
    const bumped = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
    assert.equal(bumped.version, '0.19.0');
    assert.equal(bumped.packages[''].version, '0.19.0');
    assert.equal(bumped.packages['node_modules/x'].version, '0.18.7', 'a dependency at the same version is left alone');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).version, '0.19.0');
    // A file that doesn't read the old version is refused, not half-bumped.
    assert.throws(() => setVersion(dir, '0.18.7', '0.20.0'), /package\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real version files bump cleanly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-real-'));
  try {
    for (const rel of ['package.json', 'package-lock.json', path.join('.claude-plugin', 'plugin.json')]) fs.cpSync(path.join(ROOT, rel), path.join(dir, rel));
    const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    setVersion(dir, v, nextVersion(v, 'patch'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the notes draft lists the commits and the versions that moved', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'lib', 'core', 'job', 'schema.ts'), 'utf8');
  const now = schemaVersions(schema);
  for (const k of ['CONFIG_SCHEMA_VERSION', 'JOB_SCHEMA_VERSION', 'EVENT_SCHEMA_VERSION', 'API_VERSION']) assert.equal(typeof now[k], 'number', `${k} is read from lib/core/job/schema.ts`);
  assert.equal(schemaFileAt((rel) => fs.existsSync(path.join(ROOT, rel))), 'lib/core/job/schema.ts');
  assert.equal(schemaFileAt((rel) => rel === 'lib/schema.ts'), 'lib/schema.ts', 'a tag from before the move');
  assert.equal(schemaFileAt(() => false), null);
  const line = versionsLine({ CONFIG_SCHEMA_VERSION: 22, JOB_SCHEMA_VERSION: 16, API_VERSION: 29 }, { CONFIG_SCHEMA_VERSION: 26, JOB_SCHEMA_VERSION: 16, API_VERSION: 31 });
  assert.equal(line, '- Versions: config schema 22 → 26, `API_VERSION` 29 → 31.');
  assert.equal(versionsLine(now, now), null);

  const draft = draftSection('0.19.0', 'v0.18.7', ['Release Forge in one command (#4)', 'Fix the thing (#3)', 'Release 0.18.7 (#2)', 'Release 0.18.6', 'Add \u001b[31mred\u001b[0m (#1)'], line);
  const lines = draft.split('\n');
  assert.equal(lines[0], '## 0.19.0');
  assert.ok(lines[2].startsWith('<!-- Drafted from the commits since v0.18.7.'));
  assert.deepEqual(lines.slice(3), ['- Release Forge in one command (#4)', '- Fix the thing (#3)', '- Add  [31mred [0m (#1)', line]);
  assert.equal(dropNotes(draft), ['## 0.19.0', '', '- Release Forge in one command (#4)', '- Fix the thing (#3)', '- Add  [31mred [0m (#1)', line].join('\n'));

  const changelog = '# Changelog\n\n## 0.18.7\n\n- Old.\n';
  assert.equal(insertSection(changelog, '## 0.19.0\n\n- New.'), '# Changelog\n\n## 0.19.0\n\n- New.\n\n## 0.18.7\n\n- Old.\n');
  assert.equal(insertSection('# Changelog\n', '## 0.1.0\n\n- First.'), '# Changelog\n\n## 0.1.0\n\n- First.\n');
});

test('runProblems trusts only a successful push run of the named workflow on the exact commit', () => {
  const sha = 'a'.repeat(40);
  const want = { repo: 'o/forge', workflow: 'main-update.yml', sha, branch: 'develop' };
  const good: Run = {
    id: 1,
    path: '.github/workflows/main-update.yml',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_sha: sha,
    head_branch: 'develop',
    html_url: 'https://github.com/o/forge/actions/runs/1',
    repository: { full_name: 'o/forge' },
    head_repository: { full_name: 'o/forge' },
  };
  assert.deepEqual(runProblems(good, want), []);
  assert.deepEqual(runProblems({ ...good, status: 'in_progress', conclusion: null }, want), [], 'a run still going is waited for');
  assert.deepEqual(runProblems({ ...good, event: 'workflow_dispatch' }, want), []);
  const bad: [Partial<Run>, RegExp][] = [
    [{ path: '.github/workflows/other.yml' }, /not main-update\.yml/],
    [{ head_sha: 'b'.repeat(40) }, /not a{40}/],
    [{ head_branch: 'main' }, /not develop/],
    [{ event: 'pull_request' }, /pull_request event/],
    [{ head_repository: { full_name: 'fork/forge' } }, /not o\/forge's own/],
    [{ repository: undefined }, /not o\/forge's own/],
    [{ conclusion: 'failure' }, /ended failure/],
    [{ conclusion: 'cancelled' }, /ended cancelled/],
  ];
  for (const [change, re] of bad) assert.match(runProblems({ ...good, ...change } as Run, want).join('\n'), re, JSON.stringify(change));
});

test('parseArgs takes one version, a notes file only with it, and --yes', () => {
  assert.deepEqual(parseArgs([]), { want: null, notesFile: null, yes: false });
  assert.deepEqual(parseArgs(['minor', '--yes']), { want: 'minor', notesFile: null, yes: true });
  assert.deepEqual(parseArgs(['0.19.0', '--notes-file', 'n.md']), { want: '0.19.0', notesFile: 'n.md', yes: false });
  for (const bad of [['--notes-file', 'n.md'], ['minor', 'patch'], ['next'], ['minor', '--notes-file'], ['--force'], ['-y']]) assert.equal(parseArgs(bad), null, JSON.stringify(bad));
});
