// `step` is a pure function of its StepInput: no clock, no file reads. Every fixture of
// test/step-rows.ts runs under a mocked clock and under counting fs mocks.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { exists } from '#core/paths.ts';
import { step } from '#engine/pipeline/step.ts';
import type { StepInput } from '#engine/pipeline/types.ts';
import { fixture } from './step-fixture.ts';
import { job, rows } from './step-rows.ts';

const STEP_DIR = path.resolve(import.meta.dirname, '..', 'lib', 'engine', 'pipeline', 'step');
const inputs = (): [string, StepInput][] => rows.map((r) => [r.name, fixture(r.fx)]);

/** A repo-budget park whose tell must name the period of `now`, not of the wall clock. */
const budget = (reason: string) => fixture({ now: '2026-03-15T12:00:00.000Z', job: job({ stage: 'build', state: 'waiting', waitingOn: 'budget', reason }) });

function underClock<T>(now: string, fn: () => T): T {
  mock.timers.enable({ apis: ['Date'], now: new Date(now) });
  try {
    return fn();
  } finally {
    mock.timers.reset();
  }
}

test('same input, two wall-clock times', () => {
  const all = [...inputs(), ['month budget', budget('repo budget: $103.20 of $100.00 this month')], ['day budget', budget('repo budget: $5.00 of $5.00 today')]] as [string, StepInput][];
  const outputs = (now: string) => underClock(now, () => all.map(([name, x]) => [name, JSON.stringify(step(x))]));
  const a = outputs('2030-01-01T00:00:00.000Z');
  const b = outputs('2031-06-15T23:59:59.000Z');
  assert.ok(a.length > 300, `only ${a.length} inputs`);
  for (let i = 0; i < a.length; i++) assert.equal(a[i][1], b[i][1], String(a[i][0]));
  const tell = (name: string) => JSON.parse(String(a.find(([n]) => n === name)![1])).tell;
  assert.match(tell('month budget'), /forge budget ack --period 2026-03, /);
  assert.match(tell('day budget'), /forge budget ack --period 2026-03-15, /);
});

test('only input.ts touches fs or the clock', () => {
  const files = (fs.readdirSync(STEP_DIR, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts') && f !== 'input.ts');
  assert.ok(files.length >= 15, files.join(', '));
  for (const f of files) {
    const src = fs.readFileSync(path.join(STEP_DIR, f), 'utf8');
    for (const bad of [/new Date/, /Date\.now/, /from 'node:fs'/, /from 'fs'/, /\bexists\(/, /import\s*\{[^}]*\bexists\b[^}]*\}\s*from\s*'[./]*paths\.ts'/]) assert.doesNotMatch(src, bad, `lib/step/${f}`);
  }
});

test('step reads no files', () => {
  const all = inputs();
  // Warm-up: a helper may memoise plugin files it loads once per process.
  for (const [, x] of all) step(x);
  // accessSync too: lib/paths.ts exists() reads through it.
  const names = ['existsSync', 'accessSync', 'statSync', 'lstatSync', 'fstatSync', 'readFileSync', 'readdirSync', 'readlinkSync', 'openSync'] as const;
  const mocks = names.map((n) => mock.method(fs, n));
  syncBuiltinESMExports();
  let counts: Record<string, number> = {};
  let probe = 0;
  try {
    for (const [, x] of all) step(x);
    counts = Object.fromEntries(names.map((n, i) => [n, mocks[i].mock.callCount()]));
    // The mocks see a lib module's reads: lib/paths.ts exists() is what step must never reach.
    exists(STEP_DIR);
    probe = mocks.reduce((n, m) => n + m.mock.callCount(), 0);
  } finally {
    for (const m of mocks) m.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(counts, Object.fromEntries(names.map((n) => [n, 0])));
  assert.ok(probe > 0, 'the fs mocks count reads made through lib modules');
});
