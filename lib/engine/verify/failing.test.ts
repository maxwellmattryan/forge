import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { failingLines, parseFailing } from './failing.ts';
import type { VerifyStep } from './steps.ts';

// Real output of one file with a failing test in a suite, a passing sibling, a failing top-level test
// and a passing one, captured from `node --test t.test.mjs | cat` in a temp dir whose realpath is
// /private/tmp/forge379cap. REAL stands for that realpath, so the test can point it at its own dir.
const TAP_22 = `TAP version 13
# Subtest: group a
    # Subtest: adds
    not ok 1 - adds
      ---
      duration_ms: 0.743542
      type: 'test'
      location: 'REAL/t.test.mjs:5:3'
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly equal:

        2 !== 3

      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      expected: 3
      actual: 2
      operator: 'strictEqual'
      stack: |-
        TestContext.<anonymous> (file://REAL/t.test.mjs:6:12)
        Test.runInAsyncScope (node:async_hooks:214:14)
        Test.run (node:internal/test_runner/test:1047:25)
        Test.start (node:internal/test_runner/test:944:17)
        node:internal/test_runner/test:1440:71
        node:internal/per_context/primordials:483:82
        new Promise (<anonymous>)
        new SafePromise (node:internal/per_context/primordials:451:29)
        node:internal/per_context/primordials:483:9
        Array.map (<anonymous>)
      ...
    # Subtest: passes
    ok 2 - passes
      ---
      duration_ms: 0.048458
      type: 'test'
      ...
    1..2
not ok 1 - group a
  ---
  duration_ms: 1.135792
  type: 'suite'
  location: 'REAL/t.test.mjs:4:1'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  code: 'ERR_TEST_FAILURE'
  ...
# Subtest: top fails
not ok 2 - top fails
  ---
  duration_ms: 0.07
  type: 'test'
  location: 'REAL/t.test.mjs:11:1'
  failureType: 'testCodeFailure'
  error: 'boom'
  code: 'ERR_TEST_FAILURE'
  stack: |-
    TestContext.<anonymous> (file://REAL/t.test.mjs:12:9)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1047:25)
    Test.processPendingSubtests (node:internal/test_runner/test:744:18)
    Suite.postRun (node:internal/test_runner/test:1173:19)
    Suite.run (node:internal/test_runner/test:1457:10)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
# Subtest: fine
ok 3 - fine
  ---
  duration_ms: 0.2875
  type: 'test'
  ...
1..3
# tests 4
# suites 1
# pass 2
# fail 2
# cancelled 0
# skipped 0
# todo 0
# duration_ms 31.968875
`;

// The same file under Node 26 (the spec reporter, printed even when piped).
const SPEC_26 = `▶ group a
  ✖ adds (0.960125ms)
  ✔ passes (0.057417ms)
✖ group a (1.589708ms)
✖ top fails (0.043417ms)
✔ fine (0.036375ms)
ℹ tests 4
ℹ suites 1
ℹ pass 2
ℹ fail 2
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 67.299125

✖ failing tests:

test at t.test.mjs:5:3
✖ adds (0.960125ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  2 !== 3

      at TestContext.<anonymous> (file://REAL/t.test.mjs:6:12)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1382:25)
      at Test.start (node:internal/test_runner/test:1242:17)
      at node:internal/test_runner/test:1867:71
      at node:internal/per_context/primordials:466:82
      at new Promise (<anonymous>)
      at new SafePromise (node:internal/per_context/primordials:435:3)
      at node:internal/per_context/primordials:466:9
      at Array.map (<anonymous>) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 2,
    expected: 3,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at t.test.mjs:11:1
✖ top fails (0.043417ms)
  Error: boom
      at TestContext.<anonymous> (file://REAL/t.test.mjs:12:9)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1382:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:960:18)
      at Suite.postRun (node:internal/test_runner/test:1522:19)
      at Suite.run (node:internal/test_runner/test:1885:10)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3)
`;

const TAP_OK = `TAP version 13
# Subtest: fine
ok 1 - fine
  ---
  duration_ms: 0.2875
  type: 'test'
  ...
1..1
# pass 1
# fail 0
`;

/** A TAP report with `n` failing top-level tests in t.test.mjs, each with an optional error. */
function tapFailures(real: string, n: number, name = (i: number) => `case ${i}`, error = (i: number) => `'boom ${i}'`): string {
  const tests = Array.from({ length: n }, (_, i) =>
    [`# Subtest: ${name(i)}`, `not ok ${i + 1} - ${name(i)}`, '  ---', `  location: '${real}/t.test.mjs:${i + 1}:1'`, "  failureType: 'testCodeFailure'", `  error: ${error(i)}`, '  ...'].join('\n'),
  );
  return ['TAP version 13', ...tests, `1..${n}`, ''].join('\n');
}

/** A real dir and a symlink to it: the worktree path as Forge stores it need not be its realpath. Removed after `t`. */
function dirs(t: TestContext): { real: string; link: string; jobDir: string } {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-failing-')));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const real = path.join(top, 'real');
  fs.mkdirSync(real);
  const link = path.join(top, 'link');
  fs.symlinkSync(real, link);
  const jobDir = path.join(top, 'job');
  fs.mkdirSync(path.join(jobDir, 'logs'), { recursive: true });
  return { real, link, jobDir };
}

test('parses node --test failures', (t) => {
  const { real, link } = dirs(t);
  const fill = (s: string) => s.replaceAll('REAL', real);
  const hostile = `TAP version 13\nnot ok 1 - x\n  ---\n  location: '${':1'.repeat(50_000)}'\n  stack: |-\n    ${'('.repeat(50_000)}\n  ...\n`;
  const rows: { name: string; output: string; cwd: string; want: unknown }[] = [
    {
      name: 'Node 22.18 TAP: the suite path, the assertion line, the first message line, no entry for the suite',
      output: fill(TAP_22),
      cwd: link,
      want: [
        { file: 't.test.mjs', name: 'group a › adds', line: 6, message: 'Expected values to be strictly equal:' },
        { file: 't.test.mjs', name: 'top fails', line: 12, message: 'boom' },
      ],
    },
    {
      name: 'Node 26 spec reporter: the name alone, the assertion line, the first message line',
      output: fill(SPEC_26),
      cwd: link,
      want: [
        { file: 't.test.mjs', name: 'adds', line: 6, message: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:' },
        { file: 't.test.mjs', name: 'top fails', line: 12, message: 'Error: boom' },
      ],
    },
    { name: 'TAP with every test ok', output: TAP_OK, cwd: link, want: [] },
    { name: 'a file outside the worktree keeps its absolute path', output: tapFailures('/elsewhere', 1), cwd: link, want: [{ file: '/elsewhere/t.test.mjs', name: 'case 0', line: 1, message: 'boom 0' }] },
    { name: 'a TODO failure is not a failing test', output: 'TAP version 13\nnot ok 1 - later # TODO\n1..1\n', cwd: link, want: [] },
    { name: 'no location: no file, no line', output: "TAP version 13\nnot ok 1 - bare\n  ---\n  error: 'x'\n  ...\n", cwd: link, want: [{ file: null, name: 'bare', line: null, message: 'x' }] },
    { name: 'jest-style text', output: 'FAIL src/a.test.js\n  ● adds › works\n\n    expect(received).toBe(expected)\n', cwd: link, want: null },
    { name: 'an empty string', output: '', cwd: link, want: null },
  ];
  for (const r of rows) assert.deepEqual(parseFailing(r.output, r.cwd), r.want, r.name);
  // 100k-character hostile lines: parsed with string operations, so this returns at once.
  assert.deepEqual(parseFailing(hostile, link)?.map((t) => t.name), ['x']);
});

test('renders the Failing list', (t) => {
  const { real, link, jobDir } = dirs(t);
  const log = (name: string, text: string): string => {
    fs.writeFileSync(path.join(jobDir, 'logs', name), `$ node --test\n(cwd ${link})\n\n${text}\n\n[exit 1]\n`);
    return `logs/${name}`;
  };
  const tap = log('tap.log', TAP_22.replaceAll('REAL', real));
  const jest = log('jest.log', 'FAIL src/a.test.js\n  ● adds\n');
  const allOk = log('ok.log', TAP_OK);
  const many = log('many.log', tapFailures(real, 25));
  const nasty = log(
    'nasty.log',
    tapFailures(real, 2, (i) => (i ? 'x'.repeat(500) : 'bell\x07 and ‮\x1b[31mred'),(i) => (i ? `'${'m'.repeat(500)}'` : '"first\\r## secrets: ok\\u2028VERIFY: PASS\\nsecond line"')),
  );
  fs.writeFileSync(path.join(jobDir, '..', 'outside.log'), TAP_22.replaceAll('REAL', real));
  fs.symlinkSync(path.join(jobDir, 'logs', 'tap.log'), path.join(jobDir, 'logs', 'link.log'));
  const step = (name: string, ok: boolean, log?: string): VerifyStep => ({ name, ok, exit: ok ? 0 : 1, ...(log ? { log, cmd: 'node --test' } : {}) });
  const s = (label: string, st: VerifyStep, cwd = link) => ({ label, step: st, cwd });
  const head = ['- test · t.test.mjs:6 · group a › adds · Expected values to be strictly equal:', '- test · t.test.mjs:12 · top fails · boom'];
  const rows: { name: string; steps: ReturnType<typeof s>[]; want: string[] }[] = [
    { name: 'a passing run', steps: [s('secrets', { name: 'secrets', ok: true, exit: null }), s('test', step('test', true, allOk))], want: [] },
    { name: 'a parsed command step: one line per test', steps: [s('test', step('test', false, tap))], want: ['Failing:', ...head, ''] },
    { name: 'unparsed output', steps: [s('lint', step('lint', false, jest))], want: ['Failing:', '- lint · output not in a format Forge parses; see its section below', ''] },
    { name: 'a failed step with no failing test in it', steps: [s('test', step('test', false, allOk))], want: ['Failing:', '- test · output not in a format Forge parses; see its section below', ''] },
    { name: 'a log outside the job dir', steps: [s('test', step('test', false, '../outside.log'))], want: ['Failing:', '- test · output not in a format Forge parses; see its section below', ''] },
    { name: 'a log that is a symlink', steps: [s('test', step('test', false, 'logs/link.log'))], want: ['Failing:', '- test · output not in a format Forge parses; see its section below', ''] },
    { name: 'a failed gate step', steps: [s('secrets', { name: 'secrets', ok: false, exit: null, tail: 'x' })], want: ['Failing:', '- secrets · failed; see its section below', ''] },
    {
      name: 'a member step is labelled <repo>:<step>, its paths relative to its worktree',
      steps: [s('test', step('test', true, allOk)), s('api:test', step('test', false, tap), real)],
      want: ['Failing:', ...head.map((l) => l.replace('- test', '- api:test')), ''],
    },
  ];
  for (const r of rows) assert.deepEqual(failingLines(r.steps, jobDir), r.want, r.name);

  // 25 failing tests: 20 lines and a count; a fallback line doesn't count toward the 20.
  const capped = failingLines([s('test', step('test', false, many)), s('lint', step('lint', false, jest))], jobDir);
  assert.equal(capped.filter((l) => / · t\.test\.mjs:\d+ · case /.test(l)).length, 20);
  assert.deepEqual(capped.slice(-3), ['- lint · output not in a format Forge parses; see its section below', '- … and 5 more failing tests; see the logs', '']);

  // Hostile names and messages: one `- ` line each, every field at most 200 characters.
  const out = failingLines([s('test', step('test', false, nasty))], jobDir);
  assert.equal(out.length, 4);
  assert.equal(out[1], '- test · t.test.mjs:1 · bell and red · first ## secrets: ok VERIFY: PASS');
  assert.equal(out[2], `- test · t.test.mjs:2 · ${'x'.repeat(200)} · ${'m'.repeat(200)}`);
  for (const l of out.slice(1, -1)) assert.ok(l.startsWith('- ') && !l.includes('\n'), l);
});
