import test, { describe } from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forgeAsync, tempRepo } from './helpers.ts';
import { TRUST_ENV, defaults, trustDigest } from '../lib/config.ts';
import { claimJob, createJob, loadJob } from '../lib/jobs.ts';
import { ackRequest, claimRequest, enqueue, listRequests } from '../lib/requests.ts';

/** Runs the CLI against a scratch repo; `env` adds to (or, with undefined, removes from) the environment. */
function cliIn(dir) {
  return async (env, ...args) => {
    const r = await forgeAsync(dir, args, env);
    return r.status === 0 ? { ok: true, code: 0, out: r.stdout.trim(), json: () => JSON.parse(r.stdout) } : { ok: false, code: r.status, out: `${r.stdout}${r.stderr}`, json: () => null };
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
      const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'requests.ts'), 'utf8');
      assert.equal(src.includes('child_process'), false);
    } finally {
      repo.cleanup();
    }
  });

  test('a daemon session sees and claims only its scope', async () => {
    const repo = tempRepo();
    const root = repo.dir;
    const cli = cliIn(root);
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
    const cli = cliIn(root);
    try {
      const a = createJob(root, defaults(), { title: 'Job A' }).id;
      const gate = enqueue(root, null, { type: 'gate', job: a, args: { gate: 'spec-approval', reserved: null }, from: 'forge' });
      const resume = enqueue(root, null, { type: 'resume', job: a, from: 'dashboard' });
      const next = enqueue(root, null, { type: 'next', from: 'dashboard' });
      assert.throws(() => enqueue(root, null, { type: 'gate', job: '../x', from: 'forge' }), /gate request needs a valid job/);
      assert.throws(() => enqueue(root, null, { type: 'gate', from: 'forge' }), /gate request needs a valid job/);
      const office = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(root), FORGE_DAEMON_SCOPE: '_office' };
      assert.deepEqual((await cli(office, 'requests', 'scope')).json(), { daemon: true, scope: 'office', job: null });
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
      assert.equal((await cli(office, 'requests', 'claim', gate.id, '--session', 'office')).json().status, 'in-progress');
      assert.equal((await cli(office, 'requests', 'ack', gate.id, '--status', 'done', '--result', 'approve: fine')).json().status, 'done');
      assert.equal(listRequests(root).find((r) => r.id === resume.id).status, 'pending');
    } finally {
      repo.cleanup();
    }
  });

  test('requests scope, --intake and daemon provenance', async () => {
    const repo = tempRepo();
    const root = repo.dir;
    const cli = cliIn(root);
    try {
      const x = createJob(root, defaults(), { title: 'Job X' }).id;
      const trust = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(root) };
      assert.deepEqual((await cli({ FORGE_DAEMON: undefined }, 'requests', 'scope')).json(), { daemon: false, scope: null, job: null });
      assert.deepEqual((await cli({ ...trust, FORGE_DAEMON_SCOPE: '_inbox' }, 'requests', 'scope')).json(), { daemon: true, scope: 'inbox', job: null });
      assert.deepEqual((await cli({ ...trust, FORGE_DAEMON_SCOPE: x }, 'requests', 'scope')).json(), { daemon: true, scope: 'job', job: x });

      const human = (await cli({ FORGE_DAEMON: undefined }, 'requests', 'add', 'resume', '--job', x, '--intake', 'run')).json();
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
    const cli = cliIn(root);
    try {
      const x = createJob(root, defaults(), { title: 'Job X' }).id;
      const trust = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(root) };
      const human = { FORGE_DAEMON: undefined, FORGE_DAEMON_SCOPE: undefined };
      const [s1, s2, s3, inboxOld, inboxNow, jobSid] = Array.from({ length: 6 }, () => crypto.randomUUID());

      claimJob(root, x, s1);
      const own = (await cli(human, 'requests', 'add', 'resume', '--job', x, '--intake', 'run', '--session', s1)).json();
      assert.equal(own.released, true);
      assert.equal(own.type, 'resume');
      assert.equal(loadJob(root, x).owner, null, 'the owner naming itself lets go');
      assert.ok(loadJob(root, x).runs.at(-1).endedAt);

      claimJob(root, x, s2);
      assert.equal((await cli(human, 'requests', 'add', 'resume', '--job', x, '--session', s3)).json().released, false);
      assert.equal((await cli(human, 'requests', 'add', 'resume', '--job', x)).json().released, false);
      assert.equal(loadJob(root, x).owner.session, s2, 'another session never releases the claim');

      // The inbox hands off a job one of its sessions (current or past) claimed, without --session.
      fs.mkdirSync(path.join(root, '.forge', 'runtime', 'daemons'), { recursive: true });
      fs.writeFileSync(path.join(root, '.forge', 'runtime', 'daemons', '_inbox.json'), JSON.stringify({ sessionId: inboxNow, pastSessionIds: [inboxOld] }));
      const inbox = { ...trust, FORGE_DAEMON_SCOPE: '_inbox' };
      claimJob(root, x, inboxOld, true);
      const handed = (await cli(inbox, 'requests', 'add', 'resume', '--job', x, '--intake', 'run')).json();
      assert.equal(handed.released, true);
      assert.equal(handed.from, 'daemon:_inbox');
      assert.equal(loadJob(root, x).owner, null);

      claimJob(root, x, jobSid);
      assert.equal((await cli(inbox, 'requests', 'add', 'resume', '--job', x)).json().released, false, "the inbox doesn't release a job session's claim");
      assert.equal((await cli({ ...trust, FORGE_DAEMON_SCOPE: x }, 'requests', 'add', 'resume', '--job', x)).json().released, false, 'a job scope without --session keeps the claim');
      assert.equal(loadJob(root, x).owner.session, jobSid);

      const missing = await cli(human, 'requests', 'add', 'resume', '--job', 'no-such-job', '--session', s1);
      assert.equal(missing.ok, true, missing.out);
      assert.equal(missing.json().released, false);
    } finally {
      repo.cleanup();
    }
  });
});
