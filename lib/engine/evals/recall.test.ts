import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gradeRecall, loadFixtures, patchLineFor, recallDir } from './recall.ts';

/** 418's frozen diff of lib/pr.ts (13 lines): new-file lines 40..48 sit on patch lines 5..13. */
const DIFF_418 = [
  'diff --git a/lib/pr.ts b/lib/pr.ts',
  '--- a/lib/pr.ts',
  '+++ b/lib/pr.ts',
  '@@ -40,2 +40,9 @@ export function prBase(root: string): string {',
  '   return base;',
  ' }',
  '+',
  '+/** The commits a PR adds over main, from the head branch gh reports for it. */',
  '+export function prCommits(root: string, number: number): string[] {',
  "+  const pr = JSON.parse(run('gh', ['pr', 'view', String(number), '--json', 'headRefName'], { cwd: root }).stdout);",
  "+  const out = run('git', ['log', '--format=%H', 'origin/main', pr.headRefName], { cwd: root }).stdout;",
  "+  return out.split('\\n').filter(Boolean);",
  '+}',
].join('\n');

const TWO_HUNKS = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,2 +1,2 @@',
  ' one',
  '-two',
  '+TWO',
  '@@ -10,3 +10,3 @@ function f() {',
  ' ten',
  '-eleven',
  '\\ No newline at end of file',
  '+ELEVEN',
  ' twelve',
].join('\n');

const TWO_FILES = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -5,1 +5,1 @@',
  '-old',
  '+new a',
  'diff --git a/b.ts b/b.ts',
  '--- a/b.ts',
  '+++ b/b.ts\r',
  '@@ -4,2 +4,2 @@',
  ' four',
  '+new b',
].join('\n');

/** git ends a ---/+++ path that holds a space with a tab. */
const TAB_END = ['diff --git a/a b b/a b', '--- a/a b\t', '+++ b/a b\t', '@@ -0,0 +1,1 @@', '+x'].join('\n');

const NO_COUNTS =['diff --git a/c.ts b/c.ts', '--- a/c.ts', '+++ b/c.ts', '@@ -1 +1 @@', '-x', '+y'].join('\n');

const EVIL = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,0 +1,3 @@',
  '+first',
  '+++ b/evil.ts',
  '+third',
  'diff --git a/gone.ts b/gone.ts',
  '--- a/gone.ts',
  '+++ /dev/null',
  '@@ -1,1 +0,0 @@',
  '-bye',
].join('\n');

test('patchLineFor maps a new-file line to its diff.patch line', () => {
  const rows: [string, string, string, number, number | null][] = [
    ['418: added line 46', DIFF_418, 'lib/pr.ts', 46, 11],
    ['418: context line 40', DIFF_418, 'lib/pr.ts', 40, 5],
    ['418: last added line 48', DIFF_418, 'lib/pr.ts', 48, 13],
    ['418: before the hunk', DIFF_418, 'lib/pr.ts', 39, null],
    ['418: after the hunk', DIFF_418, 'lib/pr.ts', 49, null],
    ['two hunks: first hunk added line', TWO_HUNKS, 'a.ts', 2, 7],
    ['two hunks: past a - line and a No newline line', TWO_HUNKS, 'a.ts', 11, 12],
    ['two hunks: context after them', TWO_HUNKS, 'a.ts', 12, 13],
    ['two hunks: a line between them', TWO_HUNKS, 'a.ts', 5, null],
    ['two files: line 5 of a.ts', TWO_FILES, 'a.ts', 5, 6],
    ['two files: line 5 of b.ts (header ends in \\r)', TWO_FILES, 'b.ts', 5, 12],
    ['two files: line 4 of b.ts', TWO_FILES, 'b.ts', 4, 11],
    ['a path no header names', TWO_FILES, 'c.ts', 5, null],
    ['+++ b/a b\\t names a b', TAB_END, 'a b', 1, 5],
    ['@@ -1 +1 @@ with no counts', NO_COUNTS, 'c.ts', 1, 6],
    ['an added +++ b/evil.ts line keeps the file', EVIL, 'a.ts', 3, 7],
    ['an added +++ b/evil.ts line is not a header', EVIL, 'evil.ts', 3, null],
    ['+++ /dev/null names no path', EVIL, 'gone.ts', 1, null],
  ];
  for (const [name, diff, file, line, want] of rows) assert.equal(patchLineFor(diff, file, line), want, name);
});

test('gradeRecall accepts the file line or the patch line within 5', () => {
  const grade = (finding: string, patchLine: number | null): number => {
    const rec = { fixtures: [{ name: 'f', title: 't', lenses: ['security'], clean: false, defects: [{ id: 'd', lens: 'security', path: 'lib/pr.ts', line: 46, patchLine }] }], reviews: [] };
    const texts = new Map<string, string | null>([['f/security', `VERDICT: CHANGES\n\n## Findings\n- ${finding} — x\n`]]);
    const g = gradeRecall(rec, texts, ['blocker', 'major']).byLens.security;
    assert.equal(g.planted, 1, finding);
    return g.caught;
  };
  const rows: [string, number | null, number][] = [
    ['[major] lib/pr.ts:46', 11, 1],
    ['[major] lib/pr.ts:11', 11, 1],
    ['[major] lib/pr.ts:51', 11, 1],
    ['[major] lib/pr.ts:16', 11, 1],
    ['[major] lib/pr.ts:52', 11, 0],
    ['[major] lib/pr.ts:17', 11, 0],
    ['[major] lib/other.ts:46', 11, 0],
    ['[nit] lib/pr.ts:46', 11, 0],
    ['[major] lib/pr.ts:11', null, 0],
  ];
  for (const [finding, patchLine, want] of rows) assert.equal(grade(finding, patchLine), want, `${finding} with patchLine ${patchLine}`);
});

test("418's security review of git-option-injection grades as caught", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-recall-'));
  try {
    const fdir = path.join(recallDir(dir), 'git-option-injection');
    fs.mkdirSync(fdir, { recursive: true });
    fs.writeFileSync(
      path.join(fdir, 'fixture.yml'),
      'title: an unchecked branch name from gh reaches git\'s argv\nlenses: [security]\ndefects:\n  - id: head-ref-option-injection\n    lens: security\n    path: lib/pr.ts\n    line: 46\n',
    );
    fs.writeFileSync(path.join(fdir, 'diff.patch'), `${DIFF_418}\n`);
    const { fixtures, problems } = loadFixtures(dir);
    assert.deepEqual(problems, []);
    assert.equal(fixtures[0].defects[0].patchLine, 11);
    const review = [
      'VERDICT: CHANGES',
      '',
      '## Findings',
      '- [blocker] lib/pr.ts:11 — `pr.headRefName` is untrusted … reaches git log as a bare argument, so --output=<path> becomes a git option.',
      '- [minor] lib/pr.ts:10 — JSON.parse on gh output is used without checking its shape.',
      '- [minor] lib/pr.ts:11 — the base is hard-coded as origin/main.',
      '',
    ].join('\n');
    const rec = { fixtures: fixtures.map(({ diffText: _d, ...f }) => f), reviews: [] };
    const g = gradeRecall(rec, new Map([['git-option-injection/security', review]]), ['blocker', 'major']).byLens.security;
    assert.deepEqual({ planted: g.planted, caught: g.caught, recall: g.recall }, { planted: 1, caught: 1, recall: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
