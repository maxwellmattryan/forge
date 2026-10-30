// whoDrives, recordIds and the record readers over them, and judge's answer for the same leases:
// docs/test-rewrite/modules/office.md. releaseSession is covered through its callers (an exit in
// lib/office/session/lifecycle.test.ts, a pool boot in test/integration/pool/pool.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fakeClaude, tempRepo, withLease } from '../../test/helpers.ts';
import { defaults, trustDigest } from '#core/config/load.ts';
import { UUID, readInfo, sessionFiles } from '#core/job/session-files.ts';
import { INBOX_SCOPE } from '#core/job/requests.ts';
import { createJob, leaseStatus, loadJob } from '#core/job/store.ts';
import { createCodeDriver } from './code/job-driver.ts';
import { confineDigest } from './session/confine.ts';
import { sessionOptions, type SessionContext } from './session/contract.ts';
import { daemonSessionIds, driverIdOf, inboxSessionIds, recordIds, whoDrives, type Drive } from './driver.ts';
import { judge } from './reconcile.ts';
import type { Config, Job } from '#core/types.ts';

test('whoDrives answers who drives a job', (t) => {
  const [y, s, p, stranger] = Array.from({ length: 4 }, () => crypto.randomUUID());
  const at = Date.parse('2026-10-23T12:00:00.000Z');
  const live = new Date(at + 60_000).toISOString();
  const gone = new Date(at - 60_000).toISOString();
  const job = (driver: string | null, expiresAt: string | null = live): Pick<Job, 'lease'> => ({
    lease: { driver, epoch: driver ? 1 : 0, since: driver ? gone : null, renewedAt: driver ? gone : null, expiresAt: driver ? expiresAt : null } as Job['lease'],
  });
  const ids = [y, s, p];
  const session = (status: string) => ({ ids, status });

  const rows: { name: string; job: Pick<Job, 'lease'>; session: { ids: string[]; status: string } | null; want: Omit<Drive, 'driver'> }[] = [
    { name: 'no driver', job: job(null), session: session('idle'), want: { lease: 'none', own: false, jobSession: false, held: false } },
    { name: 'a live lease with no session', job: job(s), session: null, want: { lease: 'live', own: false, jobSession: false, held: true } },
    { name: 'live under the current id, idle', job: job(y), session: session('idle'), want: { lease: 'live', own: true, jobSession: true, held: false } },
    { name: 'live under the spawn id, idle', job: job(s), session: session('idle'), want: { lease: 'live', own: true, jobSession: true, held: false } },
    { name: 'live under a past id, idle', job: job(p), session: session('idle'), want: { lease: 'live', own: true, jobSession: true, held: false } },
    { name: 'busy', job: job(s), session: session('busy'), want: { lease: 'live', own: true, jobSession: true, held: false } },
    { name: 'stopping', job: job(s), session: session('stopping'), want: { lease: 'live', own: true, jobSession: true, held: false } },
    { name: 'off', job: job(s), session: session('off'), want: { lease: 'live', own: true, jobSession: false, held: true } },
    { name: "a stranger's live lease", job: job(stranger), session: session('idle'), want: { lease: 'live', own: false, jobSession: false, held: true } },
    { name: 'an expired own lease', job: job(s, gone), session: session('idle'), want: { lease: 'expired', own: true, jobSession: true, held: false } },
    { name: "an expired stranger's lease", job: job(stranger, gone), session: session('idle'), want: { lease: 'expired', own: false, jobSession: false, held: false } },
  ];
  for (const row of rows) {
    const { driver } = row.job.lease;
    assert.deepEqual(whoDrives(row.job, row.session, at), { driver, ...row.want }, row.name);
  }

  const idRows: { name: string; info: any; want: string[] }[] = [
    { name: 'current, spawn, then past, deduped', info: { sessionId: y, spawnSessionId: s, pastSessionIds: [p, y, s] }, want: [y, s, p] },
    { name: 'non-uuid values dropped', info: { sessionId: '--resume', spawnSessionId: 42, pastSessionIds: [null, p, '--dangerously-skip-permissions'] }, want: [p] },
    { name: 'no pastSessionIds', info: { sessionId: y }, want: [y] },
    { name: 'a non-array pastSessionIds', info: { sessionId: y, spawnSessionId: s, pastSessionIds: p }, want: [y, s] },
    { name: 'an empty record', info: {}, want: [] },
  ];
  for (const row of idRows) assert.deepEqual(recordIds(row.info), row.want, row.name);

  const repo = tempRepo();
  t.after(repo.cleanup);
  const write = (scope: string, info: unknown) => {
    const f = sessionFiles(repo.dir, scope);
    fs.mkdirSync(f.dir, { recursive: true });
    fs.writeFileSync(f.info, JSON.stringify(info));
  };
  assert.deepEqual([inboxSessionIds(repo.dir), daemonSessionIds(repo.dir)], [[], []], 'no records');
  write(INBOX_SCOPE, idRows[0].info);
  write('job-a', idRows[1].info);
  write('job-b', { sessionId: stranger, spawnSessionId: y });
  assert.deepEqual(inboxSessionIds(repo.dir), [y, s, p]);
  assert.deepEqual(new Set(daemonSessionIds(repo.dir)), new Set([y, s, p, stranger]));
  assert.equal(daemonSessionIds(repo.dir).length, 4, 'deduped across records');

  // A code driver's id: a uuid only, never one of the record's session ids, but one of the ids a pool boot releases.
  const driver = crypto.randomUUID();
  for (const [info, want] of [[{ driverId: driver }, driver], [{ driverId: '--resume' }, null], [{ driverId: 7 }, null], [{}, null], [null, null]] as const) assert.equal(driverIdOf(info), want, JSON.stringify(info));
  write('job-c', { sessionId: p, driverId: driver });
  assert.deepEqual(recordIds({ sessionId: p, driverId: driver }), [p], 'a session release never passes the driver id');
  assert.deepEqual(new Set(daemonSessionIds(repo.dir)), new Set([y, s, p, stranger, driver]));
  write('job-d', { sessionId: stranger, driverId: 'not-a-uuid' });
  assert.equal(daemonSessionIds(repo.dir).length, 5, 'a planted driver id is no id');

  // The reconciler gives the same answer for the session-changed case: S is still the session's own.
  const off = { ids: [y, s], status: 'off', background: -1, idleSince: null };
  const agents = {} as Job['agents'];
  assert.deepEqual(judge({ ...job(s), agents }, [], off, at), { driven: false, why: 'its session is off' });
  assert.deepEqual(judge({ ...job(stranger), agents }, [], off, at), { driven: true, why: 'lease' });
});

test("the code driver's id lives in its scope's record, apart from the session's", async (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  const root = repo.dir;
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(root, '.forge', 'config.yml'), 'daemon:\n  enabled: true\n  command: claude {session}\n');
  const cfg: Config = defaults();
  cfg.daemon = { ...cfg.daemon, enabled: true, command: 'claude {session}', idleStopMinutes: null };
  const job = createJob(root, cfg, { title: 'driven in code' }).id;
  const [digest, confined] = [trustDigest(root), confineDigest(root, cfg)];
  const ctx: SessionContext = {
    trusted: () => digest,
    confined: () => confined,
    poolWanted: () => true,
    config: () => cfg,
    untrusted: () => {},
    fatal: () => {},
    emit: () => {},
    onResult: () => {},
    onExit: () => {},
    poke: () => {},
    permissionMode: () => null,
    permissionModeRefused: () => {},
    effort: () => ({ level: null, source: 'none' }),
    model: () => null,
    browser: () => null,
  };
  const fake = fakeClaude();
  const o = sessionOptions({ claude: fake.adapter, graceMs: 20 });
  const f = sessionFiles(root, job);
  const session = crypto.randomUUID();
  fs.mkdirSync(f.dir, { recursive: true });
  // A planted id that is no uuid is replaced; the session's own fields stay.
  fs.writeFileSync(f.info, JSON.stringify({ sessionId: session, driverId: '--resume' }));
  const first = createCodeDriver(root, job, ctx, o);
  const id = driverIdOf(readInfo(f.info));
  assert.ok(id && UUID.test(id), String(id));
  assert.equal(readInfo(f.info).sessionId, session);
  t.after(() => first.close());
  // A second pool over the same root reads the same id.
  const second = createCodeDriver(root, job, ctx, o);
  await second.close();
  assert.equal(driverIdOf(readInfo(f.info)), id);
  assert.ok(daemonSessionIds(root).includes(id!), 'a pool boot releases it');
  assert.ok(first.facts().ids.includes(id!), "the reconciler counts it as the scope's");

  // The inner session's spawn and exit keep the id, and its release never lets the driver's lease go.
  withLease(root, job, id!);
  assert.equal(first.spawn(cfg), true);
  assert.equal(fake.children.length, 1, 'under daemon.driver: session, the inner session spawns');
  assert.equal(driverIdOf(readInfo(f.info)), id, 'after the spawn');
  await first.kill('stop', true, 'test');
  assert.equal(first.running, false);
  assert.equal(driverIdOf(readInfo(f.info)), id, 'after the exit');
  const lease = loadJob(root, job).lease;
  assert.deepEqual([lease.driver, leaseStatus(loadJob(root, job)).status], [id, 'live']);
});
