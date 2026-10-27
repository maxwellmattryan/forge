// scripts/release.ts's script protocol, which `forge release plan|run` drives for `release.mechanism: script`: the
// argv forms, the inferred bump, the notes draft, the start phase against a bare origin, and phase mode's answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoTemplate } from '../../helpers.ts';
import { PHASE_ASK, draftNotes, draftSection, inferBump, parseMode, plainAsk, runPhase } from '../../../scripts/release.ts';
import { Refusal } from '../../../scripts/main-update.ts';

const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };
const SHA = 'a'.repeat(40);

/** develop one commit past a tagged 1.0.0 release, with the version files, marketplace ref and CHANGELOG (as release.test.ts builds it). */
const developRepo = repoTemplate((dir) => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  const files: Record<string, string> = {
    'package.json': '{\n  "name": "forge",\n  "version": "1.0.0"\n}\n',
    'package-lock.json': '{\n  "name": "forge",\n  "version": "1.0.0",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "forge",\n      "version": "1.0.0"\n    }\n  }\n}\n',
    '.claude-plugin/plugin.json': '{\n  "name": "forge",\n  "version": "1.0.0"\n}\n',
    '.claude-plugin/marketplace.json': '{\n  "name": "forge",\n  "plugins": [\n    {\n      "name": "forge",\n      "source": { "source": "url", "url": "https://github.com/o/forge.git", "ref": "v1.0.0" }\n    }\n  ]\n}\n',
    'CHANGELOG.md': '# Changelog\n\n## 1.0.0\n\n- First.\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git('add', '-A');
  git('commit', '-qm', 'Release 1.0.0');
  git('tag', '-a', 'v1.0.0', '-m', 'Forge 1.0.0');
  git('checkout', '-qb', 'develop');
  fs.writeFileSync(path.join(dir, 'README.md'), '# develop\n');
  git('commit', '-qam', 'feat: develop work');
});

test('parseMode takes the phase, check and draft forms', () => {
  const rows: [string[], unknown][] = [
    [['--phase', 'start', '1.2.3', '--notes-file', '/tmp/n.md'], { kind: 'phase', phase: 'start', version: '1.2.3', notesFile: '/tmp/n.md' }],
    ...(['wait-build', 'pr', 'wait-tag', 'land'] as const).map((phase): [string[], unknown] => [['--phase', phase, '1.2.3'], { kind: 'phase', phase, version: '1.2.3', notesFile: null }]),
    [['--check', 'merged', '1.2.3'], { kind: 'check', version: '1.2.3' }],
    [['--draft-notes'], { kind: 'draft', bump: null }],
    [['--draft-notes', '--bump', 'major'], { kind: 'draft', bump: 'major' }],
    // Anything else is npm run release's argv, read as it always was.
    [[], { kind: 'release', args: { want: null, notesFile: null, yes: false } }],
    [['minor', '--notes-file', 'n.md', '--yes'], { kind: 'release', args: { want: 'minor', notesFile: 'n.md', yes: true } }],
  ];
  for (const [argv, want] of rows) assert.deepEqual(parseMode(argv), want, argv.join(' '));
  const refused: string[][] = [
    ['--phase', 'start', '1.2.3'],
    ['--phase', 'start', '1.2.3', '--notes-file'],
    ['--phase', 'start', '1.2.3', '--notes-file', '--yes'],
    ['--phase', 'pr'],
    ['--phase', 'pr', '1.2'],
    ['--phase', 'pr', 'v1.2.3'],
    ['--phase', 'pr', '-1.2.3'],
    ['--phase', 'publish', '1.2.3'],
    ['--phase', 'pr', '1.2.3', '--yes'],
    ['--phase', 'start', '1.2.3', '--notes-file', 'n.md', '--yes'],
    ['--phase', 'pr', '1.2.3', '--notes-file', 'n.md'],
    ['--phase', 'pr', 'minor'],
    ['minor', '--phase', 'pr', '1.2.3'],
    ['--check', 'merged'],
    ['--check', 'open', '1.2.3'],
    ['--check', 'merged', '1.2.3', '--yes'],
    ['--draft-notes', '--yes'],
    ['--draft-notes', '--bump', 'huge'],
    ['--draft-notes', '--bump'],
    ['--draft-notes', 'minor'],
    ['minor', 'patch'],
    ['--notes-file', 'n.md'],
  ];
  for (const argv of refused) assert.equal(parseMode(argv), null, argv.join(' '));
});

test('inferBump', () => {
  const rows: [string, string[], string | null, 'patch' | 'minor', RegExp][] = [
    ['a version list moved', ['fix: a'], '- Versions: config schema 38 → 39.', 'minor', /config schema 38 → 39/],
    ['a subject that is not a fix', ['fix: a', 'Chat engine: storage, _chat scope, API (#580)'], null, 'minor', /1 of 2 commits are not fixes, such as "Chat engine: storage, _chat scope, API \(#580\)"/],
    ['fit is not fix', ['Fit the scrollbar thumb inside its rail'], null, 'minor', /1 of 1 commits are not fixes/],
    ['add', ['Add a thing', 'fixed: b'], null, 'minor', /1 of 2/],
    ['fixture is not fix', ['fixture: c'], null, 'minor', /1 of 1/],
    ['every subject a fix', ['Fix the thing', 'fix: b', 'Fixes c', 'fixed d', 'fix(scope): e'], null, 'patch', /all 5 commits are fixes and no version moved/],
    ['release subjects are ignored', ['fix: a', 'Release 1.2.3 (#9)', 'Update main to develop abcdef1'], null, 'patch', /all 1 commits are fixes/],
  ];
  for (const [what, subjects, versions, bump, reason] of rows) {
    const got = inferBump(subjects, versions);
    assert.equal(got.bump, bump, what);
    assert.match(got.reasons.join('\n'), reason, what);
    assert.ok(got.reasons.length >= 1 && got.reasons.length <= 5, `${what}: 1 to 5 reasons`);
    assert.ok(got.reasons.every((r) => r.length <= 500), `${what}: short reasons`);
  }
  const both = inferBump(['Add x'], '- Versions: job schema 1 → 2.');
  assert.equal(both.reasons.length, 2, 'the versions line and the commits each give a reason');
});

test('draftNotes drafts from develop since the last tag', POSIX, () => {
  const repo = developRepo();
  try {
    const got = draftNotes(repo.dir, null);
    assert.deepEqual(
      { ...got, reasons: undefined, draft: undefined },
      { current: '1.0.0', next: '1.1.0', bump: 'minor', inferred: 'minor', since: 'v1.0.0', reasons: undefined, draft: undefined },
    );
    assert.equal(got.draft, draftSection('1.1.0', 'v1.0.0', ['feat: develop work'], null));
    assert.match(got.reasons[0], /feat: develop work/);
    const major = draftNotes(repo.dir, 'major');
    assert.equal(major.next, '2.0.0');
    assert.equal(major.bump, 'major');
    assert.equal(major.inferred, 'minor');
    assert.equal(major.draft.split('\n', 1)[0], '## 2.0.0');

    repo.git('reset', '-q', '--hard', 'v1.0.0');
    assert.throws(() => draftNotes(repo.dir, null), (e: unknown) => e instanceof Refusal && /nothing to release: no commits since v1\.0\.0/.test(e.message));
  } finally {
    repo.cleanup();
  }
});

test('phase start cuts and pushes the release once', POSIX, async () => {
  const repo = developRepo();
  const notesDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-notes-')));
  try {
    const out = (...args: string[]) => repo.git(...args).toString().trim();
    const bare = path.join(repo.dir, '.git', 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'pipe' });
    repo.git('remote', 'add', 'origin', bare);
    repo.git('push', '-q', 'origin', 'main', 'develop', '--tags');
    const onOrigin = (ref: string) => {
      try {
        return execFileSync('git', ['rev-parse', '-q', '--verify', ref], { cwd: bare, stdio: 'pipe' }).toString().trim();
      } catch {
        return null;
      }
    };
    const develop = out('rev-parse', 'develop');
    const notes = path.join(notesDir, 'notes-root.md');
    const start = (version: string) => runPhase(repo.dir, { kind: 'phase', phase: 'start', version, notesFile: notes });

    // Refused before any branch or commit exists: a version that is no successor, and notes for another version.
    fs.writeFileSync(notes, '## 1.2.0\n\n- Notes.\n');
    await assert.rejects(start('1.2.0'), (e: unknown) => e instanceof Refusal && /1\.2\.0 is not the patch, minor or major release after 1\.0\.0/.test(e.message));
    fs.writeFileSync(notes, '## 9.9.9\n\n- Notes for another version.\n');
    await assert.rejects(start('1.1.0'), (e: unknown) => e instanceof Refusal && /must start with "## 1\.1\.0"/.test(e.message));
    assert.equal(out('branch', '--list', 'release/*'), '', 'no release branch');
    assert.equal(onOrigin('refs/heads/release/v1.1.0'), null);
    assert.equal(out('rev-parse', 'develop'), develop);

    fs.writeFileSync(notes, '## 1.1.0\n\n<!-- Drafted from the commits since v1.0.0. -->\n- New things.\n');
    await start('1.1.0');
    const sha = out('rev-parse', 'refs/heads/release/v1.1.0');
    assert.equal(onOrigin('refs/heads/release/v1.1.0'), sha, 'pushed to origin');
    assert.equal(out('log', '-1', '--format=%s', sha), 'Release 1.1.0');
    assert.equal(out('show', `${sha}:CHANGELOG.md`), '# Changelog\n\n## 1.1.0\n\n- New things.\n\n## 1.0.0\n\n- First.');
    assert.equal(out('rev-parse', 'develop'), develop, 'develop did not move');
    assert.equal(out('symbolic-ref', '--short', 'HEAD'), 'develop');
    assert.equal(onOrigin('refs/heads/develop'), develop);

    // Again: nothing new is committed or pushed.
    const commits = out('rev-list', '--count', '--all');
    await start('1.1.0');
    assert.equal(out('rev-parse', 'refs/heads/release/v1.1.0'), sha);
    assert.equal(onOrigin('refs/heads/release/v1.1.0'), sha);
    assert.equal(out('rev-list', '--count', '--all'), commits, 'no new commit');

    // The release commit is here but origin lost the branch: it is pushed again.
    repo.git('push', '-q', 'origin', '--delete', 'release/v1.1.0');
    assert.equal(onOrigin('refs/heads/release/v1.1.0'), null);
    await start('1.1.0');
    assert.equal(onOrigin('refs/heads/release/v1.1.0'), sha);

    // Landed: origin/develop is at the release commit and v1.1.0 exists. Nothing more happens.
    repo.git('push', '-q', 'origin', `${sha}:refs/heads/develop`);
    repo.git('tag', '-a', 'v1.1.0', '-m', 'Forge 1.1.0', sha);
    repo.git('push', '-q', 'origin', 'v1.1.0');
    repo.git('branch', '-D', 'release/v1.1.0');
    await start('1.1.0');
    assert.equal(out('branch', '--list', 'release/*'), '', 'nothing cut again');
    assert.equal(out('rev-parse', 'develop'), develop);
  } finally {
    repo.cleanup();
    fs.rmSync(notesDir, { recursive: true, force: true });
  }
});

test('phase mode answers only the push questions', async () => {
  await PHASE_ASK.push('Push Release 1.1.0 to origin release/v1.1.0?');
  await PHASE_ASK.behind('Go on with Release 1.1.0 without them?', 2, 'stopped');
  const hotfixes = [
    { sha: SHA, subject: 'fix: only on main' },
    { sha: 'b'.repeat(40), subject: 'fix: another' },
  ];
  await assert.rejects(PHASE_ASK.hotfixes(hotfixes), (e: unknown) => e instanceof Refusal && e.message.includes(`${SHA} fix: only on main`) && e.message.includes('fix: another') && /npm run release/.test(e.message));

  // The plain path asks as before: --yes answers everything, and without a terminal nothing is answered.
  const yes = plainAsk(true);
  await yes.push('Push it?');
  await yes.behind('Go on?', 1, 'stopped');
  await yes.hotfixes(hotfixes);
  if (!process.stdin.isTTY) {
    const asked = plainAsk(false);
    await assert.rejects(asked.push('Push it?'), (e: unknown) => e instanceof Refusal && /Push it\? needs a terminal to answer, or --yes/.test(e.message));
    await assert.rejects(asked.behind('Go on?', 1, 'stopped'), /Go on\? needs a terminal/);
    await assert.rejects(asked.hotfixes(hotfixes), /Were they all ported\? needs a terminal/);
  }
});
