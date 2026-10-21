// How daemon sessions let go of jobs: a pool start expires every lease an earlier `forge dash`'s
// sessions held (with the daemon lock taken, none of their children can still run) and requeues the
// requests they claimed; the inbox hands a job to its own session by releasing the claim; and the
// inbox scope never drives a pipeline.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { TRUST_ENV, defaults, trustDigest } from '../lib/config.ts';
import { initWrite } from '../lib/commands/init.ts';
import { createPool } from '../lib/daemon-pool.ts';
import { claimJob, createJob, jobDir, leaseStatus, loadJob, readEvents } from '../lib/jobs.ts';
import { claimRequest, enqueue, listRequests } from '../lib/requests.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const FAKE_BIN = path.resolve(import.meta.dirname, 'fixtures', 'bin', 'claude');
const uuid = () => crypto.randomUUID();

const daemonsDir = (dir) => path.join(dir, '.forge', 'runtime', 'daemons');
function writeRecord(dir: string, scope: string, rec: Record<string, unknown>) {
  fs.mkdirSync(daemonsDir(dir), { recursive: true });
  fs.writeFileSync(path.join(daemonsDir(dir), `${scope}.json`), JSON.stringify({ resumable: true, serverPid: null, argv0: FAKE_BIN, startedAt: new Date().toISOString(), ...rec }));
}

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

/** An initialised scratch repo whose worktrees live in a sibling dir, removed on cleanup. */
function initRepo() {
  const repo = tempRepo();
  const wt = `${repo.dir}.wt`;
  initWrite(repo.dir, { worktrees: { root: `../${path.basename(repo.dir)}.wt` } }, false);
  return {
    ...repo,
    cleanup: () => {
      repo.cleanup();
      fs.rmSync(wt, { recursive: true, force: true });
    },
  };
}

/** In-memory claude children: nothing real is spawned or signalled. */
function fakeSpawn() {
  let n = 0;
  const spawn: any = () => {
    const c: any = new EventEmitter();
    c.pid = 4_200_000 + ++n;
    c.stdin = new PassThrough();
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    return c;
  };
  const killTree = (c: any) => setImmediate(() => c.emit('close', null, 'SIGTERM'));
  return { spawn, killTree };
}

test('boot expires daemon leases', async () => {
  const repo = tempRepo();
  const root = repo.dir;
  const cfg = defaults();
  Object.assign(cfg.daemon, { enabled: true, command: 'claude {session} --plugin-dir {pluginRoot} --allowedTools {allowedTools}' });
  const kit = fakeSpawn();
  const pool = createPool(root, { ...kit, loadConfig: () => ({ config: cfg }), pollMs: 3_600_000, syncMs: 0, reconcileMs: 0 });
  try {
    // An earlier dash's records: a job session that moved on from s0 to s1, and the inbox.
    const [s0, s1, inbox, human] = [uuid(), uuid(), uuid(), uuid()];
    const [a, b, c] = ['A', 'B', 'C'].map((t) => createJob(root, defaults(), { title: `Job ${t}` }).id);
    writeRecord(root, a, { sessionId: s1, spawnSessionId: s1, pastSessionIds: [s0], pid: null });
    writeRecord(root, '_inbox', { sessionId: inbox, spawnSessionId: inbox, pastSessionIds: [], pid: null });
    claimJob(root, a, s1);
    claimJob(root, b, s0);
    claimJob(root, c, human);
    const ra = enqueue(root, null, { type: 'resume', job: a });
    claimRequest(root, ra.id, s1);
    const rInbox = enqueue(root, null, { type: 'next' });
    claimRequest(root, rInbox.id, inbox);
    const rc = enqueue(root, null, { type: 'resume', job: c });
    claimRequest(root, rc.id, human);
    for (const id of [a, b, c]) assert.equal(leaseStatus(loadJob(root, id)).status, 'live');

    assert.equal(pool.start().wanted, true);
    assert.equal(leaseStatus(loadJob(root, a)).status, 'expired', "the current id's lease");
    assert.equal(leaseStatus(loadJob(root, b)).status, 'expired', "a past id's lease");
    assert.equal(loadJob(root, a).lease.driver, s1, 'expiry keeps the driver and epoch');
    assert.equal(leaseStatus(loadJob(root, c)).status, 'live', 'an interactive session in no record keeps its lease');
    assert.ok(readEvents(root, a).some((e) => e.type === 'lease-expired' && e.reason === 'dash-start'));
    const byId = new Map(listRequests(root).map((r) => [r.id, r]));
    assert.deepEqual([byId.get(ra.id)?.status, byId.get(ra.id)?.requeues, byId.get(ra.id)?.session], ['pending', 1, undefined]);
    assert.deepEqual([byId.get(rInbox.id)?.status, byId.get(rInbox.id)?.requeues], ['pending', 1]);
    assert.deepEqual([byId.get(rc.id)?.status, byId.get(rc.id)?.session], ['in-progress', human], "the interactive session's claim stays");
  } finally {
    await pool.close();
    repo.cleanup();
  }
});

test("the inbox hands a job to the job's own session by releasing its claim", () => {
  const repo = initRepo();
  const root = repo.dir;
  const cli = cliIn(root);
  try {
    const id = createJob(root, defaults(), { title: 'Handoff' }).id;
    const inboxSid = uuid();
    writeRecord(root, '_inbox', { sessionId: inboxSid, spawnSessionId: inboxSid, pastSessionIds: [], pid: null });
    claimJob(root, id, inboxSid);
    const trust = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(root) };
    const jobSid = uuid();
    // While the inbox's lease is live, nobody else takes the job without --force.
    assert.equal(cli({ ...trust, FORGE_DAEMON_SCOPE: id }, 'job', 'claim', id, '--session', jobSid).code, 3);
    const handoff = cli({ ...trust, FORGE_DAEMON_SCOPE: '_inbox' }, 'requests', 'add', 'resume', '--job', id);
    assert.equal(handoff.json().released, true, handoff.out);
    assert.deepEqual([loadJob(root, id).lease.driver, loadJob(root, id).lease.epoch], [null, 1]);
    const mine = cli({ ...trust, FORGE_DAEMON_SCOPE: id }, 'job', 'claim', id, '--session', jobSid);
    assert.equal(mine.ok, true, mine.out);
    assert.deepEqual([mine.json().lease.driver, mine.json().epoch], [jobSid, 2]);
  } finally {
    repo.cleanup();
  }
});

test('inbox scope refuses to drive a pipeline', () => {
  const repo = initRepo();
  const root = repo.dir;
  const cli = cliIn(root);
  try {
    const a = createJob(root, defaults(), { title: 'Job A' }).id;
    const b = createJob(root, defaults(), { title: 'Job B' }).id;
    const trust = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(root) };
    const inbox = { ...trust, FORGE_DAEMON_SCOPE: '_inbox' };
    const hint = new RegExp(`the inbox daemon session does not drive jobs; hand ${a} off with \`forge requests add resume --job ${a} --session <your session>\``);

    const wt = cli(inbox, 'worktree', 'create', a);
    assert.equal(wt.code, 1);
    assert.match(wt.out, hint);
    assert.equal(loadJob(root, a).worktree, null);
    assert.equal(fs.existsSync(`${root}.wt`), false);
    const start = cli(inbox, 'job', 'agent', a, 'start', '--role', 'builder');
    assert.equal(start.code, 1);
    assert.match(start.out, hint);
    assert.deepEqual(loadJob(root, a).agents, {});
    // `end` stays allowed, so a stray start can still be closed.
    assert.equal(cli(inbox, 'job', 'agent', a, 'end', '--role', 'builder', '--status', 'failed').ok, true);
    const jobFile = path.join(jobDir(root, a), 'job.json');
    const beforeAdvance = fs.readFileSync(jobFile, 'utf8');
    const adv = cli(inbox, 'job', 'advance', a, '--session', uuid());
    assert.equal(adv.code, 1);
    assert.match(adv.out, hint);
    assert.equal(fs.readFileSync(jobFile, 'utf8'), beforeAdvance);

    const scoped = { ...trust, FORGE_DAEMON_SCOPE: a };
    const made = cli(scoped, 'worktree', 'create', a);
    assert.equal(made.ok, true, made.out);
    assert.ok(fs.existsSync(made.json().path));
    assert.equal(cli(scoped, 'job', 'agent', a, 'start', '--role', 'builder').json().status, 'running');
    const human = { FORGE_DAEMON: undefined, FORGE_DAEMON_SCOPE: undefined };
    assert.equal(cli(human, 'worktree', 'create', b).ok, true);
    assert.equal(cli(human, 'job', 'agent', b, 'start', '--role', 'builder').json().status, 'running');
  } finally {
    repo.cleanup();
  }
});
