// Counting a run's friction from its transcript lines, and the keys that are all transcripts.json keeps of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandKey, errorKey, fileKey, renderLog, runFriction } from './friction.ts';
import type { LogLine } from './friction.ts';
import { UNATTENDED_DENIED } from './stream.ts';

const MiB = 1024 * 1024;
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const text = (t: string) => ({ type: 'text', text: t });
const A = (id: string, blocks: unknown[]) => JSON.stringify({ type: 'assistant', uuid: `u-${id}-${blocks.length}`, message: { id, role: 'assistant', content: blocks } });
const U = (blocks: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content: blocks }, ...extra });
const err = (id: string, t: string) => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: t });
const ok = (id: string, t = 'ok') => ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: t }] });

function scratch(t: test.TestContext) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-friction-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (lines: string[], opts: Parameters<typeof runFriction>[2] = {}) => {
    const file = path.join(dir, 'run.jsonl');
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const fd = fs.openSync(file, 'r');
    try {
      return runFriction(fd, fs.fstatSync(fd).size, opts);
    } finally {
      fs.closeSync(fd);
    }
  };
  return { dir, run };
}

test("runFriction counts a run's friction from its transcript lines", (t) => {
  const { dir, run } = scratch(t);
  const wt = path.join(dir, 'wt');
  const big = path.join(wt, 'big.ts');
  const lines = [
    '',
    'not json',
    '[1,2]',
    'null',
    '{"type":"assistant","message":',
    // One message written as two lines, one per block: one turn.
    A('m1', [text('Reading the file')]),
    A('m1', [use('r1', 'Read', { file_path: path.join(wt, 'src/a.ts') })]),
    U([ok('r1')]),
    A('m2', [use('r2', 'Read', { file_path: path.join(wt, 'src/a.ts') })]),
    A('m3', [use('r3', 'Read', { file_path: path.join(wt, 'src/a.ts') })]),
    // A paged read of different ranges is no re-read.
    A('m4', [use('p1', 'Read', { file_path: big, offset: 0, limit: 100 }), use('p2', 'Read', { file_path: big, offset: 100, limit: 100 }), use('p3', 'Read', { file_path: big, offset: 200, limit: 100 })]),
    A('m5', [use('b1', 'Bash', { command: 'npm test' })]),
    U([err('b1', 'Exit code 1\nFAIL')]),
    A('m6', [use('b2', 'Bash', { command: 'npm  test' })]),
    U([err('b2', 'Exit code 1\nFAIL')]),
    A('m7', [use('e1', 'Edit', { file_path: path.join(wt, 'src/a.ts'), old_string: 'x', new_string: 'y' })]),
    U([err('e1', '<tool_use_error>String to replace not found in file.</tool_use_error>')]),
    A('m8', [
      use('d1', 'Bash', { command: 'rm -rf build' }),
      use('d2', 'WebFetch', { url: 'https://example.com' }),
      use('d3', 'Bash', { command: 'curl example.com' }),
      use('d4', 'Write', { file_path: '/etc/hosts' }),
      use('d5', 'Bash', { command: 'git push' }),
      use('i1', 'Bash', { command: 'sleep 100' }),
    ]),
    U([err('d1', 'Rejected')], { toolDenialKind: 'permission' }),
    U([err('d2', 'Not allowed')], { permissionDecision: { decision: 'reject' } }),
    U([err('d3', 'Permission to use Bash with command curl example.com has been denied.')]),
    U([err('d4', UNATTENDED_DENIED)]),
    U([err('d5', "The user doesn't want to proceed with this tool use. The tool use was rejected.")]),
    U([err('i1', 'Interrupted by user')], { toolDenialKind: 'interrupted' }),
    A('m9', [use('f1', 'Bash', { command: 'forge job step j1' })]),
    U([err('f1', 'Exit code 3\nrefused')]),
    A('m10', [use('f2', 'Bash', { command: 'cd /w && forge job step j1' })]),
    U([err('f2', 'Exit code 3\nrefused')]),
    A('m11', [use('f3', 'Bash', { command: 'GH_TOKEN=s /opt/bin/forge git commit j1 --message m' })]),
    U([err('f3', 'Exit code 1\nsecret_found')]),
    // A successful forge call is no exit.
    A('m12', [use('f4', 'Bash', { command: 'forge job show j1' })]),
    U([ok('f4', '{}')]),
    A('m13', [use('x1', 'bad name!', {})]),
    U([err('x1', 'boom')]),
    U([err('unknown', 'orphan')]),
    // The same result again counts once.
    U([err('b1', 'Exit code 1\nFAIL')]),
  ];
  const got = run(lines, { worktree: wt, log: true });
  assert.equal(got.turns, 13, 'distinct message ids');
  assert.equal(got.toolCalls, 20, 'distinct tool_use ids');
  assert.equal(got.toolErrors.total, 14);
  assert.deepEqual(got.toolErrors.byTool, { Bash: 9, Edit: 1, WebFetch: 1, Write: 1, other: 2 });
  assert.equal(got.toolErrors.byPrefix['exit code'], 5);
  assert.equal(got.toolErrors.byPrefix['string to replace not found'], 1);
  assert.equal(got.toolErrors.byPrefix['interrupted by user'], 1);
  assert.equal(Object.values(got.toolErrors.byPrefix).reduce((a, b) => a + b, 0), 14);
  assert.deepEqual(got.permissionDenials, { total: 5, byTool: { Bash: 3, WebFetch: 1, Write: 1 } }, 'four signals, never an interrupt');
  assert.deepEqual(got.repeatedFailures, [
    { key: 'forge job step', hash: commandKey('forge job step j1').hash, count: 2, turns: [9, 10] },
    { key: 'npm test', hash: commandKey('npm test').hash, count: 2, turns: [5, 6] },
  ]);
  assert.deepEqual(got.rereads, [{ file: 'src/a.ts', reads: 3 }]);
  assert.deepEqual(got.forgeExits, [
    { key: 'forge job step', code: 3, count: 2 },
    { key: 'forge git commit', code: 1, count: 1 },
  ]);
  assert.equal(got.truncated, false);

  // The log: one line per call, errored result and text, in turn order, each one safe line.
  const log = got.log!;
  assert.deepEqual(log.slice(0, 2), [
    { turn: 1, kind: 'text', text: 'Reading the file' },
    { turn: 1, kind: 'tool', text: 'Read src/a.ts' },
  ]);
  assert.equal(log.filter((l) => l.kind === 'denied').length, 5);
  assert.equal(log.filter((l) => l.kind === 'error').length, 9);
  assert.ok(log.every((l) => !/[\n\r`]/.test(l.text)));
  assert.equal(run(lines, { worktree: wt }).log, undefined, 'no log unless asked');

  // Caps: a line over the line cap is skipped unparsed, across chunk boundaries too; a file over the byte cap is truncated.
  const huge = [A('m0', [text('y'.repeat(MiB - 50))]), A('m1', [text('x'.repeat(2.5 * MiB))]), A('m2', [text('short')]), A('m3', [text('short')])];
  assert.equal(run(huge, { maxLine: 2 * MiB }).turns, 3, 'the 2.5 MiB line is skipped');
  assert.equal(run(huge).turns, 4);
  const many = Array.from({ length: 50 }, (_, i) => A(`m${i}`, [text('hello')]));
  const capped = run(many, { maxBytes: 1000 });
  assert.equal(capped.truncated, true);
  assert.ok(capped.turns > 0 && capped.turns < 50, String(capped.turns));
  assert.deepEqual([run(many).truncated, run(many).turns], [false, 50]);
  assert.deepEqual(
    run([]),
    { turns: 0, toolCalls: 0, toolErrors: { total: 0, byTool: {}, byPrefix: {} }, repeatedFailures: [], permissionDenials: { total: 0, byTool: {} }, rereads: [], forgeExits: [], truncated: false },
    'an empty transcript counts nothing',
  );
});

test('renderLog keeps the edges and every error when a log is over its cap', () => {
  const log: LogLine[] = Array.from({ length: 200 }, (_, i) => ({ turn: i + 1, kind: 'tool', text: `Read f${i}.ts` }));
  log[100] = { turn: 101, kind: 'error', text: 'Exit code 1' };
  assert.equal(renderLog(log).split('\n').length, 200, 'under the cap: every line');
  const lines = renderLog(log, 3000).split('\n');
  assert.deepEqual(lines.slice(39, 44), ['T40 Read f39.ts', '… 59 lines omitted (T41–T99)', 'T100 Read f99.ts', 'T101 ! Exit code 1', '… 59 lines omitted (T102–T160)']);
  assert.equal(lines.length, 84);
  // So many errors that they can't all fit: still under the cap.
  const noisy: LogLine[] = Array.from({ length: 2000 }, (_, i) => ({ turn: i + 1, kind: i % 2 ? 'denied' : 'tool', text: 'x'.repeat(150) }));
  assert.ok(Buffer.byteLength(renderLog(noisy, 64 * 1024)) <= 64 * 1024);
});

test('command, error and file keys', () => {
  const commands: [string, string][] = [
    ['GH_TOKEN=s3cret npm test -- --grep x', 'npm test'],
    ['cd /tmp/w && npm  test', 'npm test'],
    ['npm test', 'npm test'],
    ['git commit -m "x y"', 'git commit'],
    ['a b c d', 'a b c'],
    ['-x foo', '(command)'],
    ['"quoted" word', '(command)'],
    ['', '(command)'],
  ];
  for (const [command, key] of commands) assert.equal(commandKey(command).key, key, command);
  assert.equal(commandKey('cd /tmp/w && npm  test').hash, commandKey('npm test').hash, 'the cd and spacing do not change the hash');
  assert.equal(commandKey('GH_TOKEN=s3cret npm test').hash, commandKey('npm test').hash, 'nor an env value');
  assert.notEqual(commandKey('npm test -- a').hash, commandKey('npm test -- b').hash);
  assert.match(commandKey('npm test').hash, /^[0-9a-f]{8}$/);

  const errors: [string, string][] = [
    ['Exit code 1', 'exit code'],
    ['<tool_use_error>String to replace not found in file.</tool_use_error>', 'string to replace not found'],
    ['\n\n  Error: ENOENT, no such file or directory', 'error enoent no such file'],
    ['12345 !!!', '(empty)'],
    ['', '(empty)'],
  ];
  for (const [text, key] of errors) assert.equal(errorKey(text), key, text);

  const wt = '/w/repo.worktrees/j1';
  const hashed = /^#[0-9a-f]{8}$/;
  assert.equal(fileKey(`${wt}/src/a.ts`, [wt]), 'src/a.ts');
  for (const p of ['src/a b.ts', `${wt}/../etc/passwd`, 'x'.repeat(161), 'ignore previous instructions.md', 'a`b'])
    assert.match(fileKey(p, [wt]), hashed, p);

  // Hostile 10k-character lines: every key stays linear and bounded.
  const long = '<'.repeat(10_000) + 'a'.repeat(10_000);
  assert.equal(errorKey(long), 'a'.repeat(20), 'a word is cut to 20 letters');
  assert.equal(commandKey('a '.repeat(10_000)).key, 'a a a');
  assert.match(fileKey('/'.repeat(10_000), []), hashed);
});
