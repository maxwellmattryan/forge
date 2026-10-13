import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { TRUST_ENV, defaults, trustDigest } from '../lib/config.ts';
import { createJob } from '../lib/jobs.ts';
import { ackRequest, claimRequest, enqueue, listRequests } from '../lib/requests.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

/** Runs the CLI against a scratch repo; `env` adds to (or, with undefined, removes from) the environment. */
function cliIn(dir) {
  return (env, ...args) => {
    const full = { ...process.env, FORGE_ROOT: dir, ...env };
    for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k];
    try {
      const out = execFileSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe', env: full });
      return { ok: true, code: 0, out: out.trim(), json: () => JSON.parse(out) };
    } catch (e) {
      return { ok: false, code: e.status, out: `${e.stdout}${e.stderr}`, json: () => null };
    }
  };
}

test('one session claims a request; a second is refused until the first is done or stale', () => {
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

test('AC4: enqueue only writes the inbox file', () => {
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

test('a daemon session sees and claims only its scope', () => {
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

    assert.deepEqual(ids(cli({ ...trust, FORGE_DAEMON_SCOPE: a }, 'requests')), [ra.id, ra2.id].sort(), "scope A lists only A's job requests");
    assert.deepEqual(ids(cli({ ...trust, FORGE_DAEMON_SCOPE: a }, 'requests', 'list', '--all')), [ra.id, ra2.id].sort());
    assert.deepEqual(ids(cli({ ...trust, FORGE_DAEMON_SCOPE: b }, 'requests', 'list')), [rb.id]);
    assert.deepEqual(ids(cli({ ...trust, FORGE_DAEMON_SCOPE: '_inbox' }, 'requests')), [next.id, unknown.id].sort(), 'the inbox lists job-less and unknown-job requests');

    const wrong = cli({ ...trust, FORGE_DAEMON_SCOPE: a }, 'requests', 'claim', rb.id, '--session', 's-a');
    assert.equal(wrong.code, 1);
    assert.match(wrong.out, new RegExp(`request ${rb.id} belongs to scope ${b}, not this session's scope ${a}`));
    assert.equal(listRequests(root).find((r) => r.id === rb.id).status, 'pending', 'nothing was claimed');
    const fromInbox = cli({ ...trust, FORGE_DAEMON_SCOPE: '_inbox' }, 'requests', 'claim', ra.id, '--session', 's-i');
    assert.match(fromInbox.out, /belongs to scope/);
    const mine = cli({ ...trust, FORGE_DAEMON_SCOPE: a }, 'requests', 'claim', ra.id, '--session', 's-a');
    assert.equal(mine.ok, true, mine.out);
    assert.equal(mine.json().status, 'in-progress');
    assert.equal(cli({ ...trust, FORGE_DAEMON_SCOPE: '_inbox' }, 'requests', 'claim', next.id, '--session', 's-i').ok, true);

    for (const scope of [undefined, '', '../x', '--all', 'a'.repeat(201), 'job a']) {
      for (const args of [['requests'], ['requests', 'list', '--all'], ['requests', 'claim', rb.id, '--session', 's'], ['requests', 'scope']]) {
        const r = cli({ ...trust, FORGE_DAEMON_SCOPE: scope }, ...args);
        assert.equal(r.ok, false, `${JSON.stringify(scope)} ${args.join(' ')}`);
        assert.match(r.out, /forge refuses: FORGE_DAEMON_SCOPE is missing or invalid in this daemon session/);
      }
    }
    // Outside a daemon session a human sees and may claim everything.
    assert.deepEqual(ids(cli({ FORGE_DAEMON: undefined, FORGE_DAEMON_SCOPE: a }, 'requests')), [ra2.id, rb.id, unknown.id].sort());
    assert.equal(cli({ FORGE_DAEMON: undefined }, 'requests', 'claim', rb.id, '--session', 'human').ok, true);
  } finally {
    repo.cleanup();
  }
});

test('requests scope, --intake and daemon provenance', () => {
  const repo = tempRepo();
  const root = repo.dir;
  const cli = cliIn(root);
  try {
    const x = createJob(root, defaults(), { title: 'Job X' }).id;
    const trust = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(root) };
    assert.deepEqual(cli({ FORGE_DAEMON: undefined }, 'requests', 'scope').json(), { daemon: false, scope: null, job: null });
    assert.deepEqual(cli({ ...trust, FORGE_DAEMON_SCOPE: '_inbox' }, 'requests', 'scope').json(), { daemon: true, scope: 'inbox', job: null });
    assert.deepEqual(cli({ ...trust, FORGE_DAEMON_SCOPE: x }, 'requests', 'scope').json(), { daemon: true, scope: 'job', job: x });

    const human = cli({ FORGE_DAEMON: undefined }, 'requests', 'add', 'resume', '--job', x, '--intake', 'run').json();
    assert.deepEqual(human.args, { intake: 'run' });
    assert.equal(human.from, 'cli');
    assert.deepEqual(cli({ FORGE_DAEMON: undefined }, 'requests', 'add', 'resume', '--job', x, '--intake', 'next').json().args, { intake: 'next' });
    for (const args of [
      ['requests', 'add', 'approve', '--job', x, '--intake', 'run'],
      ['requests', 'add', 'next', '--intake', 'next'],
      ['requests', 'add', 'resume', '--job', x, '--intake', 'later'],
      ['requests', 'add', 'resume', '--job', x, '--intake'],
    ]) {
      const r = cli({ FORGE_DAEMON: undefined }, ...args);
      assert.equal(r.ok, false, args.join(' '));
      assert.match(r.out, /--intake/);
    }
    const handed = cli({ ...trust, FORGE_DAEMON_SCOPE: '_inbox' }, 'requests', 'add', 'resume', '--job', x, '--intake', 'run').json();
    assert.equal(handed.from, 'daemon:_inbox', 'a daemon session records which session queued it');
    assert.deepEqual(handed.args, { intake: 'run' });
    assert.equal(cli({ ...trust, FORGE_DAEMON_SCOPE: x }, 'requests', 'add', 'resume', '--job', x).json().from, `daemon:${x}`);
    assert.equal(listRequests(root).filter((r) => r.args?.intake).length, 3);
  } finally {
    repo.cleanup();
  }
});
