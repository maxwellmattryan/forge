import test from 'node:test';
import assert from 'node:assert/strict';
import { escalationApproval } from './body.ts';
import type { JobEvent } from '#core/types.ts';

/** A park on escalation with `reason`, then a person's approve. */
const parkedThenApproved = (reason: string): JobEvent[] =>
  [
    { type: 'transition', ts: '2026-10-29T10:00:00Z', to: { stage: 'build', state: 'waiting', waitingOn: 'escalation' }, reason },
    { type: 'human', ts: '2026-10-29T11:00:00Z', action: 'approve', actor: { login: 'octo', source: 'gh' } },
  ] as unknown as JobEvent[];

test("escalationApproval trims the reason's trailing dots and spaces", () => {
  const rows: [string, string][] = [
    ['budget over by 20%. . . ', 'budget over by 20%'],
    ['see v1.2 notes...', 'see v1.2 notes'],
    ['a.b', 'a.b'],
    ['plain reason', 'plain reason'],
    ['. . .', 'no reason recorded'],
    ['', 'no reason recorded'],
    [`x${' .'.repeat(5000)}`, 'x'],
  ];
  for (const [reason, want] of rows) {
    assert.deepEqual(escalationApproval(parkedThenApproved(reason)), { reason: want, login: 'octo', source: 'gh', ts: '2026-10-29T11:00:00Z', parkAt: 0 }, JSON.stringify(reason.slice(0, 40)));
  }
});
