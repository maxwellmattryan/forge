// The code driver's moves table, one row per input: what afterAdvance and afterRunner return for each way a
// `forge job advance` or `forge job agent run` child can end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { afterAdvance, afterRunner, type ChildEnd, type Move, type RunnerEnd, type TurnState } from './moves.ts';

const turn = (over: Partial<TurnState> = {}): TurnState => ({ inFlight: [], failedAdvances: 0, capped: 0, failedRoles: new Set(), stopping: false, ...over });
const end = (exit: number | null, json: unknown, over: Partial<ChildEnd> = {}): ChildEnd => ({ exit, signal: null, json, stderr: '', ...over });
const spawn = (role: string, extra: Record<string, unknown> = {}) => ({ action: 'spawn', rule: 'RV4', role, ran: [], ...extra });
const ran = (role: string, failure: { class: string; reason: string; resetsAt?: string | null } | null, exit = failure ? 1 : 0): RunnerEnd => ({
  role,
  ...end(exit, { id: 'j', role, status: failure ? 'failed' : 'done', failure: failure ? { resetsAt: null, ...failure } : null }),
});
const parkOf = (m: Move) => (m.move === 'park' ? m : assert.fail(`not a park: ${JSON.stringify(m)}`));

type Want = Move | ((m: Move) => void);

test("the code driver's moves", () => {
  const advanceRows: [string, ChildEnd, Partial<TurnState>, Want][] = [
    ['spawn, a role not in flight', end(0, spawn('reviewer:code', { parallel: true, spawns: [{ role: 'reviewer:docs' }, { role: 'reviewer:tests' }] })), { inFlight: ['reviewer:docs'] }, { move: 'spawn', roles: ['reviewer:code', 'reviewer:tests'], parallel: true }],
    ['spawn, one role', end(0, spawn('builder')), {}, { move: 'spawn', roles: ['builder'], parallel: false }],
    ['spawn, every role in flight', end(0, spawn('builder')), { inFlight: ['builder'] }, { move: 'wait-runners' }],
    ['wait agents, a runner in flight', end(0, { action: 'wait', waitingOn: 'agents', running: ['builder'] }), { inFlight: ['builder'] }, { move: 'wait-runners' }],
    ['wait agents, none in flight', end(0, { action: 'wait', waitingOn: 'agents', running: ['builder', 'reviewer:code'] }), {}, { move: 'end-lost', roles: ['builder', 'reviewer:code'] }],
    ['wait on a gate', end(0, { action: 'wait', waitingOn: 'spec-approval', running: [] }), {}, { move: 'end', why: 'gate' }],
    ['procedure, none in flight', end(0, { action: 'procedure', rule: 'RC1', reference: 'recall.md' }), {}, { move: 'handoff', reference: 'recall.md' }],
    ['procedure, some in flight', end(0, { action: 'procedure', rule: 'RC1', reference: 'recall.md' }), { inFlight: ['builder'] }, { move: 'wait-runners' }],
    ['done', end(0, { action: 'done', state: 'done' }), {}, { move: 'end', why: 'done' }],
    ['capped, under 10', end(0, { action: 'run', capped: true }), { capped: 9 }, { move: 'advance' }],
    ['capped, at 10', end(0, { action: 'run', capped: true }), { capped: 10 }, (m) => assert.equal(parkOf(m).reason, 'code driver: advance capped 10 times')],
    ['failed and parked', end(1, { action: 'run', failed: true, parked: true, error: 'boom' }), { failedAdvances: 1 }, { move: 'end', why: 'parked' }],
    ['failed, under 3', end(1, { action: 'run', failed: true, error: 'boom' }), { failedAdvances: 2 }, { move: 'advance' }],
    ['failed, at 3', end(1, { action: 'run', failed: true, error: 'push refused' }), { failedAdvances: 3 }, { move: 'park', waitingOn: 'escalation', reason: 'code driver: advance failed 3 times: push refused' }],
    ['exit 3', end(3, { error: { code: 'owned', message: 'driven by another' } }), {}, { move: 'end', why: 'taken-over' }],
    ['secret_found', end(1, { error: { code: 'secret_found', message: 'a key' } }), {}, { move: 'park', waitingOn: 'human', reason: 'code driver: secret scan blocked forge job advance' }],
    ['another exit', end(2, { error: { code: 'usage', message: 'bad' } }, { stderr: 'first\nforge: --session is required\n' }), {}, (m) => assert.equal(parkOf(m).reason, 'code driver: forge job advance: exit 2: forge: --session is required')],
    ['a signal', end(null, null, { signal: 'SIGKILL' }), {}, (m) => assert.equal(parkOf(m).reason, 'code driver: forge job advance: signal SIGKILL')],
    ['unparseable JSON', end(0, null), {}, (m) => assert.match(parkOf(m).reason, /^code driver: forge job advance: exit 0/)],
    ['an unknown action', end(0, { action: 'dance' }), {}, (m) => assert.match(parkOf(m).reason, /action the driver can't take \(dance\)/)],
  ];
  for (const [name, r, s, want] of advanceRows) {
    const got = afterAdvance(r, turn(s));
    if (typeof want === 'function') want(got);
    else assert.deepEqual(got, want, `advance: ${name}`);
  }

  const retried = ['auth', 'budget', 'error', 'timeout'].flatMap((cls): [string, RunnerEnd, Partial<TurnState>, Want][] => [
    [`${cls}, first time`, ran('builder', { class: cls, reason: 'r' }), { failedRoles: new Set(['reviewer:code']) }, { move: 'advance' }],
    [`${cls}, second time`, ran('builder', { class: cls, reason: 'r' }), { failedRoles: new Set(['builder']) }, (m) => assert.equal(parkOf(m).reason, `code driver: builder failed twice: ${cls}: r`)],
  ]);
  const runnerRows: [string, RunnerEnd, Partial<TurnState>, Want][] = [
    ['done', ran('builder', null), {}, { move: 'advance' }],
    ['limit with a reset', ran('builder', { class: 'limit', reason: 'usage limit', resetsAt: '2033-05-18T03:33:20.000Z' }), {}, { move: 'retry-later', at: Date.parse('2033-05-18T03:33:20.000Z') }],
    ['limit without a reset', ran('builder', { class: 'limit', reason: 'usage limit' }), {}, { move: 'retry-later', at: null }],
    ['untrusted', ran('builder', { class: 'untrusted', reason: 'a file changed' }), {}, { move: 'untrusted' }],
    ['interrupted, stopping', ran('builder', { class: 'interrupted', reason: 'the runner got SIGTERM' }), { stopping: true }, { move: 'end', why: 'stopped' }],
    ['interrupted, not stopping', ran('builder', { class: 'interrupted', reason: 'the runner got SIGTERM' }), {}, (m) => assert.equal(parkOf(m).reason, 'code driver: builder interrupted: the runner got SIGTERM')],
    ...retried,
    ['stale_step', { role: 'builder', ...end(1, { error: { code: 'stale_step', message: 'moved on' } }) }, {}, { move: 'advance' }],
    ['exit 3', { role: 'builder', ...end(3, { error: { code: 'stale_epoch', message: 'taken over' } }) }, {}, { move: 'end', why: 'taken-over' }],
    ['exit 5, exit', ran('builder', { class: 'exit', reason: 'claude closed (code 137) without a result' }, 5), {}, { move: 'park', waitingOn: 'escalation', reason: 'code driver: role child builder exit: claude closed (code 137) without a result' }],
    ['exit 5, spawn', ran('builder', { class: 'spawn', reason: 'ENOENT' }, 5), {}, (m) => assert.equal(parkOf(m).reason, 'code driver: role child builder spawn: ENOENT')],
    ['secret_found', { role: 'builder', ...end(1, { error: { code: 'secret_found', message: 'a key' } }) }, {}, { move: 'park', waitingOn: 'human', reason: 'code driver: secret scan blocked forge job agent run' }],
    ['a refusal before the start', { role: 'builder', ...end(1, { error: { code: 'error', message: 'job x has no worktree' } }) }, {}, { move: 'park', waitingOn: 'escalation', reason: 'code driver: forge job agent run builder: exit 1: job x has no worktree' }],
    ['another exit', { role: 'builder', ...end(2, null, { stderr: 'usage' }) }, {}, { move: 'park', waitingOn: 'escalation', reason: 'code driver: forge job agent run builder: exit 2: usage', endLost: 'builder' }],
    ['a signal', { role: 'builder', ...end(null, null, { signal: 'SIGKILL' }) }, {}, { move: 'park', waitingOn: 'escalation', reason: 'code driver: forge job agent run builder: signal SIGKILL', endLost: 'builder' }],
    ['unparseable JSON', { role: 'builder', ...end(0, null) }, {}, (m) => assert.equal(parkOf(m).endLost, 'builder')],
  ];
  for (const [name, r, s, want] of runnerRows) {
    const got = afterRunner(r, turn(s));
    if (typeof want === 'function') want(got);
    else assert.deepEqual(got, want, `runner: ${name}`);
  }
});

test('a park reason is one capped line, whatever the child printed', () => {
  // Option injection and log forging: the reason reaches `forge job set --reason=` and the dashboard as one line.
  const lineSeparator = String.fromCharCode(0x2028);
  const bell = String.fromCharCode(7);
  const hostile = `earlier\n--state done${lineSeparator}\`rm -rf /\`${bell}\t${'x'.repeat(400)}`;
  const { reason } = parkOf(afterAdvance(end(2, null, { stderr: hostile }), turn()));
  assert.ok(reason.startsWith('code driver: forge job advance: exit 2: --state done'), reason);
  assert.ok(reason.length <= 200, reason);
  for (const bad of ['\n', '\t', '`', lineSeparator, bell]) assert.ok(!reason.includes(bad), JSON.stringify(bad));
});
