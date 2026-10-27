// The milestone draft card's model: issues by wave, the actions each gate status offers, the exact POST
// body with the pins the card read, the Needs-you count with drafts, and the Queued row's subject.
import test from 'node:test';
import assert from 'node:assert/strict';
import { draftCardActions, draftDecisionBody, postDraftDecision, wavesOf } from './drafts.ts';
import { needsCount, requestSubject } from './inbox.ts';
import { setProject } from './project.ts';
import type { DraftGate, DraftIssue, ForgeRequest, StateJob } from './types.ts';

const issue = (key: string, wave: number): DraftIssue => ({ key, title: key, why: 'w', whatToDo: 'd', done: 'x', stat: 's', wave, dependsOn: [], files: [`${key}/`], existing: null });

test('wavesOf groups issues by wave, keeping draft order within one', () => {
  const draft = { issues: [issue('c', 2), issue('a', 1), issue('d', 3), issue('b', 1), issue('e', 2)] };
  assert.deepEqual(
    wavesOf(draft).map((w) => [w.wave, w.issues.map((i) => i.key)]),
    [
      [1, ['a', 'b']],
      [2, ['c', 'e']],
      [3, ['d']],
    ],
  );
});

test('the actions each gate status offers', () => {
  assert.deepEqual(draftCardActions('pending'), ['approve', 'revise', 'reject']);
  assert.deepEqual(draftCardActions('filing'), ['retry']);
});

test('needsCount adds the drafts', () => {
  const urgent = { id: 'j1', state: 'waiting', waitingOn: 'spec-approval' } as unknown as StateJob;
  const running = { id: 'j2', state: 'running', waitingOn: null } as unknown as StateJob;
  const draft = { mandate: 'g1' } as DraftGate;
  assert.equal(needsCount([urgent, running], []), 1);
  assert.equal(needsCount([urgent, running], [draft, { ...draft, mandate: 'g2' }]), 3);
  assert.equal(needsCount([], undefined), 0);
});

test('draftDecisionBody pins the request and digest the card read', async () => {
  const digest = 'a'.repeat(64);
  assert.deepEqual(draftDecisionBody('approve', '1-abc', digest, '  '), { decision: 'approve', request: '1-abc', digest, note: null });
  assert.deepEqual(draftDecisionBody('revise', '1-abc', digest, ' split issue b \n'), { decision: 'revise', request: '1-abc', digest, note: 'split issue b' });
  setProject('p');
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ error: 'the draft changed since you read it (now 2-x)' }), { status: 409 });
  }) as unknown as typeof fetch;
  await assert.rejects(postDraftDecision('g1', draftDecisionBody('reject', '1-abc', digest, ''), fetchImpl), /the draft changed since you read it/);
  assert.equal(seen[0].url, '/api/p/p/mandates/g1/draft');
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), { decision: 'reject', request: '1-abc', digest, note: null });
  setProject(null);
});

test("requestSubject names a request's job or mandate", () => {
  const r = (over: Partial<ForgeRequest>) => ({ type: 'draft', job: null, args: {}, ...over }) as Pick<ForgeRequest, 'type' | 'job' | 'args'>;
  assert.deepEqual(requestSubject(r({ type: 'draft', args: { mandate: 'g1' } })), { mandate: 'g1' });
  assert.deepEqual(requestSubject(r({ type: 'gate', args: { gate: 'milestone-approval', mandate: 'g1', key: '1-a' } })), { mandate: 'g1' });
  assert.deepEqual(requestSubject(r({ type: 'gate', job: null, args: { gate: 'release', mandate: 'm1' } })), { mandate: 'm1' });
  assert.deepEqual(requestSubject(r({ type: 'resume', job: 'j-1' })), { job: 'j-1' });
  assert.equal(requestSubject(r({ type: 'draft', args: { mandate: '../x' } })), null);
  assert.equal(requestSubject(r({ type: 'draft', args: { mandate: 'none' } })), null);
  assert.equal(requestSubject(r({ type: 'gate', args: { gate: 'spec-approval', mandate: 'g1' } })), null, 'only a milestone-approval or release gate names a mandate');
  assert.equal(requestSubject(r({ type: 'next' })), null);
});
