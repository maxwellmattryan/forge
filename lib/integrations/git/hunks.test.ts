import test from 'node:test';
import assert from 'node:assert/strict';
import { diffPaths, diffSpans, sharedSpans } from './hunks.ts';
import type { Span } from './hunks.ts';

const file = (p: string, body: string, minus = `a/${p}`, plus = `b/${p}`) => `diff --git a/${p} b/${p}\nindex 1111111..2222222 100644\n--- ${minus}\n+++ ${plus}\n${body}`;
const spans = (text: string) => Object.fromEntries(diffSpans(text));

test('diffSpans rows', () => {
  const rows: [string, string, Record<string, Span[]>][] = [
    // -U0, as git prints it for a job's branch.
    ['modification', file('a.ts', '@@ -5,3 +5,3 @@\n-a\n-b\n-c\n+A\n+B\n+C\n'), { 'a.ts': [[5, 7]] }],
    ['pure insertion after line 9', file('a.ts', '@@ -9,0 +10,2 @@\n+x\n+y\n'), { 'a.ts': [[9, 10]] }],
    ['deletion', file('a.ts', '@@ -4,2 +3,0 @@\n-x\n-y\n'), { 'a.ts': [[4, 5]] }],
    ['several hunks', file('a.ts', '@@ -2 +2 @@\n-a\n+A\n@@ -20,0 +21 @@\n+z\n@@ -40,2 +41 @@\n-p\n-q\n+P\n'), { 'a.ts': [[2, 2], [20, 21], [40, 41]] }],
    ['new file', file('n.ts', '@@ -0,0 +1,2 @@\n+a\n+b\n', '/dev/null'), { 'n.ts': [[0, 1]] }],
    ['deleted file', file('d.ts', '@@ -1,3 +0,0 @@\n-a\n-b\n-c\n', 'a/d.ts', '/dev/null'), { 'd.ts': [[1, 3]] }],
    ['binary file', 'diff --git a/img.png b/img.png\nindex 1..2 100644\nBinary files a/img.png and b/img.png differ\n', {}],
    ['C-quoted path', 'diff --git "a/x\\ty" "b/x\\ty"\n--- "a/x\\ty"\n+++ "b/x\\ty"\n@@ -1 +1 @@\n-a\n+b\n', {}],
    // A changed line that reads like a header stays a changed line.
    ['header-like body line', file('a.ts', '@@ -3,2 +3,2 @@\n--- not a header\n-+++ b/evil\n+x\n+y\n'), { 'a.ts': [[3, 4]] }],
    // gh pr diff: 3 lines of context around each change.
    ['context modification', file('a.ts', '@@ -2,7 +2,7 @@\n c1\n c2\n c3\n-old\n+new\n c4\n c5\n c6\n'), { 'a.ts': [[5, 5]] }],
    ['context insertion', file('a.ts', '@@ -7,6 +7,8 @@\n c1\n c2\n c3\n+x\n+y\n c4\n c5\n c6\n'), { 'a.ts': [[9, 10]] }],
    ['context deletion and no newline', file('a.ts', '@@ -1,4 +1,3 @@\n c1\n-gone\n c2\n-last\n\\ No newline at end of file\n+last\n\\ No newline at end of file\n'), { 'a.ts': [[2, 2], [4, 4]] }],
    ['two files', file('a.ts', '@@ -1 +1 @@\n-a\n+b\n') + file('b.ts', '@@ -8,0 +9 @@\n+c\n'), { 'a.ts': [[1, 1]], 'b.ts': [[8, 9]] }],
  ];
  for (const [name, text, want] of rows) assert.deepEqual(spans(text), want, name);
});

test('diffPaths lists binary files, renames and both sides', () => {
  const text =
    'diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n' +
    'diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n' +
    file('n.ts', '@@ -0,0 +1 @@\n+++ b/not-a-path\n', '/dev/null') +
    'diff --git "a/q\\tx" "b/q\\tx"\n--- "a/q\\tx"\n+++ "b/q\\tx"\n';
  assert.deepEqual(diffPaths(text), ['img.png', 'n.ts', 'new.ts', 'old.ts']);
});

test('sharedSpans rows', () => {
  const rows: [Span[], Span[], Span[]][] = [
    [[[5, 7]], [[6, 9]], [[5, 9]]],
    [[[5, 7]], [[8, 9]], []],
    [[[9, 10]], [[10, 10]], [[9, 10]]],
    [[[1, 2], [20, 30]], [[2, 2], [25, 40], [50, 51]], [[1, 2], [20, 40]]],
    [[], [[1, 1]], []],
  ];
  for (const [a, b, want] of rows) assert.deepEqual(sharedSpans(a, b), want, JSON.stringify([a, b]));
});
