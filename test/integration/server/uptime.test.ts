// The machine dashboard's uptime over real servers: the sleep assertion follows the projects that need
// it (a fake helper spawn, so no caffeinate or systemd-inhibit ever starts), and booted() reports the
// boot passes of the projects whose pools booted. Every pool gets fake claude children.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fakeClaude, jobAt, serveProjects, tempRepo, waitFor, withLease } from '../../helpers.ts';
import * as yaml from '#core/format/yaml.ts';
import { CONFIG_SCHEMA_VERSION } from '#core/job/schema.ts';
import { listRequests } from '#core/job/requests.ts';
import { setJob } from '#core/job/store.ts';
import { readUptime } from '#engine/project/login-service.ts';
import { RECONCILE_TEXT } from '#office/reconcile.ts';
import type { SleepChild } from '#integrations/os-service/types.ts';

/** Pool options over fakeClaude, with no poll, sync or reconcile timers: only the boot pass reconciles. */
const daemonOpts = () => ({ claude: fakeClaude().adapter, pollMs: 3_600_000, syncMs: 0, reconcileMs: 0, graceMs: 50 });

function daemonRepo(enabled = true): ReturnType<typeof tempRepo> {
  const r = tempRepo();
  fs.mkdirSync(path.join(r.dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, daemon: { enabled, command: 'claude {session}', maxConcurrent: 2 } }));
  return r;
}

class FakeHelper extends EventEmitter implements SleepChild {
  pid = 4_300_001;
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function fakeSpawn() {
  const spawned: { file: string; args: string[]; child: FakeHelper }[] = [];
  const spawn = (file: string, args: string[]) => {
    const child = new FakeHelper();
    spawned.push({ file, args, child });
    return child;
  };
  return { spawn, spawned, live: () => spawned.filter((s) => !s.child.killed) };
}

test('the machine dashboard holds a sleep assertion only while a project needs it', async () => {
  const a = daemonRepo();
  const id = jobAt(a.dir, 'build').id;
  const f = fakeSpawn();
  // platform: darwin, so the check runs the same on every CI leg.
  const s = await serveProjects([{ dir: a.dir, name: 'a' }], { daemon: daemonOpts(), keepAwake: { spawn: f.spawn, intervalMs: 20, platform: 'darwin' } });
  try {
    await waitFor(() => f.spawned.length === 1, { what: 'the helper spawned' });
    assert.deepEqual([f.spawned[0]!.file, f.spawned[0]!.args], ['caffeinate', ['-i', '-w', String(process.pid)]]);
    const rec = await waitFor(() => readUptime(s.home).keepAwake?.held && readUptime(s.home).keepAwake, { what: 'held recorded' });
    assert.deepEqual([rec.pid, rec.projects], [process.pid, ['a']]);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(f.spawned.length, 1, 'one helper while it stays needed');

    setJob(a.dir, id, { state: 'waiting', waitingOn: 'input' });
    await waitFor(() => f.spawned[0]!.child.killed, { what: 'the helper killed' });
    await waitFor(() => readUptime(s.home).keepAwake?.held === false, { what: 'released recorded' });
    assert.deepEqual(readUptime(s.home).keepAwake?.projects, []);

    setJob(a.dir, id, { state: 'running', waitingOn: null });
    await waitFor(() => f.live().length === 1, { what: 'held again' });
  } finally {
    await s.cleanup();
    a.cleanup();
  }
  assert.equal(f.live().length, 0, 'close() kills a held helper');
  assert.equal(f.spawned.length, 2);

  // Without keepAwake, or with FORGE_KEEP_AWAKE=never, nothing spawns and nothing is recorded.
  for (const keepAwake of [undefined, { spawn: f.spawn, intervalMs: 20, platform: 'darwin' as const, env: { FORGE_KEEP_AWAKE: 'never' } }]) {
    const b = daemonRepo();
    jobAt(b.dir, 'build');
    const t = await serveProjects([{ dir: b.dir, name: 'b' }], { daemon: daemonOpts(), ...(keepAwake ? { keepAwake } : {}) });
    try {
      await t.booted();
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(f.spawned.length, 2, JSON.stringify(keepAwake?.env ?? 'no keepAwake'));
      assert.equal(readUptime(t.home).keepAwake, null);
    } finally {
      await t.cleanup();
      b.cleanup();
    }
  }
});

test('booted lists the projects whose pools booted', async () => {
  const a = daemonRepo();
  const off = daemonRepo(false);
  const id = jobAt(a.dir, 'build').id;
  withLease(a.dir, id, 'a-session-that-died', { ttlMs: -60_000 });
  jobAt(off.dir, 'build');
  const s = await serveProjects([{ dir: a.dir, name: 'a' }, { dir: off.dir, name: 'off' }], { daemon: daemonOpts() });
  try {
    assert.deepEqual(await s.booted(), [{ name: 'a', jobs: 1, office: 0, mandates: 0 }]);
    // No reconcile timer runs here (reconcileMs: 0), so the resume is the boot pass's.
    const resumes = listRequests(a.dir).filter((q) => q.type === 'resume');
    assert.deepEqual(
      resumes.map((q) => [q.job, q.from, q.text]),
      [[id, 'reconciler', RECONCILE_TEXT]],
    );
    assert.deepEqual(listRequests(off.dir), [], 'a pool that did not boot gets no boot pass');
  } finally {
    await s.cleanup();
    a.cleanup();
    off.cleanup();
  }
});
