// The YAML subset refuses what would reach an object's prototype or silently overwrite a key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { YamlError, parse } from './yaml.ts';
import { loadConfig } from '../config/load.ts';
import { paths } from '../paths.ts';
import { CONFIG_SCHEMA_VERSION } from '../job/schema.ts';
import { ForgeError } from '../errors.ts';

function refused(src: string, line: number, message: string): void {
  assert.throws(
    () => parse(src),
    (e: any) => e instanceof YamlError && e.line === line && e.message.includes(message),
    `${JSON.stringify(src)} → line ${line}: ${message}`,
  );
}

test('prototype keys are refused with their line', () => {
  const rows: [string, number, string][] = [
    ['a: 1\n__proto__:\n  x: 1', 2, '__proto__'],
    ['daemon:\n  constructor:\n    prototype: 1', 2, 'constructor'],
    ['- prototype: 1', 1, 'prototype'],
    ['"__proto__": 1', 1, '__proto__'],
    ["'constructor': 1", 1, 'constructor'],
    ['"\\u005f_proto__": 1', 1, '__proto__'],
    ['a: {__proto__: {x: 1}}', 1, '__proto__'],
    ['a: {"constructor": 1}', 1, 'constructor'],
    ['a: [{prototype: 1}]', 1, 'prototype'],
  ];
  for (const [src, line, key] of rows) {
    refused(src, line, `key "${key}" is not allowed`);
    assert.equal(({} as any).x, undefined, src);
  }
  assert.equal(new YamlError('key "__proto__" is not allowed', 2).message, 'YAML line 2: key "__proto__" is not allowed');

  const ok = parse('a: {toString: 1}\nproto: 2\n__proto: 3');
  assert.deepEqual(Object.keys(ok), ['a', 'proto', '__proto']);
  assert.ok(Object.prototype.hasOwnProperty.call(ok.a, 'toString'));
  assert.equal(ok.a.toString, 1);
  assert.equal(Object.getPrototypeOf(ok), Object.prototype);

  const root = '/nonexistent-forge-root';
  const text = `schemaVersion: ${CONFIG_SCHEMA_VERSION}\ndaemon:\n  constructor:\n    prototype:\n      polluted: 1\n`;
  assert.throws(
    () => loadConfig(root, { text }),
    (e: any) => e instanceof ForgeError && e.code === 'config_invalid' && e.message === `${paths(root).config}: YAML line 3: key "constructor" is not allowed`,
  );
  assert.equal(({} as any).polluted, undefined);
});

test('a key keeps its text without the spaces before its colon', () => {
  assert.deepEqual(parse('key   : 1\nother key\t: two\n'), { key: 1, 'other key': 'two' });
  assert.deepEqual(parse('-x  : 2'), { '-x': 2 });
  assert.deepEqual(parse(`long${' '.repeat(10_000)}: 3`), { long: 3 });
});

test('duplicate keys are refused in block and flow maps', () => {
  refused('a: {b: 1, b: 2}', 1, 'duplicate key "b"');
  refused('a: {"b": 1, b: 2}', 1, 'duplicate key "b"');
  refused('a: 1\na: 2', 2, 'duplicate key "a"');
  assert.deepEqual(parse('a: {b: 1, c: {b: 2}}'), { a: { b: 1, c: { b: 2 } } });
});
