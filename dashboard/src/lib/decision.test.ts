// A gate's decision in flight: this tab's click, then the request queue, never a guessed next state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionInFlight, pruneSent, sentResolved, type SentDecision } from './decision.ts';
import type { ForgeRequest, Job } from './types.ts';

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

const job = (over: Partial<Job> = {}): Pick<Job, 'id' | 'state' | 'waitingOn' | 'reason' | 'issues' | 'noIssue'> => ({
  id: 'job-a',
  state: 'waiting',
  waitingOn: 'spec-approval',
  reason: 'spec ready',
  issues: [],
  noIssue: null,
  ...over,
});

test('a click shows as sending until the POST answers', () => {
  assert.deepEqual(decisionInFlight(job(), sent({ id: null, at: null }), []), { label: 'Approve spec', type: null, phase: 'sending', from: null, at: null });
});

test('a queued request shows queued, then applying once a session claims it', () => {
  assert.equal(decisionInFlight(job(), sent(), [request()])?.phase, 'queued');
  assert.equal(decisionInFlight(job(), sent(), [request({ status: 'in-progress' })])?.phase, 'applying');
  // Not listed yet: no state has been served since the POST.
  assert.equal(decisionInFlight(job(), sent(), [])?.phase, 'queued');
});

test("another tab's or the CLI's open decision shows without a label", () => {
  assert.deepEqual(decisionInFlight(job(), null, [request({ type: 'rework', from: 'cli' })]), { label: null, type: 'rework', phase: 'queued', from: 'cli', at: '2026-10-25T10:00:00.000Z' });
  assert.equal(decisionInFlight(job({ id: 'job-b' }), null, [request()]), null);
  assert.equal(decisionInFlight(job(), null, [request({ status: 'done' })]), null);
});

test('a resume shows only on a gate whose buttons send one', () => {
  const link: Partial<Job> = { waitingOn: 'issue-link', reason: 'no issue linked' };
  const rows: { name: string; job: Partial<Job>; reqs: ForgeRequest[]; type: string | null }[] = [
    { name: 'issue-link pending resume', job: link, reqs: [request({ type: 'resume', from: 'cli' })], type: null },
    { name: 'issue-link in-progress resume', job: link, reqs: [request({ type: 'resume', status: 'in-progress' })], type: null },
    { name: 'spec-approval resume', job: { issues: [{ tracker: 'github', ref: '#1', url: null }] }, reqs: [request({ type: 'resume' })], type: null },
    { name: 'unlinked spec-approval resume', job: { reason: 'spec ready, issue unlinked' }, reqs: [request({ type: 'resume' })], type: null },
    { name: 'infra resume', job: { waitingOn: 'infra' }, reqs: [request({ type: 'resume', from: 'cli' })], type: 'resume' },
    { name: 'failed resume', job: { state: 'failed', waitingOn: null }, reqs: [request({ type: 'resume', status: 'in-progress' })], type: 'resume' },
    { name: 'issue-link approve from cli', job: link, reqs: [request({ type: 'approve', from: 'cli' })], type: 'approve' },
    { name: 'older approve beats a skipped newer resume', job: link, reqs: [request({ id: 'r2', type: 'resume', createdAt: '2026-10-25T10:05:00.000Z' }), request()], type: 'approve' },
  ];
  for (const row of rows) assert.equal(decisionInFlight(job(row.job), null, row.reqs)?.type ?? null, row.type, row.name);
  assert.deepEqual(decisionInFlight(job({ waitingOn: 'infra' }), null, [request({ type: 'resume', from: 'cli' })]), {
    label: null,
    type: 'resume',
    phase: 'queued',
    from: 'cli',
    at: '2026-10-25T10:00:00.000Z',
  });
  assert.equal(decisionInFlight(job({ state: 'failed', waitingOn: null }), null, [request({ type: 'resume', status: 'in-progress' })])?.phase, 'applying');
});

test('the newest open decision wins', () => {
  const r = decisionInFlight(job(), null, [request({ id: 'r2', createdAt: '2026-10-25T10:05:00.000Z', status: 'in-progress' }), request()]);
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
