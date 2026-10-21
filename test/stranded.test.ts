// Stranded jobs (lib/stranded.ts): what progress is, which turn ends leave a job undriven, and when
// the pool's resume gives way to an escalation. advance's repeated-failure park is in advance.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { progressMark, strandedAction, strandedAfterTurn } from '../lib/stranded.ts';

const own = { status: 'live' as const, jobSession: true };
const turnEnd = (o: Partial<Parameters<typeof strandedAfterTurn>[0]> = {}) => strandedAfterTurn({ job: { state: 'running' }, requested: false, agents: false, owner: own, ...o });

test('a turn that leaves its job running with nothing queued is stranded', () => {
  assert.equal(turnEnd(), true);
  for (const status of ['none', 'stale', 'dead'] as const) assert.equal(turnEnd({ owner: { status, jobSession: false } }), true, status);
});

test('a parked, queued or driven job is not', () => {
  for (const state of ['waiting', 'queued', 'blocked', 'done', 'failed', 'cancelled']) assert.equal(turnEnd({ job: { state: state as any } }), false, state);
  assert.equal(turnEnd({ requested: true }), false, 'a request is pending');
  assert.equal(turnEnd({ agents: true }), false, 'agents run in the background');
  assert.equal(turnEnd({ owner: { status: 'live', jobSession: false } }), false, 'a person took it over');
});

test('progress is pipeline movement, never heartbeats, syncs, notes or failures', () => {
  const ev = (type: string, ts: string) => ({ type, ts });
  assert.equal(progressMark([ev('verify', 't1'), ev('pr-synced', 't2'), ev('note', 't3'), ev('advance-failed', 't4'), ev('claimed', 't5')]), 't1');
  assert.equal(progressMark([ev('pr-synced', 't2')]), null);
  assert.equal(progressMark([ev('verify', 't1'), ev('pr-head-pulled', 't6')]), 't6');
});

test('the first stranded turn end resumes; a second with no progress escalates', () => {
  assert.equal(strandedAction(undefined, 't1'), 'resume');
  assert.equal(strandedAction('t1', 't1'), 'escalate');
  assert.equal(strandedAction('t1', 't2'), 'resume', 'the resume moved it');
  assert.equal(strandedAction(null, null), 'escalate', 'no progress ever, still none');
});
