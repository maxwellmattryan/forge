import test from 'node:test';
import assert from 'node:assert/strict';
import { deepMerge, getPath, setPath } from '#core/shape.ts';
import { ForgeError } from '#core/errors.ts';

const refused = (label: string, key: string) => (e: unknown) =>
  e instanceof ForgeError && e.code === 'usage' && e.message === `${label} key ${JSON.stringify(key)} is not allowed`;

test('deepMerge merges into a copy and refuses prototype keys', () => {
  const base = { a: { b: 1, c: [1, 2] }, list: [{ x: 1 }], keep: true };
  const over = { a: { c: [3], d: 'new' }, list: 'replaced', added: null };
  const baseCopy = structuredClone(base);
  const overCopy = structuredClone(over);
  const out = deepMerge(base, over);
  assert.deepEqual(out, { a: { b: 1, c: [3], d: 'new' }, list: 'replaced', keep: true, added: null });
  assert.deepEqual(base, baseCopy);
  assert.deepEqual(over, overCopy);
  // Copies, not shared references: changing the result touches neither input.
  out.a.c.push(4);
  (deepMerge(base, {}) as any).list[0].x = 9;
  assert.deepEqual(base, baseCopy);
  assert.deepEqual(over, overCopy);
  // A non-map side counts as empty.
  assert.deepEqual(deepMerge(base, null), baseCopy);
  assert.deepEqual(deepMerge(null as any, { a: 1 }), { a: 1 });

  const hostile: [unknown, unknown, string, string][] = [
    [{}, JSON.parse('{"__proto__": {"polluted": 1}}'), 'merge source', '__proto__'],
    [{}, JSON.parse('{"a": {"constructor": {"prototype": {"polluted": 1}}}}'), 'merge source', 'constructor'],
    [{}, JSON.parse('{"a": [{"b": 1}, {"__proto__": {"polluted": 1}}]}'), 'merge source', '__proto__'],
    [{}, JSON.parse('{"a": {"prototype": 1}}'), 'merge source', 'prototype'],
    [JSON.parse('{"__proto__": {"polluted": 1}}'), {}, 'merge base', '__proto__'],
    [JSON.parse('{"a": [[{"constructor": 1}]]}'), { a: 1 }, 'merge base', 'constructor'],
  ];
  for (const [b, o, label, key] of hostile) {
    assert.throws(() => deepMerge(b as any, o), refused(label, key));
    assert.equal(({} as any).polluted, undefined);
  }
  assert.throws(() => deepMerge({}, JSON.parse('{"x": {"__proto__": 1}}'), { over: 'config sink values' }), refused('config sink values', '__proto__'));
  assert.throws(() => deepMerge(JSON.parse('{"__proto__": 1}'), {}, { base: 'defaults' }), refused('defaults', '__proto__'));
  assert.equal(({} as any).polluted, undefined);

  // Runaway nesting is a refusal, not a RangeError from the recursion.
  let deep: Record<string, any> = {};
  for (let i = 0; i < 5000; i++) deep = { a: deep };
  assert.throws(() => deepMerge({}, deep), (e: unknown) => e instanceof ForgeError && e.code === 'usage' && /^merge source is nested more than \d+ levels deep$/.test(e.message));
  assert.throws(() => deepMerge(deep, {}), (e: unknown) => e instanceof ForgeError && e.code === 'usage' && /^merge base is nested/.test(e.message));
});

test('setPath and getPath refuse prototype segments', () => {
  for (const dotted of ['__proto__.x', 'a.constructor.prototype.x', 'a.prototype']) {
    const obj: any = { a: {} };
    assert.throws(() => setPath(obj, dotted, 1), (e: unknown) => e instanceof ForgeError && e.code === 'usage');
    assert.deepEqual(obj, { a: {} });
    assert.equal(({} as any).x, undefined);
    assert.equal(getPath({ a: { prototype: 1 } }, dotted), undefined);
  }
  assert.equal(getPath({}, '__proto__'), undefined);
  assert.equal(getPath({}, 'constructor'), undefined);
  const config = { tracker: { kind: 'local' }, review: { panel: [{ name: 'code' }] } };
  assert.equal(getPath(config, 'tracker.kind'), 'local');
  assert.equal(getPath(config, 'review.panel.0.name'), 'code');
  assert.equal(getPath(config, ''), config);
  const obj: any = {};
  setPath(obj, 'a.b.c', 2);
  assert.deepEqual(obj, { a: { b: { c: 2 } } });
});
