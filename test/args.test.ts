import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { num, oneOf, parseArgs, requireJob, str } from '../lib/commands/args.ts';
import { ForgeError, coerce } from '../lib/util.ts';

test('parseArgs: bare, empty and repeated flags', () => {
  assert.deepEqual(parseArgs(['--x']).flags, { x: true });
  assert.deepEqual(parseArgs(['--x=']).flags, { x: '' });
  assert.deepEqual(parseArgs(['--x', '1', '--x', '2']).flags, { x: ['1', '2'] });
  const { flags, pos } = parseArgs(['--a', '--b', 'v', 'p']);
  assert.equal(flags.a, true, 'a value starting with -- is not swallowed');
  assert.equal(flags.b, 'v');
  assert.deepEqual(pos, ['p']);
});

test('--quiet takes no value', () => {
  const { flags, pos } = parseArgs(['dash', '--quiet', 'x']);
  assert.equal(flags.quiet, true);
  assert.deepEqual(pos, ['dash', 'x']);
});

test('str: missing values and repeats fail, strings pass through', () => {
  assert.equal(str(undefined, '--job'), undefined);
  assert.equal(str('j1', '--job'), 'j1');
  assert.equal(str('--weird', '--job'), '--weird');
  assert.throws(() => str(true, '--job'), (e: unknown) => e instanceof ForgeError && e.exitCode === 2 && /^missing value for --job \(write --job=<value> if the value starts with --\)$/.test(e.message));
  assert.throws(() => str('', '--note'), /missing value for --note/);
  assert.throws(() => str(['a', 'b'], '--session'), /--session given more than once/);
});

test('num: non-negative numbers, with an integer mode', () => {
  assert.equal(num(undefined, '--tokens'), undefined);
  assert.equal(num('0', '--tokens'), 0);
  assert.equal(num('1.5', '--duration-ms'), 1.5);
  assert.equal(num('20', '--limit', { integer: true }), 20);
  assert.throws(() => num(true, '--tokens'), /missing value for --tokens/);
  assert.throws(() => num('', '--tokens'), /missing value for --tokens/);
  assert.throws(() => num('abc', '--tokens'), (e: unknown) => e instanceof ForgeError && e.message === '--tokens must be a non-negative number (got "abc")');
  assert.throws(() => num('-5', '--tokens'), /--tokens must be a non-negative number \(got "-5"\)/);
  assert.throws(() => num('Infinity', '--tokens'), /non-negative number/);
  assert.throws(() => num(['1', '2'], '--tokens'), /non-negative number/);
  assert.throws(() => num('1.5', '--limit', { integer: true }), /--limit must be a non-negative integer \(got "1.5"\)/);
  assert.throws(() => num('-1', '--limit', { integer: true }), /non-negative integer/);
});

test('oneOf: missing and unknown values name the allowed set', () => {
  const allowed = ['a', 'b'] as const;
  assert.equal(oneOf('a', allowed, 'action'), 'a');
  assert.throws(() => oneOf(undefined, allowed, 'action'), (e: unknown) => e instanceof ForgeError && e.message === 'missing action (a|b)');
  assert.throws(() => oneOf(true, allowed, 'action'), /missing action \(a\|b\)/);
  assert.throws(() => oneOf('c', allowed, 'action'), (e: unknown) => e instanceof ForgeError && e.message === 'unknown action "c" (a, b)');
});

test('requireJob: an unknown id throws and creates no directory', () => {
  const repo = tempRepo();
  try {
    assert.throws(() => requireJob(repo.dir, 'nope'), /no job "nope" \(looked in /);
    assert.equal(fs.existsSync(path.join(repo.dir, '.forge', 'jobs', 'nope')), false);
    assert.throws(() => requireJob(repo.dir, undefined), /missing job id/);
    assert.throws(() => requireJob(repo.dir, '../x'), /invalid job id/);
  } finally {
    repo.cleanup();
  }
});

test('coerce: unparseable JSON throws with the quoted form; other values coerce as before', () => {
  assert.equal(coerce('2'), 2);
  assert.equal(coerce('-1.5'), -1.5);
  assert.equal(coerce('true'), true);
  assert.equal(coerce('false'), false);
  assert.equal(coerce('null'), null);
  assert.equal(coerce('bug'), 'bug');
  assert.equal(coerce('"code"'), '"code"', 'a quoted scalar stays the raw string');
  assert.deepEqual(coerce('["code"]'), ['code']);
  assert.deepEqual(coerce('{"a":1}'), { a: 1 });
  assert.deepEqual(coerce('[]'), []);
  assert.throws(
    () => coerce('[code,tests]', 'reviewers'),
    (e: unknown) => e instanceof ForgeError && e.exitCode === 2 && e.message === `--field reviewers: "[code,tests]" is not valid JSON; quote it for the shell, e.g. --field 'reviewers=["code","tests"]'`,
  );
  assert.throws(() => coerce('[ a , , b ]', 'services'), /--field 'services=\["a","b"\]'/);
  assert.throws(() => coerce('[[x]', 'k'), /--field 'k=\["a","b"\]'/);
  assert.throws(() => coerce('{k:v}', 'meta'), /--field meta: "\{k:v\}" is not valid JSON; quote it for the shell, e.g. --field 'meta=\{"k":"v"\}'/);
  assert.throws(() => coerce('[oops'), /--field value: /);
  // The echoed value is capped, so a huge paste doesn't flood the one-line error.
  const long = '[' + 'x'.repeat(10_000);
  assert.throws(() => coerce(long, 'k'), (e: unknown) => e instanceof Error && e.message.length < 200);
});
