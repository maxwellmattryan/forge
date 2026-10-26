// A gate's decision in flight: this tab's click, then the request queue, never a guessed next state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionInFlight, pruneSent, sentResolved, type SentDecision } from './decision.ts';
import type { ForgeRequest } from './types.ts';

const request = (over: Partial<ForgeRequest> = {}): ForgeRequest => ({
  id: 'r1',
  type: 'approve',
  job: 'job-a',
  text: null,
  args: {},
  from: 'dashboard',
  status: 'pending',
  createdAt: '2026-10-25T10:00:00.000Z',
  ...over,
});

const sent = (over: Partial<SentDecision> = {}): SentDecision => ({ label: 'Approve spec', id: 'r1', at: '2026-10-25T10:00:00.000Z', ...over });

test('a click shows as sending until the POST answers', () => {
  assert.deepEqual(decisionInFlight('job-a', sent({ id: null, at: null }), []), { label: 'Approve spec', type: null, phase: 'sending' });
});

test('a queued request shows queued, then applying once a session claims it', () => {
  assert.equal(decisionInFlight('job-a', sent(), [request()])?.phase, 'queued');
  assert.equal(decisionInFlight('job-a', sent(), [request({ status: 'in-progress' })])?.phase, 'applying');
  // Not listed yet: no state has been served since the POST.
  assert.equal(decisionInFlight('job-a', sent(), [])?.phase, 'queued');
});

test("another tab's or the CLI's open decision shows without a label", () => {
  assert.deepEqual(decisionInFlight('job-a', null, [request({ type: 'rework', from: 'cli' })]), { label: null, type: 'rework', phase: 'queued' });
  assert.equal(decisionInFlight('job-b', null, [request()]), null);
  assert.equal(decisionInFlight('job-a', null, [request({ status: 'done' })]), null);
});

test('the newest open decision wins', () => {
  const r = decisionInFlight('job-a', null, [request({ id: 'r2', createdAt: '2026-10-25T10:05:00.000Z', status: 'in-progress' }), request()]);
  assert.equal(r?.phase, 'applying');
});

test('a sent decision resolves only once a state served after it no longer lists it', () => {
  assert.equal(sentResolved(sent(), [], '2026-10-25T10:00:01.000Z'), true);
  assert.equal(sentResolved(sent(), [request()], '2026-10-25T10:00:01.000Z'), false);
  // A state from before the request was created can't say it left.
  assert.equal(sentResolved(sent(), [], '2026-10-25T09:59:59.000Z'), false);
  assert.equal(sentResolved(sent({ id: null, at: null }), [], '2026-10-25T10:00:01.000Z'), false);
  assert.equal(sentResolved(sent(), [], null), false);
});

test('pruneSent drops the resolved and keeps the same map when none resolved', () => {
  const map = { 'job-a': sent(), 'job-b': sent({ id: 'r2' }) };
  const r = pruneSent(map, [request({ id: 'r2', job: 'job-b' })], '2026-10-25T10:00:01.000Z');
  assert.deepEqual(r.resolved, ['r1']);
  assert.deepEqual(Object.keys(r.sent), ['job-b']);
  const same = { 'job-a': sent() };
  assert.equal(pruneSent(same, [request()], '2026-10-25T10:00:01.000Z').sent, same);
});
