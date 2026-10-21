// The reconciler (lib/reconcile.ts): a running job nothing drives gets one resume, then an
// escalation if it made no progress; its memory is on disk; a clock jump never doubles a resume;
// forge dash's session facts are judged; and forge sync runs it when no dash does.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forgeAsync, tempRepo } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import { initWrite } from '../lib/commands/init.ts';
import { assertEpoch, claimJob, createJob, leaseStatus, loadJob, readEvents, recordAgent, renewLease, setJob, updateJob } from '../lib/jobs.ts';
import { IDLE_UNDRIVEN_MS, RECONCILE_TEXT, daemonLockDir, judge, progressMark, reconcile } from '../lib/reconcile.ts';
import type { SessionFacts } from '../lib/reconcile.ts';
import { ackRequest, listRequests } from '../lib/requests.ts';
import { tryLock, withLock } from '../lib/util.ts';
import type { Config } from '../lib/types.ts';

const HOUR = 3_600_000;

function foremanConfig(): Config {
  const c = defaults();
  c.foreman.enabled = true;
  return c;
}

/** A running job claimed by `session`, its lease already expired unless `live`. */
function runningJob(root: string, title: string, session = 'A', live = false): string {
  const id = createJob(root, defaults(), { title }).id;
  setJob(root, id, { stage: 'build', state: 'running' });
  claimJob(root, id, session);
  if (!live) updateJob(root, id, (j) => (j.lease.expiresAt = new Date(Date.now() - 60_000).toISOString()));
  return id;
}

const resumesFor = (root: string, id: string) => listRequests(root).filter((r) => r.type === 'resume' && r.job === id);
const memory = (root: string) => JSON.parse(fs.readFileSync(path.join(root, '.forge', 'runtime', 'reconcile.json'), 'utf8'));
const ackAll = (root: string, id: string) => {
  for (const r of resumesFor(root, id)) if (r.status !== 'done') ackRequest(root, r.id, { status: 'done' });
};

describe('reconciler', { concurrency: 4 }, () => {
  test('bounded escalation', () => {
    const repo = tempRepo();
    const root = repo.dir;
    const config = foremanConfig();
    try {
      const id = runningJob(root, 'Stalled');
      const one = reconcile(root, config);
      assert.deepEqual(one.resumed, [id]);
      const queued = resumesFor(root, id);
      assert.equal(queued.length, 1, 'exactly one resume');
      assert.deepEqual([queued[0].from, queued[0].text, queued[0].status], ['reconciler', RECONCILE_TEXT, 'pending']);
      assert.deepEqual(Object.keys(memory(root).jobs), [id]);
      assert.equal(memory(root).jobs[id].request, queued[0].id);
      // While the resume is pending the job is driven: no second resume, no escalation.
      assert.deepEqual(reconcile(root, config), { resumed: [], escalated: [], requeued: [] });

      ackAll(root, id);
      const two = reconcile(root, config);
      assert.deepEqual(two.escalated, [id]);
      const j = loadJob(root, id);
      assert.deepEqual([j.state, j.waitingOn, j.reason], ['waiting', 'escalation', 'undriven at build: resumed once with no progress since']);
      assert.ok(listRequests(root).some((r) => r.type === 'gate' && r.job === id && r.status === 'pending'), 'the gate is queued');
      assert.deepEqual(readEvents(root, id).filter((e) => e.type === 'reconcile').map((e) => e.action), ['resume', 'escalate']);
      assert.equal(memory(root).jobs[id], undefined, 'the record goes with the escalation');

      // Progress between the passes earns a second resume instead.
      const moving = runningJob(root, 'Moving');
      reconcile(root, config);
      ackAll(root, moving);
      recordAgent(root, moving, { role: 'builder', phase: 'start' }, config);
      recordAgent(root, moving, { role: 'builder', phase: 'end' }, config);
      const again = reconcile(root, config);
      assert.deepEqual([again.resumed, again.escalated], [[moving], []]);
      assert.equal(resumesFor(root, moving).length, 2);
      assert.equal(loadJob(root, moving).state, 'running');
      // A job that left `running` loses its record.
      setJob(root, moving, { state: 'waiting', waitingOn: 'input' });
      reconcile(root, config);
      assert.equal(memory(root).jobs[moving], undefined);
    } finally {
      repo.cleanup();
    }
  });

  test('a dashboard restart mid-escalation: no reset count', () => {
    const repo = tempRepo();
    const root = repo.dir;
    const config = foremanConfig();
    try {
      const id = runningJob(root, 'Restarted');
      assert.deepEqual(reconcile(root, config).resumed, [id]);
      ackAll(root, id);
      // Nothing in memory survives between calls: a new pass reads only the record on disk.
      assert.equal(memory(root).jobs[id].mark, progressMark(readEvents(root, id)));
      const after = reconcile(root, config, { only: id });
      assert.deepEqual([after.resumed, after.escalated], [[], [id]], 'it escalates rather than resuming again');
      assert.equal(resumesFor(root, id).length, 1);
    } finally {
      repo.cleanup();
    }
  });

  test('a clock jump forward', () => {
    const repo = tempRepo();
    const root = repo.dir;
    const config = foremanConfig();
    const lockDir = path.join(root, 'held.lock');
    const realNow = Date.now;
    try {
      const id = runningJob(root, 'Jumped', 'A', true);
      assert.deepEqual(reconcile(root, config), { resumed: [], escalated: [], requeued: [] }, 'a live lease drives it');
      const later = Date.now() + 3 * HOUR;
      assert.equal(leaseStatus(loadJob(root, id), later).status, 'expired');
      assert.deepEqual(reconcile(root, config, { at: later }).resumed, [id]);
      assert.deepEqual(reconcile(root, config, { at: later + 1000 }).resumed, [], 'the pending resume drives it');
      ackAll(root, id);
      assert.deepEqual(reconcile(root, config, { at: later + 2000 }), { resumed: [], escalated: [id], requeued: [] });
      assert.equal(resumesFor(root, id).length, 1, 'never two resumes for one mark');

      // The old driver wakes: nobody took over, so its own renewal brings the lease back at the same epoch.
      const other = runningJob(root, 'Woken', 'A');
      assert.equal(renewLease(root, other, { session: 'A' }), true);
      assert.deepEqual([leaseStatus(loadJob(root, other)).status, loadJob(root, other).lease.epoch], ['live', 1]);
      // After a takeover, its fenced writes are refused.
      updateJob(root, other, (j) => (j.lease.expiresAt = new Date(Date.now() - 1000).toISOString()));
      claimJob(root, other, 'B');
      assert.throws(() => setJob(root, other, { note: 'stale', fence: { epoch: 1 } }), (e: any) => e.code === 'stale_epoch' && e.exitCode === 3);
      assert.throws(() => assertEpoch(loadJob(root, other), 1, 'A'), (e: any) => e.code === 'stale_epoch');

      // A live holder's lock is never broken, however far the clock jumped.
      const held = tryLock(lockDir);
      assert.ok('release' in held);
      Date.now = () => realNow() + 3 * HOUR;
      assert.throws(() => withLock(lockDir, () => 'entered', { timeoutMs: 300 }), /timed out waiting for lock/);
      Date.now = realNow;
      held.release();
    } finally {
      Date.now = realNow;
      repo.cleanup();
    }
  });

  test('dash session facts', () => {
    const repo = tempRepo();
    const root = repo.dir;
    const config = foremanConfig();
    const at = Date.now();
    const idleSince = new Date(at - IDLE_UNDRIVEN_MS - 1000).toISOString();
    const facts = (over: Partial<SessionFacts>): SessionFacts => ({ ids: ['S'], status: 'idle', background: 0, idleSince, ...over });
    try {
      // The old missed-end case: its own session idle a minute with no background task while job.json still marks agents running.
      const id = runningJob(root, 'Missed end', 'S', true);
      recordAgent(root, id, { role: 'builder', phase: 'start' }, config);
      renewLease(root, id, { session: 'S', ttl: 2 * HOUR });
      const job = loadJob(root, id);
      assert.equal(judge(job, [], facts({}), at).driven, false);
      assert.equal(judge(job, [], facts({ background: 1 }), at).driven, true, 'a background task is running');
      assert.equal(judge(job, [], facts({ background: -1 }), at).driven, true, 'claude has not reported its tasks');
      assert.equal(judge(job, [], facts({ status: 'busy', idleSince: null }), at).driven, true, 'its session is busy');
      assert.equal(judge(job, [], facts({ status: 'stopping', idleSince: null }), at).driven, true);
      assert.equal(judge(job, [], facts({ idleSince: new Date(at - 1000).toISOString() }), at).driven, true, 'idle under a minute');
      assert.equal(judge(job, [], facts({ status: 'off', idleSince: null }), at).driven, false, 'its session is off');
      assert.equal(judge(job, [], facts({ ids: ['someone-else'] }), at).driven, true, 'a live lease held by a session that is not this job daemon session');
      assert.equal(judge(job, [{ status: 'in-progress' }], facts({}), at).driven, true, 'a request drives it');

      const m = new Map([[id, facts({})]]);
      assert.deepEqual(reconcile(root, config, { facts: m, at }).resumed, [id], 'one resume');
      assert.deepEqual(reconcile(root, config, { facts: new Map([[id, facts({ background: 2 })]]), at }).resumed, []);

      const human = runningJob(root, 'Human drives', 'H', true);
      assert.deepEqual(reconcile(root, config, { facts: new Map([[human, facts({})]]), at, only: human }).resumed, [], 'leased live by a non-daemon session: driven');
    } finally {
      repo.cleanup();
    }
  });

  test('sync runs the reconciler without forge dash', async () => {
    const repo = tempRepo();
    const root = repo.dir;
    try {
      initWrite(root, { tracker: { kind: 'local' }, pr: { enabled: false } }, false);
      const id = runningJob(root, 'Synced');
      const r = await forgeAsync(root, ['sync']);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.deepEqual(out.reconcile.resumed, [id]);
      assert.deepEqual(out.reconcile.escalated, []);
      // A live process (this one) holds the daemon lock: the dash reconciles, sync leaves it alone.
      const held = tryLock(daemonLockDir(root));
      assert.ok('release' in held);
      try {
        const skipped = JSON.parse((await forgeAsync(root, ['sync'])).stdout);
        assert.equal(skipped.reconcile, 'skipped (forge dash owns it)');
      } finally {
        held.release();
      }
    } finally {
      repo.cleanup();
    }
  });
});
