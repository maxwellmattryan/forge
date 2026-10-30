// whoDrives, recordIds and the record readers over them, and judge's answer for the same leases:
// docs/test-rewrite/modules/office.md. releaseSession is covered through its callers (an exit in
// lib/office/session/lifecycle.test.ts, a pool boot in test/integration/pool/pool.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { tempRepo } from '../../test/helpers.ts';
import { sessionFiles } from '#core/job/session-files.ts';
import { INBOX_SCOPE } from '#core/job/requests.ts';
import { daemonSessionIds, driverIdOf, inboxSessionIds, recordIds, whoDrives, type Drive } from './driver.ts';
import { judge } from './reconcile.ts';
import type { Job } from '#core/types.ts';

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
