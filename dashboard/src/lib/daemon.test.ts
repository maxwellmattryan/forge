// The Daemon popover's billing line: which text it shows for /api/state's config.daemon.billing, and whether it warns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { billingNote } from './daemon.ts';

test("billingNote picks the Daemon popover's warning", () => {
  assert.equal(billingNote(null), null);
  assert.equal(billingNote(undefined), null);
  assert.equal(billingNote({ vars: [], passed: false, warn: false }), null);
  assert.deepEqual(billingNote({ vars: ['CLAUDE_CODE_USE_BEDROCK'], passed: false, warn: true }), { passed: false, vars: 'CLAUDE_CODE_USE_BEDROCK', warn: true });
  assert.deepEqual(billingNote({ vars: ['A', 'B'], passed: true, warn: true }), { passed: true, vars: 'A, B', warn: true });
  // An API key alone under api-key: the line stays, muted, as doctor doesn't warn either.
  assert.deepEqual(billingNote({ vars: ['ANTHROPIC_API_KEY'], passed: true, warn: false }), { passed: true, vars: 'ANTHROPIC_API_KEY', warn: false });
});
