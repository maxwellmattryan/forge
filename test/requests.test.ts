import test, { describe } from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forgeAsync, tempRepo } from './helpers.ts';
import { TRUST_ENV, defaults, trustDigest } from '#core/config/load.ts';
import { claimJob, createJob, loadJob, readEvents, requeueOrphanedRequests, updateJob } from '#core/job/store.ts';
import { daemonLockDir } from '#office/reconcile.ts';
import { REQUEUE_REJECTED, ackRequest, claimRequest, enqueue, listRequests, requeueOrphans } from '#core/job/requests.ts';
import { ForgeError } from '#core/errors.ts';
import { tryLock } from '#core/os/lock.ts';
import { parseArgs } from '../lib/cli/commands/args.ts';
import { requestsCmd } from '../lib/cli/commands/requests.ts';

/** Runs the CLI against a scratch repo; `env` adds to (or, with undefined, removes from) the environment. */
function cliIn(dir) {
  return async (env, ...args) => {
    const r = await forgeAsync(dir, args, env);
    return r.status === 0 ? { ok: true, code: 0, out: r.stdout.trim(), json: () => JSON.parse(r.stdout) } : { ok: false, code: r.status, out: `${r.stdout}${r.stderr}`, json: () => null };
  };
}

/**
 * cliIn's twin without a process: `forge requests …` through requestsCmd with the env passed in,
 * so per-case checks never touch process.env and stay safe in the concurrent block. A refusal
 * gives the thrown ForgeError's exit code and message.
 */
function requestsIn(dir) {
  return async (env, ...args) => {
    const { pos, flags } = parseArgs(args);
    const merged: NodeJS.ProcessEnv = { ...process.env, ...env };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete merged[k];
    try {
      const data = JSON.parse(JSON.stringify(requestsCmd(dir, defaults(), pos[1], pos.slice(2), flags, merged)));
      return { ok: true, code: 0, out: JSON.stringify(data), json: () => data };
    } catch (e) {
      if (!(e instanceof ForgeError)) throw e;
      return { ok: false, code: e.exitCode, out: e.message, json: () => null };
    }
  };
}

// Each test has its own scratch repo, so they run side by side.
describe('the request inbox', { concurrency: 4 }, () => {
  test('one session claims a request; a second is refused until the first is done or stale', async () => {
    const repo = tempRepo();
    try {
      const root = repo.dir;
      const { id } = enqueue(root, defaults(), { type: 'sync', from: 'dashboard' });
      assert.equal(listRequests(root, { status: 'pending' }).length, 1);
      const claimed = claimRequest(root, id, 'session-1');
      assert.equal(claimed.status, 'in-progress');
      assert.equal(claimed.session, 'session-1');
      assert.equal(listRequests(root, { status: 'pending' }).length, 0, 'a claimed request leaves the pending list');
      assert.throws(() => claimRequest(root, id, 'session-2'), (e: any) => e.exitCode === 3 && /being handled by session session-1/.test(e.message));
      assert.equal(claimRequest(root, id, 'session-1').session, 'session-1', 'the holder can re-claim');
      assert.equal(claimRequest(root, id, 'session-2', true).session, 'session-2', '--force takes over');
      ackRequest(root, id, { status: 'done', result: 'synced' });
      assert.throws(() => claimRequest(root, id, 'session-1'), /already done/);
    } finally {
      repo.cleanup();
    }
  });

  test('AC4: enqueue only writes the inbox file', async () => {
    const repo = tempRepo();
    try {
      // A config that still carries a launcher must not start anything.
      const config = { ...defaults(), dashboard: { port: 7400, launcher: 'touch launched-marker' } };
      const rec = enqueue(repo.dir, config, { type: 'next', from: 'dashboard' });
      assert.equal('launched' in rec, false);
      assert.equal(rec.status, 'pending');
      const dir = path.join(repo.dir, '.forge', 'runtime');
      assert.deepEqual(fs.readdirSync(dir), ['requests']);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'requests')), [`${rec.id}.json`]);
      assert.equal(fs.existsSync(path.join(repo.dir, 'launched-marker')), false);
    } finally {
      repo.cleanup();
    }
  });

  test('a daemon session sees and claims only its scope', async () => {
    const repo = tempRepo();
    const root = repo.dir;
    const cli = requestsIn(root);
    try {
      const a = createJob(root, defaults(), { title: 'Job A' }).id;
      const b = createJob(root, defaults(), { title: 'Job B' }).id;
      const ra = enqueue(root, null, { type: 'resume', job: a, from: 'dashboard' });
      const ra2 = enqueue(root, null, { type: 'answer', job: a, text: 'yes', from: 'dashboard' });
      const rb = enqueue(root, null, { type: 'rework', job: b, text: 'again', from: 'dashboard' });
      const next = enqueue(root, null, { type: 'next', from: 'dashboard' });
      const unknown = enqueue(root, null, { type: 'resume', job: 'no-such-job', from: 'dashboard' });
      const trust = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(root) };
      const ids = (r) => r.json().map((x) => x.id).sort();

      assert.deepEqual(ids(await cli({ ...trust, FORGE_DAEMON_SCOPE: a }, 'requests')), [ra.id, ra2.id].sort(), "scope A lists only A's job requests");
      assert.deepEqual(ids(await cli({ ...trust, FORGE_DAEMON_SCOPE: a }, 'requests', 'list', '--all')), [ra.id, ra2.id].sort());
      assert.deepEqual(ids(await cli({ ...trust, FORGE_DAEMON_SCOPE: b }, 'requests', 'list')), [rb.id]);
      assert.deepEqual(ids(await cli({ ...trust, FORGE_DAEMON_SCOPE: '_inbox' }, 'requests')), [next.id, unknown.id].sort(), 'the inbox lists job-less and unknown-job requests');

      const wrong = await cli({ ...trust, FORGE_DAEMON_SCOPE: a }, 'requests', 'claim', rb.id, '--session', 's-a');
      assert.equal(wrong.code, 1);
      assert.match(wrong.out, new RegExp(`request ${rb.id} belongs to scope ${b}, not this session's scope ${a}`));
      assert.equal(listRequests(root).find((r) => r.id === rb.id).status, 'pending', 'nothing was claimed');
      const fromInbox = await cli({ ...trust, FORGE_DAEMON_SCOPE: '_inbox' }, 'requests', 'claim', ra.id, '--session', 's-i');
      assert.match(fromInbox.out, /belongs to scope/);
      const mine = await cli({ ...trust, FORGE_DAEMON_SCOPE: a }, 'requests', 'claim', ra.id, '--session', 's-a');
      assert.equal(mine.ok, true, mine.out);
      assert.equal(mine.json().status, 'in-progress');
      assert.equal((await cli({ ...trust, FORGE_DAEMON_SCOPE: '_inbox' }, 'requests', 'claim', next.id, '--session', 's-i')).ok, true);

      // An id the session can't see (unknown, or a path) is refused before anything is built from it.
      const outside = path.join(root, '..', `outside-${path.basename(root)}.json`);
      fs.writeFileSync(outside, JSON.stringify({ id: 'x', type: 'next', status: 'pending', createdAt: new Date().toISOString() }));
      try {
        for (const id of ['999-nope', `../../outside-${path.basename(root)}`, '../x', 'a/b', '..']) {
          for (const sub of ['claim', 'ack']) {
            const r = await cli({ ...trust, FORGE_DAEMON_SCOPE: '_inbox' }, 'requests', sub, id, '--session', 's-i');
            assert.equal(r.code, 1, `${sub} ${id}`);
            assert.match(r.out, /no request .* in this daemon session's scope _inbox/, `${sub} ${id}`);
          }
        }
        assert.equal(JSON.parse(fs.readFileSync(outside, 'utf8')).status, 'pending', 'the file outside the inbox is untouched');
        // A request routed elsewhere can't be acked either.
        const ackOther = await cli({ ...trust, FORGE_DAEMON_SCOPE: a }, 'requests', 'ack', rb.id, '--status', 'done');
        assert.match(ackOther.out, /belongs to scope/);
        // Outside a daemon session the id is still checked before a path is built.
        for (const id of ['../x', `../../outside-${path.basename(root)}`]) assert.match((await cli({ FORGE_DAEMON: undefined }, 'requests', 'claim', id, '--session', 'h')).out, /invalid request id/);
        assert.throws(() => claimRequest(root, '../x', 's'), /invalid request id/);
        assert.throws(() => ackRequest(root, '1-a/../../x', { status: 'done' }), /invalid request id/);
      } finally {
        fs.rmSync(outside, { force: true });
      }

      for (const scope of [undefined, '', '../x', '--all', 'a'.repeat(201), 'job a']) {
        for (const args of [['requests'], ['requests', 'list', '--all'], ['requests', 'claim', rb.id, '--session', 's'], ['requests', 'scope']]) {
          const r = await cli({ ...trust, FORGE_DAEMON_SCOPE: scope }, ...args);
          assert.equal(r.ok, false, `${JSON.stringify(scope)} ${args.join(' ')}`);
          assert.match(r.out, /forge refuses: FORGE_DAEMON_SCOPE is missing or invalid in this daemon session/);
        }
      }
      // Outside a daemon session a human sees and may claim everything.
      assert.deepEqual(ids(await cli({ FORGE_DAEMON: undefined, FORGE_DAEMON_SCOPE: a }, 'requests')), [ra2.id, rb.id, unknown.id].sort());
      assert.equal((await cli({ FORGE_DAEMON: undefined }, 'requests', 'claim', rb.id, '--session', 'human')).ok, true);
    } finally {
      repo.cleanup();
    }
  });

  test('office scope sees only gate requests', async () => {
    const repo = tempRepo();
    const root = repo.dir;
    const cli = requestsIn(root);
    // The spawned CLI's routing, exit code and JSON for requests scope, claim and ack.
    const sh = cliIn(root);
    try {
      const a = createJob(root, defaults(), { title: 'Job A' }).id;
      const gate = enqueue(root, null, { type: 'gate', job: a, args: { gate: 'spec-approval', reserved: null }, from: 'forge' });
      const resume = enqueue(root, null, { type: 'resume', job: a, from: 'dashboard' });
      const next = enqueue(root, null, { type: 'next', from: 'dashboard' });
      assert.throws(() => enqueue(root, null, { type: 'gate', job: '../x', from: 'forge' }), /gate request needs a valid job/);
      assert.throws(() => enqueue(root, null, { type: 'gate', from: 'forge' }), /gate request needs a valid job/);
      const office = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(root), FORGE_DAEMON_SCOPE: '_office' };
      const scope = await sh(office, 'requests', 'scope');
      assert.equal(scope.code, 0, scope.out);
      assert.deepEqual(scope.json(), { daemon: true, scope: 'office', job: null });
      assert.deepEqual((await cli(office, 'requests')).json().map((r) => r.id), [gate.id], 'only gate requests');
      assert.deepEqual((await cli({ ...office, FORGE_DAEMON_SCOPE: a }, 'requests')).json().map((r) => r.id), [resume.id], "the job's session never sees its gate");
      assert.deepEqual((await cli({ ...office, FORGE_DAEMON_SCOPE: '_inbox' }, 'requests')).json().map((r) => r.id), [next.id]);
      for (const id of [resume.id, next.id]) {
        for (const sub of ['claim', 'ack']) {
          const r = await cli(office, 'requests', sub, id, '--session', 'office');
          assert.equal(r.code, 1, `${sub} ${id}`);
          assert.match(r.out, /belongs to scope/);
        }
      }
      const claimed = await sh(office, 'requests', 'claim', gate.id, '--session', 'office');
      assert.equal(claimed.code, 0, claimed.out);
      assert.deepEqual([claimed.json().id, claimed.json().status, claimed.json().session], [gate.id, 'in-progress', 'office']);
      const acked = await sh(office, 'requests', 'ack', gate.id, '--status', 'done', '--result', 'approve: fine');
      assert.equal(acked.code, 0, acked.out);
      assert.deepEqual([acked.json().id, acked.json().status, acked.json().result], [gate.id, 'done', 'approve: fine']);
      assert.equal(listRequests(root).find((r) => r.id === resume.id).status, 'pending');
    } finally {
      repo.cleanup();
    }
  });

  test('requests scope, --intake and daemon provenance', async () => {
    const repo = tempRepo();
    const root = repo.dir;
    const cli = requestsIn(root);
    try {
      const x = createJob(root, defaults(), { title: 'Job X' }).id;
      const trust = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(root) };
      assert.deepEqual((await cli({ FORGE_DAEMON: undefined }, 'requests', 'scope')).json(), { daemon: false, scope: null, job: null });
      assert.deepEqual((await cli({ ...trust, FORGE_DAEMON_SCOPE: '_inbox' }, 'requests', 'scope')).json(), { daemon: true, scope: 'inbox', job: null });
      assert.deepEqual((await cli({ ...trust, FORGE_DAEMON_SCOPE: x }, 'requests', 'scope')).json(), { daemon: true, scope: 'job', job: x });

      // The spawned CLI's routing, exit code and JSON for requests add.
      const added = await cliIn(root)({ FORGE_DAEMON: undefined }, 'requests', 'add', 'resume', '--job', x, '--intake', 'run');
      assert.equal(added.code, 0, added.out);
      const human = added.json();
      assert.deepEqual([human.type, human.job, human.status], ['resume', x, 'pending']);
      assert.deepEqual(human.args, { intake: 'run' });
      assert.equal(human.from, 'cli');
      assert.deepEqual((await cli({ FORGE_DAEMON: undefined }, 'requests', 'add', 'resume', '--job', x, '--intake', 'next')).json().args, { intake: 'next' });
      assert.deepEqual((await cli({ FORGE_DAEMON: undefined }, 'requests', 'add', 'resume', '--job', x, '--intake', 'new')).json().args, { intake: 'new' });
      for (const args of [
        ['requests', 'add', 'approve', '--job', x, '--intake', 'run'],
        ['requests', 'add', 'next', '--intake', 'next'],
        ['requests', 'add', 'resume', '--job', x, '--intake', 'later'],
        ['requests', 'add', 'resume', '--job', x, '--intake'],
      ]) {
        const r = await cli({ FORGE_DAEMON: undefined }, ...args);
        assert.equal(r.ok, false, args.join(' '));
        assert.match(r.out, /--intake/);
      }
      const handed = (await cli({ ...trust, FORGE_DAEMON_SCOPE: '_inbox' }, 'requests', 'add', 'resume', '--job', x, '--intake', 'run')).json();
      assert.equal(handed.from, 'daemon:_inbox', 'a daemon session records which session queued it');
      assert.deepEqual(handed.args, { intake: 'run' });
      assert.equal((await cli({ ...trust, FORGE_DAEMON_SCOPE: x }, 'requests', 'add', 'resume', '--job', x)).json().from, `daemon:${x}`);
      // Guardrail (not a security boundary: provenance is the caller's env): a daemon session following the skill queues only resume hand-offs.
      for (const type of ['approve', 'revise-spec', 'rework', 'answer', 'cancel', 'next', 'run', 'sync']) {
        const r = await cli({ ...trust, FORGE_DAEMON_SCOPE: '_inbox' }, 'requests', 'add', type, '--job', x, '--text', 't');
        assert.equal(r.ok, false, type);
        assert.match(r.out, /queues only resume hand-offs/, type);
      }
      assert.equal((await cli({ FORGE_DAEMON: undefined }, 'requests', 'add', 'approve', '--job', x)).ok, true, 'a human may queue anything');
      assert.equal(listRequests(root).filter((r) => r.args?.intake).length, 4);
    } finally {
      repo.cleanup();
    }
  });

  test("resume hand-off releases the handing-off session's claim", async () => {
    const repo = tempRepo();
    const root = repo.dir;
    const cli = requestsIn(root);
    try {
      const x = createJob(root, defaults(), { title: 'Job X' }).id;
      const trust = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(root) };
      const human = { FORGE_DAEMON: undefined, FORGE_DAEMON_SCOPE: undefined };
      const [s1, s2, s3, inboxOld, inboxNow, jobSid] = Array.from({ length: 6 }, () => crypto.randomUUID());

      claimJob(root, x, s1);
      const own = (await cli(human, 'requests', 'add', 'resume', '--job', x, '--intake', 'run', '--session', s1)).json();
      assert.equal(own.released, true);
      assert.equal(own.type, 'resume');
      assert.equal(loadJob(root, x).lease.driver, null, 'the owner naming itself lets go');
      assert.ok(loadJob(root, x).runs.at(-1).endedAt);

      claimJob(root, x, s2);
      assert.equal((await cli(human, 'requests', 'add', 'resume', '--job', x, '--session', s3)).json().released, false);
      assert.equal((await cli(human, 'requests', 'add', 'resume', '--job', x)).json().released, false);
      assert.equal(loadJob(root, x).lease.driver, s2, 'another session never releases the claim');

      // The inbox hands off a job one of its sessions (current or past) claimed, without --session.
      fs.mkdirSync(path.join(root, '.forge', 'runtime', 'daemons'), { recursive: true });
      fs.writeFileSync(path.join(root, '.forge', 'runtime', 'daemons', '_inbox.json'), JSON.stringify({ sessionId: inboxNow, pastSessionIds: [inboxOld] }));
      const inbox = { ...trust, FORGE_DAEMON_SCOPE: '_inbox' };
      claimJob(root, x, inboxOld, true);
      const handed = (await cli(inbox, 'requests', 'add', 'resume', '--job', x, '--intake', 'run')).json();
      assert.equal(handed.released, true);
      assert.equal(handed.from, 'daemon:_inbox');
      assert.equal(loadJob(root, x).lease.driver, null);

      claimJob(root, x, jobSid);
      assert.equal((await cli(inbox, 'requests', 'add', 'resume', '--job', x)).json().released, false, "the inbox doesn't release a job session's claim");
      assert.equal((await cli({ ...trust, FORGE_DAEMON_SCOPE: x }, 'requests', 'add', 'resume', '--job', x)).json().released, false, 'a job scope without --session keeps the claim');
      assert.equal(loadJob(root, x).lease.driver, jobSid);

      const missing = await cli(human, 'requests', 'add', 'resume', '--job', 'no-such-job', '--session', s1);
      assert.equal(missing.ok, true, missing.out);
      assert.equal(missing.json().released, false);
    } finally {
      repo.cleanup();
    }
  });
});

test('requeue follows the lease', async () => {
  const repo = tempRepo();
  const root = repo.dir;
  const byId = (id: string) => listRequests(root).find((r) => r.id === id)!;
  const expire = (id: string) => updateJob(root, id, (j) => (j.lease.expiresAt = new Date(Date.now() - 1000).toISOString()));
  try {
    const job = createJob(root, defaults(), { title: 'Leased' }).id;
    claimJob(root, job, 'S');
    const r = enqueue(root, null, { type: 'resume', job });
    claimRequest(root, r.id, 'S');
    // A live lease of the claiming session keeps the request in progress, however long ago it was claimed.
    assert.deepEqual(requeueOrphanedRequests(root, { at: Date.now() + 10 * 60_000 }).requeued, []);
    assert.equal(byId(r.id).status, 'in-progress');

    // (a) its lease expired: back to pending, once, with a note on the job.
    expire(job);
    assert.deepEqual(requeueOrphanedRequests(root).requeued.map((x) => x.id), [r.id]);
    assert.deepEqual([byId(r.id).status, byId(r.id).requeues, byId(r.id).session], ['pending', 1, undefined]);
    assert.ok(readEvents(root, job).some((e) => e.type === 'note' && String(e.text).includes(`request ${r.id} (resume) is pending again`)));

    // Orphaned a second time: rejected with the fixed result, not requeued again.
    claimJob(root, job, 'T');
    claimRequest(root, r.id, 'T');
    const second = requeueOrphanedRequests(root, { exited: ['T'] });
    assert.deepEqual([second.requeued, second.rejected.map((x) => x.id)], [[], [r.id]]);
    assert.deepEqual([byId(r.id).status, byId(r.id).result], ['rejected', REQUEUE_REJECTED]);

    // (b) a session seen exiting, and (c) a job-less claim past 30 minutes.
    const inbox = enqueue(root, null, { type: 'next' });
    claimRequest(root, inbox.id, 'I');
    assert.deepEqual(requeueOrphans(root, { leaseOf: () => null }).requeued, [], 'a fresh job-less claim stays');
    // (c) never touches a busy session's claim, and is off for a caller that can't see the sessions.
    assert.deepEqual(requeueOrphans(root, { leaseOf: () => null, at: Date.now() + 31 * 60_000, busy: ['I'] }).requeued, [], 'a busy session');
    assert.deepEqual(requeueOrphans(root, { leaseOf: () => null, at: Date.now() + 31 * 60_000, byAge: false }).requeued, [], 'no age rule');
    assert.equal(byId(inbox.id).status, 'in-progress');
    assert.deepEqual(requeueOrphans(root, { leaseOf: () => null, at: Date.now() + 31 * 60_000 }).requeued.map((x) => x.id), [inbox.id]);
    claimRequest(root, inbox.id, 'J');
    assert.deepEqual(requeueOrphans(root, { leaseOf: () => null, exited: ['J'] }).rejected.map((x) => x.id), [inbox.id]);

    // `forge requests` requeues before it lists, so an interactive drain sees the request again.
    const other = createJob(root, defaults(), { title: 'Other' }).id;
    claimJob(root, other, 'U');
    const o = enqueue(root, null, { type: 'resume', job: other });
    claimRequest(root, o.id, 'U');
    expire(other);
    const listed = await forgeAsync(root, ['requests']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.ok(JSON.parse(listed.stdout).some((x: any) => x.id === o.id && x.status === 'pending'), listed.stderr);

    // While a forge dash runs, `forge requests` leaves the claim-age rule to the dash's reconciler.
    const old = enqueue(root, null, { type: 'next' });
    claimRequest(root, old.id, 'K');
    const file = path.join(root, '.forge', 'runtime', 'requests', `${old.id}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), updatedAt: new Date(Date.now() - 31 * 60_000).toISOString() }));
    const dash = tryLock(daemonLockDir(root));
    assert.ok('release' in dash);
    try {
      await forgeAsync(root, ['requests']);
      assert.equal(byId(old.id).status, 'in-progress', 'a live dash holds the daemon lock');
    } finally {
      dash.release();
    }
    await forgeAsync(root, ['requests']);
    assert.equal(byId(old.id).status, 'pending', 'no dash: the age rule applies');
  } finally {
    repo.cleanup();
  }
});
