// What the machine dashboard does to stay up, in-process over scratch repos: which projects hold the
// machine awake, the boot pass that resumes an undriven job once, and the restart record with one
// notification per project with work in flight.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jobAt, parkedAt, repoTemplate, withLease } from '../../test/helpers.ts';
import * as yaml from '#core/format/yaml.ts';
import { CONFIG_SCHEMA_VERSION } from '#core/job/schema.ts';
import { enqueue, listRequests } from '#core/job/requests.ts';
import { addProject } from '#engine/project/machine-index.ts';
import { readUptime } from '#engine/project/login-service.ts';
import { RECONCILE_TEXT } from '#office/reconcile.ts';
import { blankMandate } from '#office/mandates/contract.ts';
import { writeMandate } from '#office/mandates/store.ts';
import type { Mandate } from '#office/mandates/types.ts';
import type { QueueNotify } from '#office/notify.ts';
import type { Stage, JobState } from '#core/types.ts';
import { holdsAwake, recordRestart, resumeProject } from './uptime.ts';

const repo = repoTemplate(() => {});

function config(root: string, daemon: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(root, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, daemon }));
}

function mandate(root: string, id: string, change: Partial<Mandate> = {}): void {
  writeMandate(root, () => ({ mandate: { ...blankMandate(id, '2026-10-01T00:00:00.000Z'), title: id, scope: { milestones: ['M1'], labels: [], issues: [] }, ...change }, action: 'new' }));
}

/** A pool that knows no sessions: the boot pass judges by job.json, leases and requests alone. */
const idlePool = () => {
  let pokes = 0;
  return { pool: { facts: () => null, state: () => ({ jobs: {} }) as any, poke: () => void pokes++ }, pokes: () => pokes };
};

test('which projects hold the machine awake', () => {
  const job = (stage: Stage, state: JobState) => (root: string) => void jobAt(root, stage, { state, ...(state === 'waiting' ? { waitingOn: 'input' as const } : {}) });
  const rows: { name: string; wanted?: boolean; setup: (root: string) => void; want: boolean }[] = [
    { name: 'a running job at build', setup: job('build', 'running'), want: true },
    { name: 'a pool that is not wanted', wanted: false, setup: job('build', 'running'), want: false },
    { name: 'keepAwake: never', setup: (r) => (config(r, { keepAwake: 'never' }), job('build', 'running')(r)), want: false },
    { name: 'an active mandate', setup: (r) => mandate(r, 'goal'), want: true },
    { name: 'a paused mandate', setup: (r) => mandate(r, 'goal', { status: 'paused' }), want: false },
    { name: 'a closed mandate', setup: (r) => mandate(r, 'goal', { status: 'closed', closedAt: '2026-10-02T00:00:00.000Z' }), want: false },
    { name: 'a mandate waiting on its after', setup: (r) => mandate(r, 'second', { after: 'first' }), want: false },
    ...(['pr', 'backlog', 'done'] as const).map((stage) => ({ name: `a running job at ${stage}`, setup: job(stage, 'running'), want: false })),
    ...(['waiting', 'queued', 'blocked'] as const).map((state) => ({ name: `a ${state} job at build`, setup: job('build', state), want: false })),
    { name: 'an unreadable config', setup: (r) => (job('build', 'running')(r), fs.writeFileSync(path.join(r, '.forge', 'config.yml'), 'daemon: [unclosed\n')), want: false },
    { name: 'nothing at all', setup: () => {}, want: false },
  ];
  for (const row of rows) {
    const r = repo();
    try {
      row.setup(r.dir);
      assert.equal(holdsAwake(r.dir, row.wanted ?? true), row.want, row.name);
    } finally {
      r.cleanup();
    }
  }
});

test('the boot pass resumes an undriven job once', async () => {
  const r = repo();
  try {
    const id = jobAt(r.dir, 'build').id;
    withLease(r.dir, id, 'gone-session', { ttlMs: -60_000 });
    const gated = parkedAt(r.dir, 'spec-approval').id;
    enqueue(r.dir, null, { type: 'gate', job: gated });
    mandate(r.dir, 'goal');
    const { pool, pokes } = idlePool();
    const first = await resumeProject('alpha', r.dir, pool);
    assert.deepEqual(first, { name: 'alpha', jobs: 1, office: 1, mandates: 1 });
    const resumes = () => listRequests(r.dir).filter((q) => q.type === 'resume');
    assert.equal(resumes().length, 1);
    assert.deepEqual([resumes()[0]!.job, resumes()[0]!.from, resumes()[0]!.text], [id, 'reconciler', RECONCILE_TEXT]);
    assert.equal(pokes(), 1, 'the pool is poked so the resume reaches a session at once');
    assert.deepEqual(await resumeProject('alpha', r.dir, pool), first);
    assert.equal(resumes().length, 1, 'a second pass queues no second resume');
    assert.equal(pokes(), 1);
  } finally {
    r.cleanup();
  }
});

test('a boot pass that fails leaves the project out', async () => {
  const r = repo();
  try {
    fs.mkdirSync(path.join(r.dir, '.forge'), { recursive: true });
    fs.writeFileSync(path.join(r.dir, '.forge', 'config.yml'), 'daemon: [unclosed\n');
    assert.equal(await resumeProject('broken', r.dir, idlePool().pool), null);
  } finally {
    r.cleanup();
  }
});

test('a restart record and one notification per project with work', (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-uptime-home-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repos = ['alpha', 'beta', 'gamma'].map(() => repo());
  t.after(() => repos.forEach((x) => x.cleanup()));
  const [alpha, beta, gamma] = repos.map((x, i) => addProject(home, fs.realpathSync(x.dir), { name: ['alpha', 'beta', 'gamma'][i] }).project);
  const calls: [string, readonly string[], unknown][] = [];
  const queue: QueueNotify = (root, events, opts) => (calls.push([root, events, opts]), true);
  const boots = [
    { name: 'alpha', jobs: 2, office: 0, mandates: 1 },
    { name: 'beta', jobs: 0, office: 0, mandates: 1 },
    { name: 'gamma', jobs: 0, office: 3, mandates: 0 },
  ];
  recordRestart(home, boots, queue);
  const rec = readUptime(home).restart!;
  assert.equal(rec.pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(rec.at)));
  assert.deepEqual(rec.projects, boots);
  assert.deepEqual(calls, [
    [alpha!.path, ['service-restarted'], { job: null, reason: 'service-restarted' }],
    [gamma!.path, ['service-restarted'], { job: null, reason: 'service-restarted' }],
  ]);
  assert.ok(!calls.some(([root]) => root === beta!.path), 'nothing in flight: no notification');
});
