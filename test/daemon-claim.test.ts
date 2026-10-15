import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { TRUST_ENV, defaults, trustDigest } from '../lib/config.ts';
import { initWrite } from '../lib/commands/init.ts';
import { daemonClaimOpts, inboxSessionIds, ownerYield } from '../lib/daemon-owner.ts';
import { claimJob, createJob, jobDir, loadJob, readEvents, recordAgent } from '../lib/jobs.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const FAKE_BIN = path.resolve(import.meta.dirname, 'fixtures', 'bin', 'claude');
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A pid that belonged to a child which has exited and been reaped. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '0']);
  return r.pid as number;
}

const daemonsDir = (dir) => path.join(dir, '.forge', 'runtime', 'daemons');
function writeRecord(dir: string, scope: string, rec: Record<string, unknown>) {
  fs.mkdirSync(daemonsDir(dir), { recursive: true });
  fs.writeFileSync(path.join(daemonsDir(dir), `${scope}.json`), JSON.stringify({ resumable: true, serverPid: null, argv0: FAKE_BIN, startedAt: new Date().toISOString(), ...rec }));
}

const notes = (root, id) => readEvents(root, id).filter((e) => e.type === 'note').map((e) => e.text);

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

test('dead recorded daemon owner yields', () => {
  const repo = tempRepo();
  const root = repo.dir;
  try {
    const id = createJob(root, defaults(), { title: 'Dead owner' }).id;
    const old = uuid();
    claimJob(root, id, old);
    writeRecord(root, id, { sessionId: old, spawnSessionId: old, pid: deadPid() });
    const next = uuid();
    assert.throws(() => claimJob(root, id, next), (e: any) => e.exitCode === 3, 'without the yield check the fresh heartbeat still holds');
    assert.equal(claimJob(root, id, next, false, daemonClaimOpts(root, id)).owner.session, next);
    assert.deepEqual(notes(root, id), [`took over from session ${old}: not-running`]);
    const types = readEvents(root, id).map((e) => e.type);
    assert.ok(types.lastIndexOf('note') > types.lastIndexOf('claimed'), 'the note follows the claim');

    // A record with no child at all is not running either.
    writeRecord(root, id, { sessionId: next, spawnSessionId: next, pid: null });
    const third = uuid();
    assert.equal(claimJob(root, id, third, false, daemonClaimOpts(root, id)).owner.session, third);
    assert.equal(loadJob(root, id).runs.length, 3, 'each takeover starts a new run');
  } finally {
    repo.cleanup();
  }
});

test('session that changed uuid reclaims its job', () => {
  const repo = tempRepo();
  const root = repo.dir;
  try {
    const id = createJob(root, defaults(), { title: 'Moved on' }).id;
    const old = uuid();
    const current = uuid();
    claimJob(root, id, old);
    recordAgent(root, id, { role: 'builder', phase: 'start' }, defaults());
    // The record now holds another id; whether its child lives doesn't matter.
    writeRecord(root, id, { sessionId: current, spawnSessionId: current, pastSessionIds: [uuid(), old], pid: process.pid });
    assert.throws(() => claimJob(root, id, current), /an agent is still running/);
    assert.equal(ownerYield(root, id, loadJob(root, id).owner, { isLive: () => true }), 'moved-on');
    assert.equal(claimJob(root, id, current, false, daemonClaimOpts(root, id)).owner.session, current);
    assert.deepEqual(notes(root, id), [`took over from session ${old}: moved-on`]);

    // The id the current child was spawned with counts as past once init reported another.
    const spawned = uuid();
    const reported = uuid();
    claimJob(root, id, spawned, true);
    writeRecord(root, id, { sessionId: reported, spawnSessionId: spawned, pid: process.pid });
    assert.equal(ownerYield(root, id, loadJob(root, id).owner, { isLive: () => true }), 'moved-on');
    // A non-uuid past entry never matches.
    claimJob(root, id, 'not-a-uuid', true);
    writeRecord(root, id, { sessionId: uuid(), pastSessionIds: ['not-a-uuid'], pid: null });
    assert.equal(ownerYield(root, id, loadJob(root, id).owner), null);
  } finally {
    repo.cleanup();
  }
});

test('inbox owner yields only to the job\'s own session', POSIX, async () => {
  const repo = initRepo();
  const root = repo.dir;
  const cli = cliIn(root);
  const inboxSid = uuid();
  // A provably live inbox child: the recorded claude executable running with the recorded session id.
  const child = nodeSpawn(FAKE_BIN, ['--session-id', inboxSid], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  try {
    const id = createJob(root, defaults(), { title: 'Handoff' }).id;
    const other = createJob(root, defaults(), { title: 'Other' }).id;
    const end = Date.now() + 3000;
    while (!alive(child.pid) && Date.now() < end) await sleep(10);
    await sleep(100);
    writeRecord(root, '_inbox', { sessionId: inboxSid, spawnSessionId: inboxSid, pastSessionIds: [], pid: child.pid, serverPid: process.pid });
    assert.deepEqual(inboxSessionIds(root), [inboxSid]);
    claimJob(root, id, inboxSid);
    assert.equal(ownerYield(root, id, loadJob(root, id).owner), null, 'the live inbox child holds the job against everyone but its session');

    const trust = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(root) };
    const jobSid = uuid();
    const human = cli({ FORGE_DAEMON: undefined, FORGE_DAEMON_SCOPE: undefined }, 'job', 'claim', id, '--session', jobSid);
    assert.equal(human.code, 3, human.out);
    const wrongScope = cli({ ...trust, FORGE_DAEMON_SCOPE: other }, 'job', 'claim', id, '--session', jobSid);
    assert.equal(wrongScope.code, 3, wrongScope.out);
    assert.equal(loadJob(root, id).owner.session, inboxSid);

    const mine = cli({ ...trust, FORGE_DAEMON_SCOPE: id }, 'job', 'claim', id, '--session', jobSid);
    assert.equal(mine.ok, true, mine.out);
    assert.equal(mine.json().owner.session, jobSid);
    assert.deepEqual(notes(root, id), [`took over from session ${inboxSid}: inbox-handoff`]);
  } finally {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
    repo.cleanup();
  }
});

test('live or unrecorded owners are still refused', () => {
  const repo = tempRepo();
  const root = repo.dir;
  try {
    const id = createJob(root, defaults(), { title: 'Live owner' }).id;
    const interactive = uuid();
    claimJob(root, id, interactive);
    writeRecord(root, id, { sessionId: uuid(), pastSessionIds: [uuid()], pid: null });
    assert.throws(() => claimJob(root, id, uuid(), false, daemonClaimOpts(root, id)), (e: any) => e.exitCode === 3, 'a session in no record keeps the time-based rule');

    const daemon = uuid();
    claimJob(root, id, daemon, true);
    writeRecord(root, id, { sessionId: daemon, spawnSessionId: daemon, pid: process.pid });
    const live = { yields: (o) => ownerYield(root, id, o, { isLive: () => true }) };
    assert.throws(() => claimJob(root, id, uuid(), false, live), (e: any) => e.exitCode === 3, 'a recorded owner whose child is proven live keeps the job');
    // A second record naming the same id as past doesn't outvote the live current one.
    writeRecord(root, '_inbox', { sessionId: uuid(), pastSessionIds: [daemon], pid: null });
    assert.throws(() => claimJob(root, id, uuid(), false, live), (e: any) => e.exitCode === 3);
    const forced = uuid();
    assert.equal(claimJob(root, id, forced, true, live).owner.session, forced, '--force still takes over');
    assert.deepEqual(notes(root, id), [], 'a forced takeover logs no yield');
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
