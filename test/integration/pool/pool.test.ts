// createPool in-process over fakeClaude children: where a pool start routes a pending request, and what
// it does with what earlier `forge dash` sessions left behind (docs/test-rewrite/modules/office.md).
// Nothing real is spawned or signalled.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fakeClaude, tempRepo, waitFor } from '../../helpers.ts';
import * as yaml from '#core/format/yaml.ts';
import { CONFIG_SCHEMA_VERSION } from '#core/job/schema.ts';
import { loadConfig } from '#core/config/load.ts';
import { createJob, loadJob, readEvents, recordAgent, updateJob } from '#core/job/store.ts';
import { claimRequest, enqueue, listRequests } from '#core/job/requests.ts';
import { sessionFiles } from '#core/job/session-files.ts';
import { createPool } from '#office/pool.ts';

test('a draft request turns the office session, never the inbox', async (t) => {
  for (const foreman of [true, false]) {
    const repo = tempRepo();
    t.after(repo.cleanup);
    const root = repo.dir;
    fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
    fs.writeFileSync(path.join(root, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, daemon: { enabled: true, command: 'claude {session}' }, foreman: { enabled: foreman } }));
    const { config } = loadConfig(root);
    const r = enqueue(root, config, { type: 'draft', args: { mandate: 'g1' }, from: 'forge' });
    const fake = fakeClaude();
    const pool = createPool(root, { claude: fake.adapter, pollMs: 3_600_000, syncMs: 0, reconcileMs: 0, graceMs: 50 });
    t.after(() => pool.close());
    pool.start('boot');
    const of = (scope: string) => fake.children.filter((c) => c.scope === scope);
    if (foreman) {
      await waitFor(() => of('_office')[0]?.turns === 1, { what: 'the office turn' });
      assert.equal(of('_office').length, 1);
    } else {
      pool.poke();
      assert.deepEqual(of('_office'), [], 'no office session while the foreman is off');
      assert.equal(listRequests(root).find((x) => x.id === r.id)?.status, 'pending');
    }
    assert.ok(of('_inbox').every((c) => c.turns === 0), 'the inbox gets no turn for it');
    assert.deepEqual(fake.children.filter((c) => c.scope !== '_office' && c.scope !== '_inbox'), [], 'no job session');
    await pool.close();
  }
});

// B59: boot releases whatever a recorded session's ids drove, under any of its ids.
test("boot releases every recorded session's jobs and leaves interactive ones alone", async (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  const root = repo.dir;
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(root, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, daemon: { enabled: true, command: 'claude {session}' } }));
  const { config } = loadConfig(root);
  const [y, s, p, i] = Array.from({ length: 4 }, () => crypto.randomUUID());
  const a = createJob(root, config, { title: 'driven by an earlier dash' }).id;
  const b = createJob(root, config, { title: 'driven by an interactive session' }).id;
  // An earlier dash's session for job A: spawned as S, now Y, once P. Its child is gone (pid null).
  const f = sessionFiles(root, a);
  fs.mkdirSync(f.dir, { recursive: true });
  fs.writeFileSync(f.info, JSON.stringify({ sessionId: y, spawnSessionId: s, pastSessionIds: [p], pid: null, resumable: false }));
  const lease = (job: string, driver: string) =>
    updateJob(root, job, (j) => {
      const at = new Date().toISOString();
      j.lease = { driver, epoch: 1, since: at, renewedAt: at, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
    });
  lease(a, p);
  lease(b, i);
  const claimed: Record<string, string> = {};
  for (const [job, by] of [
    [a, s],
    [b, i],
  ]) {
    recordAgent(root, job, { role: 'builder', phase: 'start' }, config);
    const r = enqueue(root, config, { type: 'resume', job, from: 'dashboard' });
    claimRequest(root, r.id, by);
    claimed[job] = r.id;
  }

  const pool = createPool(root, { claude: fakeClaude().adapter, pollMs: 3_600_000, syncMs: 0, reconcileMs: 0, graceMs: 50 });
  t.after(() => pool.close());
  pool.start('boot');

  const request = (job: string) => listRequests(root).find((r) => r.id === claimed[job])!;
  const jobA = loadJob(root, a);
  assert.equal(jobA.agents.builder?.status, 'lost');
  assert.equal(jobA.lease.driver, p, 'the driver is kept');
  assert.ok(Date.parse(jobA.lease.expiresAt!) <= Date.now(), "job A's lease is expired");
  assert.deepEqual(
    readEvents(root, a)
      .filter((e) => e.type === 'lease-expired')
      .map((e) => ({ session: e.session, reason: e.reason })),
    [{ session: p, reason: 'dash-start' }],
  );
  assert.deepEqual({ status: request(a).status, requeues: request(a).requeues }, { status: 'pending', requeues: 1 });

  const jobB = loadJob(root, b);
  assert.equal(jobB.lease.driver, i);
  assert.ok(Date.parse(jobB.lease.expiresAt!) > Date.now(), "job B's lease stays live");
  assert.equal(jobB.agents.builder?.status, 'running');
  assert.equal(request(b).status, 'in-progress');
});
