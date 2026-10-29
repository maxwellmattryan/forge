// The gate card's PR note: which parks say the PR is open and waits on the decision, and which say the push is held.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gatePrNote } from './inbox.ts';
import type { JobPr } from '../core/types.ts';

const PR = { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, lastSyncedAt: null } as JobPr;
const park = (waitingOn: string, reason: string, more: Record<string, unknown> = {}) => ({ stage: 'pr', state: 'waiting', waitingOn, reason, pr: PR, ...more }) as Parameters<typeof gatePrNote>[0];

test('gatePrNote', () => {
  const open = [
    park('escalation', 'approver escalated: see decision.md'),
    park('infra', 'runbook: steps before merge'),
    park('human', 'protected paths: db/migrations/0001.sql'),
    park('human', 'recall eval: no recorded run for prompts abcdef0123'),
  ];
  for (const j of open) assert.deepEqual(gatePrNote(j), { kind: 'open', pr: PR }, String(j.reason));
  for (const reason of ['push held: CI config changes: .github/workflows/ci.yml [ci 0123456789abcdef]', 'push held: the security review of round 1 is CHANGES'])
    assert.deepEqual(gatePrNote(park('human', reason, { pr: null })), { kind: 'held' }, reason);
  const none: [string, Parameters<typeof gatePrNote>[0]][] = [
    ['a pr-review park', park('pr-review', 'r')],
    ['a secret park', park('human', 'secret scan blocked pr open')],
    ['a repo-proposal park', park('human', 'repo proposal: lib')],
    ['a decide-stage escalation', park('escalation', 'approver escalated: see decision.md', { stage: 'decide' })],
    ['a closed PR', park('escalation', 'approver escalated: see decision.md', { pr: { ...PR, state: 'CLOSED' } })],
    ['no PR', park('escalation', 'approver escalated: see decision.md', { pr: null })],
    ['a running job', park('escalation', 'approver escalated: see decision.md', { state: 'running' })],
  ];
  for (const [name, j] of none) assert.equal(gatePrNote(j), null, name);
});
