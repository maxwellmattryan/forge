// Request routing: the scopes a daemon session may run in, where a gate request goes (the gate group no
// session serves), the one gate request with no job (a goal mandate's milestone draft), the Foreman's
// authority object, and how a gate run's claim is given back or requeued.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tempRepo } from '../../../test/helpers.ts';
import { defaults } from '../config/keys/defaults.ts';
import { ForgeError } from '../errors.ts';
import {
  GATES_SCOPE,
  INBOX_SCOPE,
  OFFICE_SCOPE,
  chatIdOf,
  chatScope,
  claimRequest,
  daemonScope,
  enqueue,
  holdsForemanAuthority,
  inChat,
  isChatScope,
  issueForemanAuthority,
  listRequests,
  releaseClaim,
  requestScope,
  requeueOrphans,
  servesScope,
  sharedScope,
  validRuntimeScope,
  validScope,
} from './requests.ts';

test('the gate group, shared scopes and runtime scopes', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  // [scope, a session may run in it, a runtime file may be named after it]
  const rows: [unknown, boolean, boolean][] = [
    [INBOX_SCOPE, true, true],
    [OFFICE_SCOPE, true, true],
    [GATES_SCOPE, false, true],
    ['_assistant-1', false, true],
    ['_assistant-16', false, true],
    ['_assistant-0', false, false],
    ['_assistant-17', false, false],
    ['_assistant-01', false, false],
    ['_assistant-1x', false, false],
    ['_assistants', false, false],
    ['j-1', true, true],
  ];
  for (const [s, valid, runtime] of rows) {
    assert.equal(validScope(s), valid, `validScope(${JSON.stringify(s)})`);
    assert.equal(validRuntimeScope(s), runtime, `validRuntimeScope(${JSON.stringify(s)})`);
  }
  assert.equal(requestScope(r.dir, { type: 'gate', job: 'j-1' }), GATES_SCOPE);
  assert.equal(requestScope(r.dir, { type: 'direct' }), OFFICE_SCOPE);
  for (const [s, want] of [[INBOX_SCOPE, true], [OFFICE_SCOPE, true], [GATES_SCOPE, true], ['_assistant-3', false], ['j-1', false]] as const)
    assert.equal(sharedScope(s), want, `sharedScope(${JSON.stringify(s)})`);
  // No session serves the gate group, whatever its scope.
  for (const s of [INBOX_SCOPE, OFFICE_SCOPE, '_chat-0123456789ab', 'j-1', '_assistant-1']) assert.equal(servesScope(s, GATES_SCOPE), false, s);
  assert.equal(servesScope('j-1', 'j-1'), true);
  assert.deepEqual(daemonScope({ FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: GATES_SCOPE }), { problem: "forge refuses: a gate run's assistant runs no forge commands" });
  assert.ok('problem' in daemonScope({ FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '_assistant-1' }), 'a legacy assistant scope is a broken scope');
});

test('only an issued authority holds the Foreman authority', () => {
  const a = issueForemanAuthority();
  assert.equal(holdsForemanAuthority(a), true);
  assert.ok(Object.isFrozen(a));
  for (const v of [null, undefined, {}, { kind: 'foreman-authority' }, { ...a }, JSON.parse(JSON.stringify(a)), { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '_assistant-1' }, 'foreman'])
    assert.equal(holdsForemanAuthority(v), false, JSON.stringify(v));
});

test('a gate run gives its claim back uncounted', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  const req = enqueue(r.dir, defaults(), { type: 'gate', job: 'j-1', args: { gate: 'spec-approval' } });
  claimRequest(r.dir, req.id, 'gate-run:a');
  assert.equal(releaseClaim(r.dir, req.id, 'gate-run:b'), false, "another session's claim stays");
  assert.equal(releaseClaim(r.dir, req.id, 'gate-run:a'), true);
  const rec = listRequests(r.dir).find((x) => x.id === req.id)!;
  assert.deepEqual([rec.status, rec.session, rec.requeues], ['pending', undefined, undefined]);
  assert.equal(releaseClaim(r.dir, req.id, 'gate-run:a'), false, 'a pending request has no claim to give back');
});

test('chat scopes', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  const good = '_chat-0123456789ab';
  const rows: [unknown, boolean][] = [
    [good, true],
    ['_chat-ffffffffffff', true],
    ['_chat-', false],
    ['_chat-ABCDEF012345', false],
    ['_chat-0123456789a', false],
    ['_chat-0123456789abc', false],
    ['_chat-../aaaaaaaaaa', false],
    ['_chats', false],
    [`${good}\n`, false],
    [12, false],
  ];
  for (const [s, want] of rows) {
    assert.equal(isChatScope(s), want, `isChatScope(${JSON.stringify(s)})`);
    assert.equal(validScope(s), want, `validScope(${JSON.stringify(s)})`);
    assert.equal(sharedScope(s), want, `sharedScope(${JSON.stringify(s)})`);
  }
  assert.equal(chatScope('0123456789ab'), good);
  assert.equal(chatIdOf(good), '0123456789ab');
  assert.equal(chatIdOf('_inbox'), null);
  for (const bad of ['', '0123456789AB', '0123456789a', '../aaaaaaaaa', 'x'.repeat(12)]) assert.throws(() => chatScope(bad), /no chat/);
  // No request ever routes to a chat: its scope is no job id, so even a job request naming it goes to the inbox.
  for (const type of ['resume', 'rework', 'gate', 'draft', 'sync']) assert.ok(!isChatScope(requestScope(r.dir, { type, job: good })), type);
  assert.equal(requestScope(r.dir, { type: 'resume', job: good }), INBOX_SCOPE);
  assert.equal(inChat({ FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: good }), true);
  assert.equal(inChat({ FORGE_DAEMON_SCOPE: good }), false, 'outside a daemon session');
  assert.equal(inChat({ FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '_inbox' }), false);
});

test('a gate request without a job is only a milestone draft with a valid mandate id', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  const args = { gate: 'milestone-approval', mandate: 'g1', key: '1-a', digest: 'd'.repeat(64), reserved: null };
  for (const job of [null, undefined]) {
    const ok = enqueue(r.dir, null, { type: 'gate', job, args, from: 'forge' });
    assert.deepEqual([ok.job, ok.args], [null, args], `job ${job}`);
    assert.equal(requestScope(r.dir, ok), GATES_SCOPE);
  }
  const refused: [string, { job?: string | null; args?: Record<string, unknown> }][] = [
    ['another gate class', { job: null, args: { ...args, gate: 'spec-approval' } }],
    ['a mandate id that climbs', { job: null, args: { ...args, mandate: '../x' } }],
    ['the mandate id none', { job: null, args: { ...args, mandate: 'none' } }],
    ['an upper-case mandate id', { job: null, args: { ...args, mandate: 'G1' } }],
    ['a mandate id that is not text', { job: null, args: { ...args, mandate: 7 } }],
    ['no mandate', { job: null, args: { gate: 'milestone-approval' } }],
    ['no gate', { job: null, args: { mandate: 'g1' } }],
    ['no args', { job: null }],
    ['a job that climbs', { job: '../../x', args }],
    ['an empty job', { job: '', args }],
  ];
  const before = listRequests(r.dir).length;
  const isRefusal = (e: unknown) => e instanceof ForgeError && e.message === 'a gate request needs a valid job';
  for (const [name, req] of refused) assert.throws(() => enqueue(r.dir, null, { type: 'gate', ...req, from: 'forge' }), isRefusal, name);
  assert.equal(listRequests(r.dir).length, before, 'a refused request writes nothing');
});

test('a gate claimed by a failed gate run goes back to pending', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  const req = enqueue(r.dir, defaults(), { type: 'gate', job: 'j-1', args: { gate: 'spec-approval' } });
  claimRequest(r.dir, req.id, 'gate-run:a');
  const asked: string[] = [];
  const out = requeueOrphans(r.dir, { leaseOf: (s) => (asked.push(s), null), exited: ['gate-run:a'], byAge: false });
  assert.deepEqual(out.requeued.map((x) => x.id), [req.id]);
  assert.equal(listRequests(r.dir).find((x) => x.id === req.id)?.status, 'pending');
  assert.ok(!asked.includes(GATES_SCOPE), 'no lease is read for the gate group');
});
