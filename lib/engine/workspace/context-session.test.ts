// Context sessions without a claude child: which spawns use one, the inputs a context reads and what changed since,
// the fork's usage baseline and cache-miss rules, and find-or-start under the key's lock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { createJob, jobDir, loadJob, readEvents, updateJob } from '#core/job/store.ts';
import { JOB_SCHEMA_VERSION, normalizeJob } from '#core/job/schema.ts';
import type { ContextSession } from '#core/types.ts';
import type { MeterCum } from '../metrics/meter.ts';
import {
  CONTEXT_INPUT_MAX_BYTES,
  CONTEXT_WARM_MS,
  cacheMiss,
  contextInputs,
  contextKey,
  contextKind,
  forkBase,
  inputsChanged,
  matchingContext,
  resolveContext,
  touchContext,
  withContextLock,
  type ContextLaunch,
} from './context-session.ts';

const UUID = '33333333-3333-4333-8333-333333333333';

/** A job at round 1 in a scratch repo, with its dir. */
function scratch(t: { after: (fn: () => void) => void }) {
  const repo = tempRepo();
  t.after(repo.cleanup);
  const config = defaults();
  const id = createJob(repo.dir, config, { title: 'context' }).id;
  updateJob(repo.dir, id, (j) => {
    j.round = 1;
  });
  return { root: repo.dir, config, id, dir: jobDir(repo.dir, id) };
}

test('context eligibility', (t) => {
  const s = scratch(t);
  const rows: { name: string; sp: { role: string; rule: string; resume?: string }; build?: boolean; want: 'review' | 'rework' | null }[] = [
    { name: 'a review lens', sp: { role: 'reviewer:code', rule: 'RV4' }, want: 'review' },
    { name: 'a partial panel', sp: { role: 'reviewer:security', rule: 'RV10' }, want: 'review' },
    { name: 'an integration review', sp: { role: 'reviewer:code', rule: 'IG8' }, want: null },
    { name: 'a resumed lens', sp: { role: 'reviewer:code', rule: 'RV4', resume: UUID }, want: null },
    // A resume that is not a session id starts fresh: the spawn runs as any other.
    { name: 'a lens whose resume is no uuid', sp: { role: 'reviewer:code', rule: 'RV4', resume: 'agent-1' }, want: 'review' },
    { name: 'a first build', sp: { role: 'builder', rule: 'B1' }, want: null },
    { name: 'a rework build', sp: { role: 'builder', rule: 'B1' }, build: true, want: 'rework' },
    { name: 'a resumed rework build', sp: { role: 'builder', rule: 'N2', resume: UUID }, build: true, want: null },
    { name: 'the planner', sp: { role: 'planner', rule: 'P1' }, build: true, want: null },
  ];
  const build = path.join(s.dir, 'build.md');
  for (const row of rows) {
    fs.rmSync(build, { force: true });
    if (row.build) fs.writeFileSync(build, '## Round 1\n');
    assert.equal(contextKind(s.root, { id: s.id }, row.sp), row.want, row.name);
  }
  // build.md as a link is no build that happened.
  fs.rmSync(build, { force: true });
  fs.symlinkSync(path.join(s.dir, 'request.md'), build);
  assert.equal(contextKind(s.root, { id: s.id }, { role: 'builder', rule: 'B1' }), null, 'a linked build.md');
});

test('context inputs keep only regular files inside the job dir', (t) => {
  const s = scratch(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ctx-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(s.dir, 'spec.md'), '# Spec\n');
  // A link, a FIFO (which must never block the read), and a directory reached through a link.
  fs.writeFileSync(path.join(outside, 'secret.md'), 'elsewhere\n');
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(s.dir, 'design.md'));
  execFileSync('mkfifo', [path.join(s.dir, 'build.md')]);
  fs.mkdirSync(path.join(outside, 'verify'));
  fs.writeFileSync(path.join(outside, 'verify', 'round-1.md'), 'PASS\n');
  fs.symlinkSync(path.join(outside, 'verify'), path.join(s.dir, 'verify'));
  // Over the per-file cap.
  fs.writeFileSync(path.join(s.dir, 'scope.md'), 'x'.repeat(CONTEXT_INPUT_MAX_BYTES + 1));
  // The previous round's diff stands in for this round's.
  fs.mkdirSync(path.join(s.dir, 'review', 'round-0'), { recursive: true });
  fs.writeFileSync(path.join(s.dir, 'review', 'round-0', 'diff.patch'), 'diff --git a b\n');
  const kept = contextInputs(s.root, loadJob(s.root, s.id));
  assert.deepEqual(
    kept.map((i) => path.relative(s.dir, i.path)),
    ['spec.md', path.join('review', 'round-0', 'diff.patch')],
  );
  assert.match(kept[0].sha256, /^[0-9a-f]{64}$/);

  // The total cap: a file that would take it past 384 KiB is left out, a later small one still fits.
  for (const f of ['design.md', 'build.md', 'scope.md', 'verify']) fs.rmSync(path.join(s.dir, f), { force: true });
  fs.writeFileSync(path.join(s.dir, 'design.md'), 'd'.repeat(200 * 1024));
  fs.writeFileSync(path.join(s.dir, 'build.md'), 'b'.repeat(200 * 1024));
  fs.writeFileSync(path.join(s.dir, 'scope.md'), 'scope\n');
  assert.deepEqual(
    contextInputs(s.root, loadJob(s.root, s.id)).map((i) => path.relative(s.dir, i.path)),
    ['spec.md', 'design.md', 'scope.md', path.join('review', 'round-0', 'diff.patch')],
  );
  // This round's report wins over the last round's.
  fs.mkdirSync(path.join(s.dir, 'verify'));
  fs.writeFileSync(path.join(s.dir, 'verify', 'round-0.md'), 'old\n');
  fs.writeFileSync(path.join(s.dir, 'verify', 'round-1.md'), 'new\n');
  assert.ok(contextInputs(s.root, loadJob(s.root, s.id)).some((i) => i.path === path.join(s.dir, 'verify', 'round-1.md')));
  assert.ok(!contextInputs(s.root, loadJob(s.root, s.id)).some((i) => i.path === path.join(s.dir, 'verify', 'round-0.md')));
});

test('changed inputs are the ones whose digest moved', (t) => {
  const s = scratch(t);
  for (const f of ['spec.md', 'build.md', 'scope.md', 'design.md']) fs.writeFileSync(path.join(s.dir, f), `${f}\n`);
  const inputs = contextInputs(s.root, loadJob(s.root, s.id));
  assert.equal(inputs.length, 4);
  assert.deepEqual(inputsChanged(s.dir, inputs), [], 'nothing moved');
  fs.writeFileSync(path.join(s.dir, 'build.md'), '## Round 2\n');
  fs.rmSync(path.join(s.dir, 'scope.md'));
  fs.rmSync(path.join(s.dir, 'design.md'));
  execFileSync('mkfifo', [path.join(s.dir, 'design.md')]);
  // Rewritten with the same bytes: not changed.
  fs.writeFileSync(path.join(s.dir, 'spec.md'), 'spec.md\n');
  // In input order: a FIFO now (never read, never blocking), a new digest, and a file gone.
  assert.deepEqual(inputsChanged(s.dir, inputs), ['design.md', 'build.md', 'scope.md'].map((f) => path.join(s.dir, f)));
  assert.deepEqual(inputsChanged(s.dir, [{ path: '/etc/hosts', sha256: 'x' }]), ['/etc/hosts'], 'a path outside the job dir is never read');
  // A name that merely starts with two dots lies inside the dir: it is not taken for a path out of it.
  fs.writeFileSync(path.join(s.dir, '..spec'), 'spec.md\n');
  assert.deepEqual(inputsChanged(s.dir, [{ path: path.join(s.dir, '..spec'), sha256: inputs[0].sha256 }]), []);
});

test('fork baseline and cache-miss rules', () => {
  const m = (n: number) => ({ usd: n, input: n, output: n, cacheRead: n, cacheWrite: n });
  const ctx: MeterCum = { usd: 1, models: { sonnet: m(10) } };
  const ZERO = { usd: 0, models: {} };
  const rows: { name: string; ctx: MeterCum | null; fork: { usd: number | null; models: Record<string, ReturnType<typeof m>> }; want: MeterCum }[] = [
    { name: 'carried: at or above on every field', ctx, fork: { usd: 1.5, models: { sonnet: m(10) } }, want: ctx },
    { name: 'carried, with another model too', ctx, fork: { usd: 2, models: { sonnet: m(12), haiku: m(1) } }, want: ctx },
    { name: 'usd from the models when the total is unusable', ctx, fork: { usd: null, models: { sonnet: { ...m(10), usd: 1 } } }, want: ctx },
    { name: 'usd below', ctx, fork: { usd: 0.5, models: { sonnet: m(20) } }, want: ZERO },
    { name: 'one token field below', ctx, fork: { usd: 2, models: { sonnet: { ...m(20), cacheRead: 9 } } }, want: ZERO },
    { name: "the context's model missing", ctx, fork: { usd: 2, models: { opus: m(20) } }, want: ZERO },
    { name: 'no context cumulative', ctx: null, fork: { usd: 2, models: { sonnet: m(20) } }, want: ZERO },
  ];
  for (const row of rows) assert.deepEqual(forkBase(row.ctx, row.fork), row.want, row.name);
  const misses: [number | null, number | null, boolean | null][] = [
    [60000, 29002, false],
    [29002, 29002, true],
    [20000, 29002, true],
    [null, 29002, null],
    [60000, null, null],
  ];
  for (const [firstRead, startPrefix, want] of misses) assert.equal(cacheMiss(firstRead, startPrefix), want, `${firstRead} vs ${startPrefix}`);
});

/** A context record for `key`, last read `ageMs` ago. */
function record(key: ReturnType<typeof contextKey>, id: string, ageMs: number, status: 'ready' | 'failed' = 'ready'): ContextSession {
  const at = new Date(Date.now() - ageMs).toISOString();
  return { id, ...key, status, reason: status === 'failed' ? 'exit' : null, inputs: [], startedAt: at, endedAt: at, lastReadAt: at, startPrefix: 29002, usage: null };
}

test('find or start: one context per key, warm records reused, failures not retried', async (t) => {
  const s = scratch(t);
  fs.writeFileSync(path.join(s.dir, 'spec.md'), '# Spec\n');
  const key = contextKey({ round: 1, agent: 'forge:reviewer', model: 'sonnet', effort: 'high' }, '/p.md');
  const other = contextKey({ round: 1, agent: 'forge:reviewer', model: 'opus', effort: 'high' }, '/p.md');
  assert.deepEqual(key, { round: 1, agent: 'forge:reviewer', model: 'sonnet', effort: 'high', prefix: '/p.md' });
  assert.equal(contextKey({ round: 1, agent: 'forge:builder', model: '', effort: null }, null).model, 'inherit');

  let launches = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const launch = async (): Promise<ContextLaunch> => {
    launches++;
    await gate;
    const at = new Date().toISOString();
    return { id: launches === 1 ? UUID : '44444444-4444-4444-8444-444444444444', status: 'ready', reason: null, startPrefix: 29002, usage: { model: 'sonnet', totalTokens: 10, input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, unmeasured: false, startedAt: at, endedAt: at };
  };
  const a = resolveContext(s.root, s.config, s.id, key, { launch });
  const b = resolveContext(s.root, s.config, s.id, key, { launch });
  await new Promise((r) => setTimeout(r, 150));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(launches, 1, 'concurrent runs with one key start one context');
  assert.deepEqual([ra.mode, rb.mode], ['fork', 'fork']);
  const j = loadJob(s.root, s.id);
  assert.deepEqual(j.contexts.map((c) => [c.id, c.status, c.model]), [[UUID, 'ready', 'sonnet']]);
  assert.deepEqual([j.usage.byRole.context?.runs, j.usage.byRole.context?.tokens], [1, 10]);
  const ev = readEvents(s.root, s.id).filter((e) => e.type === 'context-session');
  assert.deepEqual(ev.map((e) => [e.role, e.session, e.status]), [['context', UUID, 'ready']]);

  // touchContext moves lastReadAt only.
  const later = new Date(Date.now() + 1000).toISOString();
  touchContext(s.root, s.id, UUID, later);
  assert.equal(loadJob(s.root, s.id).contexts[0].lastReadAt, later);

  // Staleness and failures, read from the records.
  const now = Date.now();
  assert.equal(matchingContext({ contexts: [record(key, UUID, CONTEXT_WARM_MS + 60_000)] }, key, now), null, 'past 50 minutes');
  assert.equal(matchingContext({ contexts: [record(key, UUID, 10 * 60_000)] }, key, now)?.id, UUID, '10 minutes old');
  assert.equal(matchingContext({ contexts: [record(key, UUID, 0)] }, other, now), null, 'another model is another key');
  assert.equal(matchingContext({ contexts: [record(key, UUID, 0)] }, { ...key, round: 2 }, now), null, 'another round is another key');
  updateJob(s.root, s.id, (x) => {
    x.contexts = [record(key, UUID, 0, 'failed')];
  });
  launches = 0;
  const failed = await resolveContext(s.root, s.config, s.id, key, { launch });
  assert.deepEqual([failed, launches], [{ mode: 'cold', reason: 'context failed: exit', session: UUID }, 0], 'a failed context is not retried this round');
  updateJob(s.root, s.id, (x) => {
    x.contexts = [];
  });
  fs.rmSync(path.join(s.dir, 'spec.md'));
  assert.deepEqual(await resolveContext(s.root, s.config, s.id, key, { launch }), { mode: 'cold', reason: 'no inputs', session: null });
  assert.equal(launches, 0);
});

test('a context session record is kept only well formed, the newest 20', () => {
  const at = '2026-10-01T10:00:00.000Z';
  const rec = { id: UUID, round: 2, agent: 'forge:reviewer', model: 'sonnet', effort: 'high', prefix: '/r/p.md', status: 'ready', reason: null, inputs: [{ path: '/j/spec.md', sha256: 'a'.repeat(64) }], startedAt: at, endedAt: at, lastReadAt: at, startPrefix: 29000, usage: { tokens: 10, input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } };
  const read = (contexts: unknown) => normalizeJob({ schemaVersion: JOB_SCHEMA_VERSION, id: 'x', contexts }).contexts;
  assert.deepEqual(read([rec]), [rec]);
  assert.deepEqual(read(undefined), [], 'none');
  assert.deepEqual(read([{ ...rec, effort: 3, prefix: {}, reason: 7, startPrefix: -1, usage: { tokens: 'lots' }, inputs: [{ path: 1 }, 'x'] }]), [{ ...rec, effort: null, prefix: null, reason: null, startPrefix: null, usage: null, inputs: [] }], 'a mistyped nullable field reads as null');
  const malformed: [string, unknown][] = [
    ['an id that is not a uuid', { ...rec, id: '--resume' }],
    ['an unknown status', { ...rec, status: 'warm' }],
    ['a round that is not an integer', { ...rec, round: '2' }],
    ['an agent that is not text', { ...rec, agent: null }],
    ['no lastReadAt', { ...rec, lastReadAt: undefined }],
    ['not a record', 'ready'],
  ];
  for (const [name, raw] of malformed) assert.deepEqual(read([raw]), [], name);
  assert.deepEqual(read('x'), [], 'not a list');
  const many = Array.from({ length: 25 }, (_, i) => ({ ...rec, round: i }));
  assert.deepEqual(read(many).map((c) => c.round), many.slice(-20).map((c) => c.round), 'the newest 20');
});

test('the key lock: busy after its wait, and an abort stops the wait', async (t) => {
  const s = scratch(t);
  const key = contextKey({ round: 1, agent: 'forge:reviewer', model: 'sonnet', effort: null }, null);
  let release!: () => void;
  const held = withContextLock(s.root, s.id, key, () => new Promise<void>((r) => (release = r)));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await withContextLock(s.root, s.id, key, async () => 1, undefined, 100), { busy: true });
  const abort = new AbortController();
  const waiting = withContextLock(s.root, s.id, key, async () => 1, abort.signal);
  abort.abort();
  await assert.rejects(waiting, /stopped waiting for lock/);
  // Another key holds another lock.
  assert.deepEqual(await withContextLock(s.root, s.id, { ...key, model: 'opus' }, async () => 2, undefined, 100), { value: 2 });
  release();
  await held;
  assert.deepEqual(await withContextLock(s.root, s.id, key, async () => 3), { value: 3 });
});
