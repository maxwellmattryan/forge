// The Daemon popover's billing warning: which line it shows for /api/state's config.daemon.billing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { billingNote } from './daemon.ts';

test("billingNote picks the Daemon popover's warning", () => {
  assert.equal(billingNote(null), null);
  assert.equal(billingNote(undefined), null);
  assert.equal(billingNote({ vars: [], passed: false }), null);
  assert.deepEqual(billingNote({ vars: ['CLAUDE_CODE_USE_BEDROCK'], passed: false }), { passed: false, vars: 'CLAUDE_CODE_USE_BEDROCK' });
  assert.deepEqual(billingNote({ vars: ['A', 'B'], passed: true }), { passed: true, vars: 'A, B' });
});
