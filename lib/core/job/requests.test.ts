// Request routing: the scopes a daemon session may run in, where a gate request goes, the one gate
// request with no job (a goal mandate's milestone draft), and the requeue of a gate whose assistant
// foreman exited.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tempRepo } from '../../../test/helpers.ts';
import { defaults } from '../config/keys/defaults.ts';
import { ForgeError } from '../errors.ts';
import { ASSISTANTS_SCOPE, INBOX_SCOPE, OFFICE_SCOPE, assistantScope, claimRequest, enqueue, listRequests, requestScope, requeueOrphans, sharedScope, validScope } from './requests.ts';

test('assistant scopes, the gate route and shared scopes', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  const valid: [unknown, boolean][] = [
    ['_assistant-1', true],
    ['_assistant-16', true],
    ['_assistant-0', false],
    ['_assistant-17', false],
    ['_assistant-01', false],
    ['_assistant-', false],
    ['_assistant-1x', false],
    ['_assistants', false],
  ];
  for (const [s, want] of valid) assert.equal(validScope(s), want, `validScope(${JSON.stringify(s)})`);
  assert.equal(requestScope(r.dir, { type: 'gate', job: 'j-1' }), ASSISTANTS_SCOPE);
  assert.equal(requestScope(r.dir, { type: 'direct' }), OFFICE_SCOPE);
  const shared: [unknown, boolean][] = [
    [INBOX_SCOPE, true],
    [OFFICE_SCOPE, true],
    [ASSISTANTS_SCOPE, true],
    ['_assistant-3', true],
    ['j-1', false],
  ];
  for (const [s, want] of shared) assert.equal(sharedScope(s), want, `sharedScope(${JSON.stringify(s)})`);
  assert.equal(assistantScope(16), '_assistant-16');
  assert.throws(() => assistantScope(17));
  assert.throws(() => assistantScope(0));
});

test('a gate request without a job is only a milestone draft with a valid mandate id', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  const args = { gate: 'milestone-approval', mandate: 'g1', key: '1-a', digest: 'd'.repeat(64), reserved: null };
  for (const job of [null, undefined]) {
    const ok = enqueue(r.dir, null, { type: 'gate', job, args, from: 'forge' });
    assert.deepEqual([ok.job, ok.args], [null, args], `job ${job}`);
    assert.equal(requestScope(r.dir, ok), ASSISTANTS_SCOPE);
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

test('a gate claimed by an exited assistant goes back to pending', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  const req = enqueue(r.dir, defaults(), { type: 'gate', job: 'j-1', args: { gate: 'spec-approval' } });
  claimRequest(r.dir, req.id, 'sess-a');
  const asked: string[] = [];
  const out = requeueOrphans(r.dir, { leaseOf: (s) => (asked.push(s), null), exited: ['sess-a'] });
  assert.deepEqual(out.requeued.map((x) => x.id), [req.id]);
  assert.equal(listRequests(r.dir).find((x) => x.id === req.id)?.status, 'pending');
  assert.ok(!asked.includes(ASSISTANTS_SCOPE), 'no lease is read for the gate group');
});
