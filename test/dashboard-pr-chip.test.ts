// The PR chip only links to a url safeUrl accepts. The component's markup is not tested: tests can't import .svelte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeUrl } from '../dashboard/src/lib/markdown.ts';

test('a PR chip links only to a safe url', () => {
  for (const u of ['javascript:alert(1)', 'data:text/html,x', '//evil.example/pr/1', 'JaVaScRiPt:alert(1)', '', null, undefined]) {
    assert.equal(safeUrl(u), null, String(u));
  }
  assert.equal(safeUrl('https://github.com/acme/widgets/pull/12'), 'https://github.com/acme/widgets/pull/12');
});
