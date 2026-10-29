// scripts/release.ts's script protocol, which `forge release plan|run` drives for `release.mechanism: script`: the
// argv forms, the inferred bump, the notes draft, the start and wait-tag phases against a bare origin and a fake gh,
// and phase mode's answers.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fakeBin, repoTemplate } from '../../helpers.ts';
import { PHASE_ASK, draftNotes, draftSection, inferBump, parseMode, plainAsk, prepare, runPhase } from '../../../scripts/release.ts';
import { Refusal } from '../../../scripts/stable-tree.ts';

const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };

/** develop one commit past a tagged 1.0.0 release, with the version files, marketplace ref and CHANGELOG (as release.test.ts builds it). */
const developRepo = repoTemplate((dir) => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  const files: Record<string, string> = {
    'package.json': '{\n  "name": "forge",\n  "version": "1.0.0"\n}\n',
    'package-lock.json': '{\n  "name": "forge",\n  "version": "1.0.0",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "forge",\n      "version": "1.0.0"\n    }\n  }\n}\n',
    '.claude-plugin/plugin.json': '{\n  "name": "forge",\n  "version": "1.0.0"\n}\n',
    '.claude-plugin/marketplace.json': '{\n  "name": "forge",\n  "plugins": [\n    {\n      "name": "forge",\n      "source": { "source": "github", "repo": "maxwellmattryan/forge", "ref": "stable" }\n    }\n  ]\n}\n',
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
    [['--phase', 'wait-tag', '1.2.3'], { kind: 'phase', phase: 'wait-tag', version: '1.2.3', notesFile: null }],
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
    // The phases of the main-update flow are gone.
    ['--phase', 'wait-build', '1.2.3'],
    ['--phase', 'pr', '1.2.3'],
    ['--phase', 'land', '1.2.3'],
    ['--phase', 'wait-tag'],
    ['--phase', 'wait-tag', '1.2'],
    ['--phase', 'wait-tag', 'v1.2.3'],
    ['--phase', 'wait-tag', '-1.2.3'],
    ['--phase', 'publish', '1.2.3'],
    ['--phase', 'wait-tag', '1.2.3', '--yes'],
    ['--phase', 'start', '1.2.3', '--notes-file', 'n.md', '--yes'],
    ['--phase', 'wait-tag', '1.2.3', '--notes-file', 'n.md'],
    ['--phase', 'wait-tag', 'minor'],
    ['minor', '--phase', 'wait-tag', '1.2.3'],
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

const PR_URL = 'https://github.com/o/forge/pull/9';
const RELEASE_URL = 'https://github.com/o/forge/releases/tag/v1.1.0';
/** A fake gh: the repo name, `pr list` from $FAKE_PRS, `pr create` (its body copied to $FAKE_BODY) and `release view`. */
const FAKE_GH = [
  'case "$1 $2" in',
  '  "repo view") echo o/forge ;;',
  "  \"pr list\") printf '%s\\n' \"${FAKE_PRS:-[]}\" ;;",
  '  "pr create")',
  '    prev=; for a in "$@"; do [ "$prev" = --body-file ] && cp "$a" "$FAKE_BODY"; prev=$a; done',
  `    echo ${PR_URL} ;;`,
  `  "release view") echo ${RELEASE_URL} ;;`,
  '  *) echo "unexpected: gh $*" >&2; exit 1 ;;',
  'esac',
].join('\n');

/** The fake gh first on PATH for this test, and a setter for the PRs `gh pr list` prints; both put back after it. */
function useGh(t: TestContext, dir: string) {
  const gh = fakeBin('gh', FAKE_GH);
  const saved = { PATH: process.env.PATH, FAKE_PRS: process.env.FAKE_PRS, FAKE_BODY: process.env.FAKE_BODY };
  process.env.PATH = `${gh.dir}${path.delimiter}${saved.PATH ?? ''}`;
  process.env.FAKE_BODY = path.join(dir, 'body.md');
  delete process.env.FAKE_PRS;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  return {
    created: () => gh.calls().filter((c) => c[0] === 'pr' && c[1] === 'create'),
    body: () => fs.readFileSync(path.join(dir, 'body.md'), 'utf8'),
    prs: (rows: unknown[]) => { process.env.FAKE_PRS = JSON.stringify(rows); },
  };
}
const prRow = (head: string, o: Record<string, unknown> = {}) => ({ number: 9, state: 'OPEN', url: PR_URL, headRefName: 'release/v1.1.0', headRefOid: head, baseRefName: 'develop', isCrossRepository: false, mergeCommit: null, ...o });

/** developRepo with a bare origin holding main, develop and the tags. */
function withOrigin(repo: ReturnType<typeof developRepo>) {
  const bare = path.join(repo.dir, '.git', 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'pipe' });
  repo.git('remote', 'add', 'origin', bare);
  repo.git('push', '-q', 'origin', 'main', 'develop', '--tags');
  return (ref: string) => {
    try {
      return execFileSync('git', ['rev-parse', '-q', '--verify', ref], { cwd: bare, stdio: 'pipe' }).toString().trim();
    } catch {
      return null;
    }
  };
}

test('phase start cuts, pushes and opens the release PR once', POSIX, async (t) => {
  const repo = developRepo();
  const notesDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-notes-')));
  try {
    const gh = useGh(t, notesDir);
    const out = (...args: string[]) => repo.git(...args).toString().trim();
    const onOrigin = withOrigin(repo);
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
    assert.deepEqual(gh.created(), [], 'no PR');

    fs.writeFileSync(notes, '## 1.1.0\n\n<!-- Drafted from the commits since v1.0.0. -->\n- New things.\n');
    assert.equal(await start('1.1.0'), PR_URL);
    const sha = out('rev-parse', 'refs/heads/release/v1.1.0');
    assert.equal(onOrigin('refs/heads/release/v1.1.0'), sha, 'pushed to origin');
    assert.equal(out('log', '-1', '--format=%s', sha), 'Release 1.1.0');
    assert.equal(out('show', `${sha}:CHANGELOG.md`), '# Changelog\n\n## 1.1.0\n\n- New things.\n\n## 1.0.0\n\n- First.');
    assert.equal(out('rev-parse', 'develop'), develop, 'develop did not move');
    assert.equal(out('symbolic-ref', '--short', 'HEAD'), 'develop');
    assert.equal(onOrigin('refs/heads/develop'), develop);
    const [create, ...more] = gh.created();
    assert.deepEqual(more, [], 'one PR');
    assert.deepEqual(create.slice(0, -1), ['pr', 'create', '--repo', 'o/forge', '--base', 'develop', '--head', 'release/v1.1.0', '--title', 'Release 1.1.0', '--body-file']);
    assert.ok(gh.body().startsWith('- New things.\n'), 'the notes first');
    assert.ok(gh.body().includes('https://github.com/o/forge/compare/v1.0.0...release/v1.1.0'), 'the compare link from the previous tag');

    // Again, with the PR open: nothing new is committed, pushed or opened.
    gh.prs([prRow(sha)]);
    const commits = out('rev-list', '--count', '--all');
    assert.equal(await start('1.1.0'), PR_URL);
    assert.equal(out('rev-parse', 'refs/heads/release/v1.1.0'), sha);
    assert.equal(onOrigin('refs/heads/release/v1.1.0'), sha);
    assert.equal(out('rev-list', '--count', '--all'), commits, 'no new commit');
    assert.equal(gh.created().length, 1, 'no second PR');

    // The release commit is here but origin lost the branch: it is pushed again.
    repo.git('push', '-q', 'origin', '--delete', 'release/v1.1.0');
    assert.equal(onOrigin('refs/heads/release/v1.1.0'), null);
    assert.equal(await start('1.1.0'), PR_URL);
    assert.equal(onOrigin('refs/heads/release/v1.1.0'), sha);
    assert.equal(gh.created().length, 1);

    // Another version refuses while this one is in flight.
    fs.writeFileSync(notes, '## 1.2.0\n\n- Notes.\n');
    await assert.rejects(start('1.2.0'), (e: unknown) => e instanceof Refusal && /Release 1\.1\.0 is in flight/.test(e.message));

    // Tagged: nothing more happens, and develop never moved.
    repo.git('tag', '-a', 'v1.1.0', '-m', 'Forge 1.1.0', sha);
    repo.git('push', '-q', 'origin', 'v1.1.0');
    repo.git('branch', '-D', 'release/v1.1.0');
    repo.git('push', '-q', 'origin', '--delete', 'release/v1.1.0');
    assert.equal(await start('1.1.0'), null);
    assert.equal(out('branch', '--list', 'release/*'), '', 'nothing cut again');
    assert.equal(out('rev-parse', 'develop'), develop);
    assert.equal(onOrigin('refs/heads/develop'), develop);
    assert.equal(gh.created().length, 1);
  } finally {
    repo.cleanup();
    fs.rmSync(notesDir, { recursive: true, force: true });
  }
});

test('phase wait-tag accepts only the stable commit of the merged release', POSIX, async (t) => {
  const repo = developRepo();
  const notesDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-notes-')));
  try {
    const gh = useGh(t, notesDir);
    const out = (...args: string[]) => repo.git(...args).toString().trim();
    withOrigin(repo);
    const notes = path.join(notesDir, 'notes.md');
    fs.writeFileSync(notes, '## 1.1.0\n\n- New things.\n');
    const release = prepare(repo.dir, '1.0.0', '1.1.0', notes);
    // A human merged the release PR into develop; stable started from v1.0.0.
    repo.git('merge', '-q', '--no-ff', '-m', 'Merge pull request #9 from o/release/v1.1.0', release);
    const merge = out('rev-parse', 'HEAD');
    repo.git('push', '-q', 'origin', 'develop');
    gh.prs([prRow(release, { state: 'MERGED', mergeCommit: { oid: merge } })]);
    const stableStart = out('rev-parse', 'v1.0.0^{commit}');
    const commitTree = (...parents: string[]) =>
      execFileSync('git', ['commit-tree', `${merge}^{tree}`, ...parents.flatMap((p) => ['-p', p]), '-m', 'Release 1.1.0'], { cwd: repo.dir }).toString().trim();
    const onStable = commitTree(stableStart, merge);
    repo.git('push', '-q', 'origin', `${onStable}:refs/heads/stable`);
    const tagOnOrigin = (commit: string) => {
      repo.git('tag', '-f', '-a', 'v1.1.0', '-m', 'Forge 1.1.0', commit);
      repo.git('push', '-q', '-f', 'origin', 'refs/tags/v1.1.0');
    };
    const waitTag = () => runPhase(repo.dir, { kind: 'phase', phase: 'wait-tag', version: '1.1.0', notesFile: null });

    // release.yml's stable commit: second parent the merge, on stable. The tag is on origin, so nothing waits.
    tagOnOrigin(onStable);
    assert.equal(await waitTag(), RELEASE_URL);

    const rows: [string, string, RegExp][] = [
      ['a tag on the develop commit itself', merge, /not the stable commit of the release PR's merge/],
      ['a stable commit of another develop commit', commitTree(stableStart, out('rev-parse', 'HEAD^')), /not the stable commit of the release PR's merge/],
      ['the merge with no second parent', commitTree(merge), /second parent is missing/],
      ['a stable-shaped commit off stable', commitTree(out('rev-parse', 'main^'), merge), /is not on origin\/stable/],
    ];
    for (const [what, commit, reason] of rows) {
      tagOnOrigin(commit);
      await assert.rejects(waitTag(), (e: unknown) => e instanceof Refusal && reason.test(e.message), what);
    }

    // Not merged yet: wait-tag refuses rather than wait.
    gh.prs([prRow(release)]);
    await assert.rejects(waitTag(), (e: unknown) => e instanceof Refusal && /is not merged yet/.test(e.message));
  } finally {
    repo.cleanup();
    fs.rmSync(notesDir, { recursive: true, force: true });
  }
});

test('phase mode answers the push question', async () => {
  await PHASE_ASK.push('Push Release 1.1.0 to origin release/v1.1.0?');
  // The plain path asks: --yes answers it, and without a terminal it is not answered.
  await plainAsk(true).push('Push it?');
  if (!process.stdin.isTTY) {
    await assert.rejects(plainAsk(false).push('Push it?'), (e: unknown) => e instanceof Refusal && /Push it\? needs a terminal to answer, or --yes/.test(e.message));
  }
});
