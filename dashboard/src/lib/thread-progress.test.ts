// The Thread's progress lines for events, read defensively: events.jsonl is a file in the job dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { progressOf } from './thread-progress.ts';
import type { JobEvent } from './types.ts';

const ev = (type: string, fields: Record<string, unknown>): JobEvent => ({ v: 1, ts: '2026-10-27T10:00:00Z', type, ...fields }) as JobEvent;
const NAME = 'verify (node 22.18.0, shard 2/2)';

test('CI re-run events become Thread lines', () => {
  const rows: [string, JobEvent, unknown][] = [
    ['a re-run', ev('ci-rerun', { head: 'b'.repeat(40), runs: ['101'], jobs: ['201'], checks: [NAME] }), { kind: 'ci-rerun', checks: [NAME] }],
    ['a re-run that failed again', ev('ci-rerun-failed', { cause: 'still-failing', checks: [NAME] }), { kind: 'ci-rerun-failed', reran: true, checks: [NAME] }],
    ["a head Forge couldn't re-run", ev('ci-rerun-failed', { cause: 'not-rerun', checks: ['lint'] }), { kind: 'ci-rerun-failed', reran: false, checks: ['lint'] }],
    ['an unknown cause', ev('ci-rerun-failed', { cause: 'gave-up', checks: ['lint'] }), null],
    ['no cause', ev('ci-rerun-failed', { checks: ['lint'] }), null],
    ['checks that are not a list', ev('ci-rerun', { checks: 'lint' }), { kind: 'ci-rerun', checks: [] }],
    ['no checks', ev('ci-rerun-failed', { cause: 'not-rerun' }), { kind: 'ci-rerun-failed', reran: false, checks: [] }],
    [
      'names kept plain, cut to 60 characters, at most 5',
      ev('ci-rerun', { checks: ['a\nb', 7, '', 'x'.repeat(80), 'c', 'd', 'e', 'f'] }),
      { kind: 'ci-rerun', checks: ['a b', 'x'.repeat(60), 'c', 'd', 'e'] },
    ],
  ];
  for (const [name, e, want] of rows) assert.deepEqual(progressOf(e), want, name);
});
