// Request routing: the scopes a daemon session may run in, where a gate request goes, and the
// requeue of a gate whose assistant foreman exited.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tempRepo } from '../../../test/helpers.ts';
import { defaults } from '../config/keys/defaults.ts';
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
