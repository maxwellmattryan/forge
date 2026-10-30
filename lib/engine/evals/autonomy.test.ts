// judgeAutonomy: a person's approve at a park policy requires counts against the strict rate only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJob } from '#core/job/schema.ts';
import type { Job, JobEvent, WaitingOn } from '#core/types.ts';
import { judgeAutonomy } from './autonomy.ts';

const merged = (): Job => {
  const j = normalizeJob({ id: 'j' });
  j.pr = { number: 1, url: 'https://github.com/o/r/pull/1', state: 'MERGED', isDraft: false, lastSyncedAt: null } as Job['pr'];
  j.outcome = { status: 'final', windowDays: 14, mergedAt: 't', closesAt: 't', mergeSha: null, reverted: false, revertedBy: null, followUps: 0, followUpRefs: [], churn: null, measuredAt: 't', attempts: 1 };
  return j;
};

/** A park on `waitingOn` with `reason`, then a person's approve. */
const parkedThenApproved = (waitingOn: WaitingOn, reason: string): JobEvent[] => [
  { v: 1, ts: '2026-10-01T10:00:00.000Z', type: 'transition', from: { stage: 'pr', state: 'running', waitingOn: null }, to: { stage: 'pr', state: 'waiting', waitingOn }, reason },
  { v: 1, ts: '2026-10-01T10:01:00.000Z', type: 'human', action: 'approve', actor: { login: 'alice', source: 'env' } },
];

test('required escalation parks', () => {
  const rows: [string, WaitingOn, string, { autonomous: boolean; strict: boolean; reasons: string[] }][] = [
    ['protected paths and a runbook only', 'escalation', 'escalation: protected-paths, runbook', { autonomous: true, strict: false, reasons: [] }],
    ['a runbook only', 'escalation', 'escalation: runbook', { autonomous: true, strict: false, reasons: [] }],
    ['the held push for protected paths', 'escalation', 'push held: escalation: protected-paths', { autonomous: true, strict: false, reasons: [] }],
    ['the legacy protected-paths park', 'human', 'protected paths: db/migrations/0001.sql', { autonomous: true, strict: false, reasons: [] }],
    ['with the approver too', 'escalation', 'escalation: approver, runbook', { autonomous: false, strict: false, reasons: ['person-decision'] }],
    ['a version reason', 'escalation', 'escalation: version', { autonomous: false, strict: false, reasons: ['person-decision'] }],
    ['a reason that lists no rule', 'escalation', 'escalation: runbook, nonsense', { autonomous: false, strict: false, reasons: ['person-decision'] }],
  ];
  for (const [name, waitingOn, reason, want] of rows) assert.deepEqual(judgeAutonomy(merged(), parkedThenApproved(waitingOn, reason)), want, name);
});
