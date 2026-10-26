// deepMerge is the last guard before config and answers files reach a copied object.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deepMerge } from './shape.ts';
import { ForgeError } from './errors.ts';

test('deepMerge refuses own prototype keys', () => {
  assert.throws(
    () => deepMerge({}, JSON.parse('{"__proto__":{"x":1}}')),
    (e: any) => e instanceof ForgeError && e.code === 'usage' && e.message === 'merge source key "__proto__" is not allowed',
  );
  assert.equal(({} as any).x, undefined);
});
