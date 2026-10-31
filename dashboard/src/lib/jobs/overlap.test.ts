// The Overlaps with card's model, read defensively: the report names paths and refs from outside the repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { overlapRows, showOverlap } from './overlap.ts';
import type { OverlapCounterpart, OverlapReport } from '../core/types.ts';

const report = (counterparts: unknown[]): OverlapReport =>
  ({
    schemaVersion: 1,
    checkedAt: '2026-10-31T12:00:00.000Z',
    subject: { kind: 'job', ref: 'a', source: 'diff', files: 2 },
    base: 'main',
    recentHours: 24,
    counterparts,
    idle: false,
    timing: { kind: 'needs-human', refs: ['#4'] },
    reasons: ['outside-pr'],
    gaps: [],
  }) as OverlapReport;
const cp = (over: Partial<OverlapCounterpart>): OverlapCounterpart => ({ kind: 'job', ref: 'b', source: 'diff', human: false, stage: 'build', url: null, files: ['lib/a.ts'], sharedHunks: [], ...over });
const hunk = { path: 'lib/a.ts', start: 1, end: 2 };

test('showOverlap', () => {
  assert.equal(showOverlap(null), false);
  assert.equal(showOverlap(undefined), false);
  assert.equal(showOverlap(report([])), false);
  assert.equal(showOverlap({ ...report([]), counterparts: 'x' } as unknown as OverlapReport), false);
  assert.equal(showOverlap(report([{ kind: 'nope', ref: 'x' }])), false);
  assert.equal(showOverlap(report([cp({})])), true);
});

test('overlapRows', () => {
  const rows = overlapRows(
    report([
      cp({ files: ['a', 'b', 'c', 'd', 'e'], sharedHunks: [hunk, hunk] }),
      cp({ ref: 'spec-job', source: 'file-map', stage: 'spec', files: ['lib/'] }),
      cp({ kind: 'pr', ref: '#4', human: true, stage: null, url: 'https://github.com/o/r/pull/4', sharedHunks: [hunk] }),
      cp({ kind: 'pr', ref: '#5', human: true, stage: null, url: 'http://github.com/o/r/pull/5' }),
      cp({ kind: 'pr', ref: '#6', human: true, stage: null, url: 'javascript:alert(1)' }),
      cp({ kind: 'push', ref: 'main@abcdefabcdef', human: true, stage: null }),
      { kind: 'job', ref: 7 },
    ]),
  );
  assert.deepEqual(rows, [
    { kind: 'job', ref: 'b', target: { drawer: 'b' }, person: false, files: ['a', 'b', 'c'], more: 2, hunks: 2, fileMap: false },
    { kind: 'job', ref: 'spec-job', target: { drawer: 'spec-job' }, person: false, files: ['lib/'], more: 0, hunks: 0, fileMap: true },
    { kind: 'pr', ref: '#4', target: { href: 'https://github.com/o/r/pull/4' }, person: true, files: ['lib/a.ts'], more: 0, hunks: 1, fileMap: false },
    { kind: 'pr', ref: '#5', target: null, person: true, files: ['lib/a.ts'], more: 0, hunks: 0, fileMap: false },
    { kind: 'pr', ref: '#6', target: null, person: true, files: ['lib/a.ts'], more: 0, hunks: 0, fileMap: false },
    { kind: 'push', ref: 'main@abcdefabcdef', target: null, person: true, files: ['lib/a.ts'], more: 0, hunks: 0, fileMap: false },
  ]);
});
