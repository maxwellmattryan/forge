// The gate card's PR note (which parks say the PR is open and waits on the decision, and which say the push is
// held) and its `Why it waits` rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gatePrNote, gateReasonRows, inboxGroups } from './inbox.ts';
import { showParkReason } from '../jobs/protected.ts';
import { needsHuman } from '../jobs/state.ts';
import { WAIT_LABEL } from '../core/labels.ts';
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

test('a merge queue hold is listed with the PRs, never as a decision', () => {
  const held = park('overlap', 'merge queue: waits for a to merge first, ranked ahead in its overlap group');
  const escalated = park('escalation', 'approver escalated: see decision.md');
  assert.equal(needsHuman(held), false);
  assert.deepEqual(inboxGroups([held, escalated, park('pr-review', 'r')]).prs.map((j) => j.waitingOn), ['overlap', 'pr-review']);
  assert.deepEqual(inboxGroups([held, escalated]).urgent, [escalated]);
  assert.equal(WAIT_LABEL.overlap, 'Merge queue');
  assert.equal(gatePrNote(held), null, 'no merge-gate note: nobody is asked to decide');
});

test('gatePrNote holds a push-held escalation park', () => {
  assert.deepEqual(gatePrNote(park('escalation', 'push held: escalation: approver, protected-paths', { pr: null })), { kind: 'held' });
  assert.deepEqual(gatePrNote(park('escalation', 'push held: escalation: protected-paths')), { kind: 'held' }, 'held even with an open PR: the update is not pushed');
  assert.deepEqual(gatePrNote(park('escalation', 'escalation: approver, runbook')), { kind: 'open', pr: PR }, 'the escalation park after the push');
});

test('gateReasonRows', () => {
  const reasons = [
    { rule: 'approver', detail: 'the approver escalated: see decision.md' },
    { rule: 'version', detail: 'version changed in 1 manifest', paths: ['package.json'] },
  ];
  assert.deepEqual(gateReasonRows({ gateReasons: reasons }), [
    { rule: 'approver', detail: 'the approver escalated: see decision.md', paths: [], doc: 'decision.md' },
    { rule: 'version', detail: 'version changed in 1 manifest', paths: ['package.json'], doc: null },
  ]);
  // Each rule links the file step's gateTell names for it, so a runbook-only or lens-only park links what the person must read.
  const docs = (rules: string[]) => gateReasonRows({ gateReasons: rules.map((rule) => ({ rule, detail: 'x' })) })?.map((r) => r.doc);
  assert.deepEqual(docs(['runbook']), ['runbook.md'], 'a runbook-only park links runbook.md, not decision.md');
  assert.deepEqual(docs(['lens-escalate']), ['review']);
  assert.deepEqual(docs(['approver', 'protected-paths', 'runbook', 'acs', 'dependencies']), ['decision.md', null, 'runbook.md', null, null], 'protected paths keep the card View diff button; acs and dependencies say it all');
  assert.deepEqual(docs(['constructor']), [null], 'a rule that is an Object.prototype key links nothing');
  for (const [name, v] of [
    ['null', null],
    ['an older server', undefined],
    ['an empty list', []],
    ['not a list', 'escalation: approver'],
    ['malformed rows only', [{ rule: 1, detail: 'x' }, null, { rule: 'runbook' }]],
  ] as [string, unknown][])
    assert.equal(gateReasonRows({ gateReasons: v }), null, name);
  assert.deepEqual(gateReasonRows({ gateReasons: [{ rule: 'acs', detail: 'unmapped: AC2', paths: [1, 'a.md'] }, 'junk'] }), [{ rule: 'acs', detail: 'unmapped: AC2', paths: ['a.md'], doc: null }], 'only string paths, malformed rows dropped');
  // The card hides the raw park reason while the list shows.
  assert.equal(showParkReason({ reason: 'escalation: approver, version', protectedPaths: null, gateReasons: reasons }), false);
  assert.equal(showParkReason({ reason: 'escalation: approver, version', protectedPaths: null, gateReasons: null }), true);
});
