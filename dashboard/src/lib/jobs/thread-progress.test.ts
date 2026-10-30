// The Thread's progress lines for events, read defensively: events.jsonl is a file in the job dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { progressOf, threadProgress, transcriptRows } from './thread-progress.ts';
import type { JobEvent } from '../core/types.ts';

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

test('what an advance ran becomes one Thread line', () => {
  const ok = { rule: 'B1', command: 'forge job round j', ok: true, text: 'round=1' };
  const rows: [string, JobEvent, unknown][] = [
    ['entries in order, a failed one kept', ev('advance-ran', { ran: [ok, { rule: 'RV8c', command: 'forge pr open j', ok: false, text: 'gh exited 1' }] }), { kind: 'ran', lines: [ok, { rule: 'RV8c', command: 'forge pr open j', ok: false, text: 'gh exited 1' }] }],
    ['no text', ev('advance-ran', { ran: [{ ...ok, text: null }] }), { kind: 'ran', lines: [{ ...ok, text: null }] }],
    [
      'malformed entries dropped',
      ev('advance-ran', { ran: [null, 'B1', { ...ok, rule: 'b1' }, { ...ok, rule: 'B1\nX' }, { ...ok, command: 7 }, { ...ok, command: ' ' }, { ...ok, ok: 'yes' }, ok] }),
      { kind: 'ran', lines: [ok] },
    ],
    [
      'text kept plain and capped',
      ev('advance-ran', { ran: [{ ...ok, command: `forge ${'c'.repeat(100)}`, text: `a\nb ${'x'.repeat(300)}` }] }),
      { kind: 'ran', lines: [{ ...ok, command: `forge ${'c'.repeat(73)}…`, text: `a b ${'x'.repeat(195)}…` }] },
    ],
    ['at most 20', ev('advance-ran', { ran: Array.from({ length: 25 }, () => ok) }), { kind: 'ran', lines: Array.from({ length: 20 }, () => ok) }],
    ['none valid', ev('advance-ran', { ran: [{ rule: 'B1' }] }), null],
    ['not a list', ev('advance-ran', { ran: 'B1' }), null],
  ];
  for (const [name, e, want] of rows) assert.deepEqual(progressOf(e), want, name);
});

test('only the newest run of a role the Agents tab lists gets a Transcript button', () => {
  const end = (ts: string, role: string): JobEvent => ({ ...ev('agent-end', { role, status: 'done', summary: 'ok' }), ts });
  const lines = threadProgress([
    end('2026-10-27T10:00:00Z', 'spec-writer'),
    end('2026-10-27T10:01:00Z', 'builder'),
    end('2026-10-27T10:02:00Z', 'reviewer'),
    end('2026-10-27T10:03:00Z', 'builder'),
    { ...ev('verify', { round: 1, ok: true }), ts: '2026-10-27T10:02:30Z' },
  ]);
  const idOf = (role: string, nth: number): string => lines.filter((m) => m.line.kind === 'agent' && m.line.role === role)[nth]!.id;
  // The builder ran twice: the later line has the button, the earlier one does not. The spec-writer's round is over, so the
  // Agents tab does not list it, and its line has none either.
  assert.deepEqual(transcriptRows(lines, ['builder', 'reviewer']), new Set([idOf('builder', 1), idOf('reviewer', 0)]));
  assert.deepEqual(transcriptRows(lines, []), new Set());
  assert.deepEqual(transcriptRows([], ['builder']), new Set());
});
