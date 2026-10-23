// The known-value redactors replace a job's known secrets, raw and JSON-escaped, longest first, before
// any text leaves Forge. Kept through the test rewrite (docs/test-rewrite/README.md): the security
// posture AGENTS.md says to preserve.
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactDeep, redactKnown } from './known-secrets.ts';

test('redactors replace raw and JSON-escaped values, longest first', () => {
  const v = 'pa"ss\\word-123';
  const short = 'abc';
  const line = JSON.stringify({ text: `x ${v} y`, n: 1, list: [v] });
  assert.doesNotMatch(redactKnown(line, [v]), /pa\\"ss/);
  assert.equal(redactKnown(line, [v]), JSON.stringify({ text: 'x [redacted] y', n: 1, list: ['[redacted]'] }));
  assert.equal(redactKnown(`raw ${v}`, [v]), 'raw [redacted]');
  assert.equal(redactKnown('abc abc', [short]), 'abc abc', 'values under 8 characters are never used');
  assert.equal(redactKnown('secret-12345678', ['secret-1234', 'secret-12345678']), '[redacted]');
  const obj = { a: `${v}!`, nested: { b: [v, 2] }, keep: true };
  const out = redactDeep(obj, [v]);
  assert.deepEqual(out, { a: '[redacted]!', nested: { b: ['[redacted]', 2] }, keep: true });
  assert.equal(obj.a, `${v}!`, 'the input is not mutated');
  assert.equal(redactDeep(obj, []), obj);
});
