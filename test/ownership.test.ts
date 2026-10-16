// Who keeps a job's claim alive (only the owner's own activity), when idle claims are released
// (parking, split children), and how `forge next --claim` resumes queued jobs before new items.
// Every test gets its own copy of one initialised repo, so they run side by side.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { forgeAsync, repoTemplate, tempRepo } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import { daemonClaimOpts, jobSessionEnv, ownerStatusWithProof } from '../lib/daemon-owner.ts';
import { refreshDependencyWait, DEP_REASON } from '../lib/deps.ts';
import { claimJob, createJob, jobDir, loadJob, ownerStatus, readEvents, recordAgent, releaseJob, setJob, touchJob, updateJob } from '../lib/jobs.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const OLD = '2020-01-02T03:04:05.000Z';
const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000).toISOString();
const FAKE_BIN = path.resolve(import.meta.dirname, 'fixtures', 'bin', 'claude');
const uuid = () => crypto.randomUUID();

/** A pid that belonged to a child which has exited and been reaped. */
const deadPid = (): number => spawnSync(process.execPath, ['-e', '0']).pid as number;

const daemonsDir = (root: string) => path.join(root, '.forge', 'runtime', 'daemons');
function writeRecord(root: string, scope: string, rec: Record<string, unknown>) {
  fs.mkdirSync(daemonsDir(root), { recursive: true });
  fs.writeFileSync(path.join(daemonsDir(root), `${scope}.json`), JSON.stringify({ resumable: true, serverPid: null, argv0: FAKE_BIN, startedAt: new Date().toISOString(), ...rec }));
}

/** Initialised once per file: a local tracker, PRs off and worktrees in `<repo>.wt`. */
const initialised = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false }, worktrees: { root: '../{repo}.wt' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, stdio: 'pipe', env: { ...process.env, FORGE_ROOT: dir } });
});

/** A scratch repo with a local tracker, PRs off and worktrees in `<repo>.wt`. */
function scratch() {
  const repo = initialised();
  const root = repo.dir;
  const wtRoot = `${root}.wt`;
  const raw = (...args: string[]) => forgeAsync(root, args);
  const f = async (...args: string[]) => {
    const r = await raw(...args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return r.stdout.trim();
    }
  };
  const jobFile = (id: string) => path.join(jobDir(root, id), 'job.json');
  const job = (id: string) => JSON.parse(fs.readFileSync(jobFile(id), 'utf8'));
  /** Edits job.json behind the CLI's back, as a hand edit or an older Forge would have left it. */
  const plant = (id: string, mutate: (j: any) => void) => {
    const j = job(id);
    mutate(j);
    fs.writeFileSync(jobFile(id), JSON.stringify(j, null, 2));
  };
  const newJob = async (ref: string) => (await f('job', 'new', '--title', `Job ${ref}`, '--ref', ref)).id as string;
  const types = (id: string) => readEvents(root, id).map((e) => e.type);
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(wtRoot, { recursive: true, force: true });
  };
  return { root, raw, f, job, jobFile, plant, newJob, types, cleanup };
}

/** Every path under dir with its bytes, so a test can assert nothing changed. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(dir, { recursive: true }).map(String).sort()) {
    const p = path.join(dir, f);
    out[f] = fs.statSync(p).isDirectory() ? '<dir>' : fs.readFileSync(p, 'base64');
  }
  return out;
}

describe('claims and ownership', { concurrency: 4 }, () => {
  test("only the owner's own activity refreshes the heartbeat", async () => {
    const s = scratch();
    const config = defaults();
    try {
      const id = createJob(s.root, config, { title: 'Owned' }).id;
      claimJob(s.root, id, 'A');
      s.plant(id, (j) => (j.owner.heartbeat = OLD));
      const unchanged = (what: string) => assert.equal(loadJob(s.root, id).owner?.heartbeat, OLD, `${what} leaves the heartbeat alone`);

      setJob(s.root, id, { stage: 'build' });
      unchanged('setJob stage');
      setJob(s.root, id, { state: 'running' });
      unchanged('setJob state');
      setJob(s.root, id, { fields: { kind: 'bug' } });
      unchanged('setJob fields');
      setJob(s.root, id, { note: 'hello' });
      unchanged('setJob note');
      updateJob(s.root, id, (j) => (j.round += 1));
      unchanged('updateJob');
      recordAgent(s.root, id, { role: 'builder', phase: 'start' }, config);
      unchanged('recordAgent start');
      recordAgent(s.root, id, { role: 'builder', phase: 'end' }, config);
      unchanged('recordAgent end');
      assert.equal(releaseJob(s.root, id, () => false), false);
      unchanged('a refused releaseJob');
      createJob(s.root, config, { title: 'Child', parent: id });
      assert.equal(loadJob(s.root, id).children.length, 1);
      unchanged("createJob's write to the parent");

      // A legacy parked job that still has an owner: a reason rewrite and the unpark keep the owner.
      const dep = createJob(s.root, config, { title: 'Dep' }).id;
      s.plant(id, (j) => Object.assign(j, { state: 'waiting', waitingOn: 'external', reason: `${DEP_REASON}old text`, dependsOn: [dep] }));
      refreshDependencyWait(s.root, id);
      assert.equal(loadJob(s.root, id).reason, `${DEP_REASON}${dep} (backlog/queued)`);
      unchanged('a park-rewrite');
      setJob(s.root, dep, { state: 'done' });
      assert.equal(refreshDependencyWait(s.root, id).released, true);
      assert.equal(loadJob(s.root, id).state, 'queued');
      assert.equal(loadJob(s.root, id).owner?.session, 'A', 'unparking keeps the owner');
      unchanged('an unpark');

      assert.equal(touchJob(s.root, id, 'A'), true);
      assert.ok(loadJob(s.root, id).owner!.heartbeat > OLD, 'touchJob by the owner refreshes');
      s.plant(id, (j) => (j.owner.heartbeat = OLD));
      claimJob(s.root, id, 'A');
      assert.ok(loadJob(s.root, id).owner!.heartbeat > OLD, 'claimJob refreshes');
    } finally {
      s.cleanup();
    }
  });

  test('a sync that unblocks a parked job does not refresh a stale owner', async () => {
    const s = scratch();
    try {
      const d = await s.newJob('d');
      const j = await s.newJob('j');
      await s.f('job', 'set', j, '--field', 'dependsOn=["d"]');
      assert.equal(s.job(j).state, 'waiting');
      const stale = minutesAgo(45);
      // Jobs parked before this change kept their owner.
      s.plant(j, (x) => (x.owner = { session: 'A', host: 'h', since: stale, heartbeat: stale }));
      await s.f('job', 'set', d, '--state', 'done');
      const sync = await s.f('sync');
      assert.deepEqual(sync.results.find((r: any) => r.id === j), { id: j, unblocked: true });
      assert.equal(s.job(j).state, 'queued');
      assert.equal(s.job(j).owner.heartbeat, stale, 'sync left the heartbeat alone');
      assert.equal((await s.f('job', 'claim', j, '--session', 'B')).owner.session, 'B', 'the stale owner yields without --force');
    } finally {
      s.cleanup();
    }
  });

  test("foreign writes never keep someone else's claim alive", async () => {
    const s = scratch();
    try {
      const j = await s.newJob('j');
      await s.f('job', 'claim', j, '--session', 'A');
      const stale = minutesAgo(45);
      s.plant(j, (x) => (x.owner.heartbeat = stale));
      await s.f('job', 'set', j, '--note', 'x');
      await s.f('job', 'set', j, '--field', 'kind=bug');
      await s.f('requests', 'add', 'approve', '--job', j);
      await s.f('job', 'step', j, '--session', 'B');
      assert.equal(s.job(j).owner.heartbeat, stale);
      assert.equal((await s.f('job', 'claim', j, '--session', 'B')).owner.session, 'B');
    } finally {
      s.cleanup();
    }
  });

  test('job step --session refreshes only its own claim', async () => {
    const s = scratch();
    try {
      const j = await s.newJob('j');
      await s.f('job', 'claim', j, '--session', 'A');
      s.plant(j, (x) => (x.owner.heartbeat = OLD));
      const dir = jobDir(s.root, j);
      const before = snapshot(dir);
      const plain = await s.raw('job', 'step', j);
      assert.equal(plain.status, 0);
      assert.deepEqual(snapshot(dir), before, 'no --session: read-only');
      const other = await s.raw('job', 'step', j, '--session', 'B');
      assert.equal(other.stdout, plain.stdout);
      assert.deepEqual(snapshot(dir), before, 'another session: read-only');
      const own = await s.raw('job', 'step', j, '--session', 'A');
      assert.equal(own.status, 0);
      assert.equal(own.stdout, plain.stdout, 'the output is the same JSON');
      assert.ok(s.job(j).owner.heartbeat > OLD, "the owner's step is its heartbeat");
    } finally {
      s.cleanup();
    }
  });

  test('touchJob refreshes only the named owner', async () => {
    const s = scratch();
    try {
      const id = createJob(s.root, defaults(), { title: 'Touch' }).id;
      const file = s.jobFile(id);
      const same = () => ({ bytes: fs.readFileSync(file, 'utf8'), mtime: fs.statSync(file).mtimeMs });
      let before = same();
      assert.equal(touchJob(s.root, id, 'A'), false, 'no owner');
      assert.equal(touchJob(s.root, id), false, 'no owner, no session');
      assert.deepEqual(same(), before);

      claimJob(s.root, id, 'A');
      s.plant(id, (j) => (j.owner.heartbeat = OLD));
      before = same();
      assert.equal(touchJob(s.root, id, 'B'), false, 'not the owner');
      assert.deepEqual(same(), before);
      assert.equal(touchJob(s.root, id, 'A'), true);
      assert.ok(loadJob(s.root, id).owner!.heartbeat > OLD);
      s.plant(id, (j) => (j.owner.heartbeat = OLD));
      assert.equal(touchJob(s.root, id), true, 'no session refreshes the current owner');
      assert.ok(loadJob(s.root, id).owner!.heartbeat > OLD);
    } finally {
      s.cleanup();
    }
  });

  test('a live owner still refuses and --force still overrides', async () => {
    const s = scratch();
    try {
      const j = await s.newJob('j');
      await s.f('job', 'claim', j, '--session', 'A');
      const fresh = await s.raw('job', 'claim', j, '--session', 'B');
      assert.equal(fresh.status, 3);
      assert.match(fresh.stderr, /job j is being driven by session A \(last active .+\); pass --force to take over/);

      s.plant(j, (x) => (x.owner.heartbeat = minutesAgo(45)));
      await s.f('job', 'agent', j, 'start', '--role', 'builder');
      const running = await s.raw('job', 'claim', j, '--session', 'B');
      assert.equal(running.status, 3);
      assert.match(running.stderr, /session A \(an agent is still running\)/);

      assert.equal((await s.f('job', 'claim', j, '--session', 'B', '--force')).owner.session, 'B');
    } finally {
      s.cleanup();
    }
  });

  test('a job parked on dependencies has no owner', async () => {
    const s = scratch();
    try {
      await s.newJob('d');
      const q = await s.newJob('q');
      await s.f('job', 'claim', q, '--session', 'A');
      await s.f('job', 'set', q, '--field', 'dependsOn=["d"]');
      const parked = s.job(q);
      assert.equal(parked.state, 'waiting');
      assert.equal(parked.owner, null);
      assert.ok(parked.runs.at(-1).endedAt, 'the run ends');
      const t = s.types(q);
      assert.ok(t.lastIndexOf('released') > t.lastIndexOf('transition'), 'released follows the parking transition');

      // Parked by another session's refused claim.
      const r = await s.newJob('r');
      await s.f('job', 'claim', r, '--session', 'A');
      s.plant(r, (x) => (x.dependsOn = ['d']));
      assert.equal((await s.raw('job', 'claim', r, '--session', 'B')).status, 4);
      const rj = s.job(r);
      assert.equal(rj.state, 'waiting');
      assert.equal(rj.owner, null);
      assert.ok(rj.runs.at(-1).endedAt);
      const rt = s.types(r);
      assert.ok(rt.lastIndexOf('released') > rt.lastIndexOf('transition'));
    } finally {
      s.cleanup();
    }
  });

  test('a forced claim on a parked job survives sync', async () => {
    const s = scratch();
    try {
      const d = await s.newJob('d');
      const q = await s.newJob('q');
      await s.f('job', 'set', q, '--field', 'dependsOn=["d"]');
      await s.f('job', 'claim', q, '--session', 'F', '--force');
      assert.equal(s.job(q).state, 'waiting');
      await s.f('job', 'set', d, '--stage', 'build', '--state', 'running');
      await s.f('sync');
      assert.equal(s.job(q).reason, `${DEP_REASON}d (build/running)`, 'sync rewrote the reason');
      assert.equal(s.job(q).owner?.session, 'F');
      await s.f('job', 'set', d, '--state', 'done');
      await s.f('sync');
      assert.equal(s.job(q).state, 'queued');
      assert.equal(s.job(q).owner?.session, 'F', 'unparking keeps the forced owner');
    } finally {
      s.cleanup();
    }
  });

  test('split children start unowned', async () => {
    const s = scratch();
    try {
      const u = await s.newJob('u');
      const c = (await s.f('job', 'new', '--title', 'c', '--parent', u, '--session', 'S')).id;
      assert.equal(s.job(c).owner, null);
      assert.equal(s.types(c).includes('claimed'), false);
      assert.deepEqual(s.job(u).children, [c]);
      const x = (await s.f('job', 'new', '--title', 'x', '--session', 'S')).id;
      assert.equal(s.job(x).owner.session, 'S');
    } finally {
      s.cleanup();
    }
  });

  /** Job dirs under .forge/jobs, so a test can tell that nothing new was created. */
  const jobDirs = (root: string) => fs.readdirSync(path.join(root, '.forge', 'jobs')).sort();

  test('next --claim resumes a queued job before new tracker items', async () => {
    const s = scratch();
    try {
      const q = await s.newJob('q');
      await s.f('tracker', 'create', '--title', 'T item');
      const dirs = jobDirs(s.root);
      const next = await s.f('next', '--claim', '--session', 'S');
      assert.deepEqual(next, { id: q, ref: 'q', title: 'Job q', branch: `forge/${q}`, stage: 'backlog', state: 'queued', resumed: true });
      assert.equal(s.job(q).owner.session, 'S');
      assert.equal((await s.f('tracker', 'get', 't-item')).status, 'ready', 'the tracker item stays unclaimed');
      assert.deepEqual(jobDirs(s.root), dirs, 'no job was created');
    } finally {
      s.cleanup();
    }
  });

  test('next --claim skips live, blocked, handed-off, eval and umbrella jobs', async () => {
    const s = scratch();
    try {
      const blocker = await s.newJob('blocker');
      await s.f('job', 'set', blocker, '--state', 'running');
      const cases: [string, (q: string) => unknown][] = [
        ['a fresh owner', (q) => s.f('job', 'claim', q, '--session', 'A')],
        ['a running agent', async (q) => {
          await s.f('job', 'claim', q, '--session', 'A');
          s.plant(q, (j) => (j.owner.heartbeat = minutesAgo(45)));
          await s.f('job', 'agent', q, 'start', '--role', 'builder');
        }],
        ['unmet dependencies', (q) => s.plant(q, (j) => (j.dependsOn = [blocker]))],
        ['a pending resume request', (q) => s.f('requests', 'add', 'resume', '--job', q)],
        ['an in-progress resume request', async (q) => s.f('requests', 'claim', (await s.f('requests', 'add', 'resume', '--job', q)).id, '--session', 'H')],
        ['kind eval', (q) => s.plant(q, (j) => (j.kind = 'eval'))],
        ['children', (q) => s.plant(q, (j) => (j.children = ['some-child']))],
      ];
      for (const [n, [what, setup]] of cases.entries()) {
        const q = await s.newJob(`q${n}`);
        await setup(q);
        const before = s.job(q).owner?.session ?? null;
        await s.f('tracker', 'create', '--title', `T${n}`);
        const next = await s.f('next', '--claim', '--session', 'S');
        assert.equal(next.resumed, false, `${what}: not resumed`);
        assert.equal(next.ref, `t${n}`, `${what}: the tracker item starts instead`);
        assert.notEqual(next.id, q);
        assert.equal(s.job(q).owner?.session ?? null, before, `${what}: the job's owner is unchanged`);
      }
    } finally {
      s.cleanup();
    }
  });

  test('next --claim takes over a stale owner, oldest first', async () => {
    const s = scratch();
    try {
      const newer = await s.newJob('newer');
      const older = await s.newJob('older');
      for (const [q, created] of [[newer, '2026-01-02T00:00:00.000Z'], [older, '2026-01-01T00:00:00.000Z']]) {
        await s.f('job', 'claim', q, '--session', 'A');
        s.plant(q, (j) => {
          j.owner.heartbeat = minutesAgo(45);
          j.createdAt = created;
        });
      }
      const first = await s.f('next', '--claim', '--session', 'S');
      assert.equal(first.id, older);
      assert.equal(first.resumed, true);
      assert.equal(s.job(older).owner.session, 'S', 'taken over without --force');
      const second = await s.f('next', '--claim', '--session', 'S');
      assert.equal(second.id, newer, 'the job S just claimed is not picked again');
      assert.deepEqual(await s.f('next', '--claim', '--session', 'S'), { item: null });
    } finally {
      s.cleanup();
    }
  });

  test('next without a session stays tracker-only', async () => {
    const s = scratch();
    try {
      const q = await s.newJob('q');
      await s.f('tracker', 'create', '--title', 'T item');
      const before = fs.readFileSync(s.jobFile(q), 'utf8');
      assert.deepEqual(Object.keys(await s.f('next')).sort(), ['item', 'more']);
      const noClaim = await s.f('next', '--session', 'S');
      assert.equal(noClaim.item.ref, 't-item');
      assert.equal(noClaim.id, undefined);
      const claimed = await s.f('next', '--claim');
      assert.equal(claimed.ref, 't-item');
      assert.equal(claimed.resumed, undefined);
      assert.notEqual(claimed.id, q);
      assert.equal(fs.readFileSync(s.jobFile(q), 'utf8'), before, 'the queued job is untouched');
    } finally {
      s.cleanup();
    }
  });

  test('owner status agrees with what a claim would do', async () => {
    const at = Date.parse('2026-06-01T12:00:00.000Z');
    const ago = (m: number) => new Date(at - m * 60 * 1000).toISOString();
    const owner = (heartbeat: string) => ({ session: 'A', host: 'h', since: ago(90), heartbeat });
    assert.equal(ownerStatus({ owner: null, agents: {} }, at).status, 'none');
    assert.deepEqual(ownerStatus({ owner: owner(ago(5)), agents: {} }, at), { status: 'live', session: 'A', since: ago(90), heartbeat: ago(5), agentRunning: false, reason: null, jobSession: false });
    const agent = ownerStatus({ owner: owner(ago(45)), agents: { builder: { runs: 1, status: 'running', startedAt: ago(60) } } } as any, at);
    assert.deepEqual([agent.status, agent.agentRunning], ['live', true]);
    assert.equal(ownerStatus({ owner: owner(ago(45)), agents: { builder: { runs: 1, status: 'running', startedAt: ago(150) } } } as any, at).status, 'stale', 'an agent running past 2 h no longer counts');
    assert.equal(ownerStatus({ owner: owner(ago(45)), agents: {} }, at).status, 'stale');

    const repo = tempRepo();
    const root = repo.dir;
    const config = defaults();
    try {
      const cases: [string, string, string | null, (id: string) => void][] = [
        ['none', 'none', null, () => {}],
        ['live by heartbeat', 'live', null, (id) => claimJob(root, id, uuid())],
        ['live by agent', 'live', null, (id) => {
          claimJob(root, id, uuid());
          updateJob(root, id, (j) => (j.owner!.heartbeat = minutesAgo(45)));
          recordAgent(root, id, { role: 'builder', phase: 'start' }, config);
        }],
        ['stale', 'stale', null, (id) => {
          claimJob(root, id, uuid());
          updateJob(root, id, (j) => (j.owner!.heartbeat = minutesAgo(45)));
        }],
        ['not running', 'dead', 'not-running', (id) => {
          const x = uuid();
          claimJob(root, id, x);
          writeRecord(root, id, { sessionId: x, spawnSessionId: x, pid: deadPid() });
        }],
        ['moved on', 'dead', 'moved-on', (id) => {
          const x = uuid();
          claimJob(root, id, x);
          writeRecord(root, id, { sessionId: uuid(), pastSessionIds: [x], pid: null });
        }],
        ['inbox hand-off', 'dead', 'inbox-handoff', (id) => {
          const x = uuid();
          claimJob(root, id, x);
          writeRecord(root, '_inbox', { sessionId: x, spawnSessionId: x, pastSessionIds: [], pid: null });
        }],
      ];
      for (const [what, status, reason, setup] of cases) {
        fs.rmSync(daemonsDir(root), { recursive: true, force: true });
        const id = createJob(root, config, { title: what }).id;
        setup(id);
        const st = ownerStatusWithProof(root, loadJob(root, id), { env: jobSessionEnv(id) });
        assert.equal(st.status, status, what);
        assert.equal(st.reason, reason, what);
        let claimed = true;
        try {
          claimJob(root, id, uuid(), false, daemonClaimOpts(root, id, jobSessionEnv(id)));
        } catch (e: any) {
          assert.equal(e.exitCode, 3);
          claimed = false;
        }
        assert.equal(claimed, st.status !== 'live', `${what}: a claim succeeds exactly when the owner is not live`);
        assert.equal(st.jobSession, false, `${what}: not the job's own session`);
      }

      // A live owner that is the job's own running daemon session: still live (a claim by anyone else
      // is refused), but a resume reaches it, so it is marked.
      fs.rmSync(daemonsDir(root), { recursive: true, force: true });
      const own = createJob(root, config, { title: 'own session' }).id;
      const sid = uuid();
      claimJob(root, own, sid);
      writeRecord(root, own, { sessionId: sid, spawnSessionId: sid, pid: process.pid });
      const live = { env: jobSessionEnv(own), isLive: () => true };
      assert.deepEqual([ownerStatusWithProof(root, loadJob(root, own), live).status, ownerStatusWithProof(root, loadJob(root, own), live).jobSession], ['live', true]);
      assert.throws(() => claimJob(root, own, uuid(), false, { yields: () => null }), (e: any) => e.exitCode === 3);
      assert.equal(claimJob(root, own, sid, false, daemonClaimOpts(root, own, jobSessionEnv(own))).owner!.session, sid, 'the job session reclaims as itself');
      // The same session recorded under another job's scope is not this job's session.
      fs.rmSync(daemonsDir(root), { recursive: true, force: true });
      writeRecord(root, 'other-job', { sessionId: sid, spawnSessionId: sid, pid: process.pid });
      assert.equal(ownerStatusWithProof(root, loadJob(root, own), live).jobSession, false);
      assert.equal(ownerStatus(loadJob(root, own)).jobSession, false, 'the time rule never proves it');
    } finally {
      repo.cleanup();
    }
  });

  test('next --claim breaks createdAt ties by id and reports blocked items with a resume', async () => {
    const s = scratch();
    try {
      const b = await s.newJob('b-job');
      const a = await s.newJob('a-job');
      for (const q of [a, b]) s.plant(q, (j) => (j.createdAt = '2026-01-01T00:00:00.000Z'));
      // A tracker item whose job waits on dependencies shows up as blocked, next to the resume.
      await s.newJob('blocker');
      await s.f('job', 'set', 'blocker', '--state', 'running');
      const waits = await s.newJob('waits');
      await s.f('job', 'set', waits, '--field', 'dependsOn=["blocker"]');
      await s.f('tracker', 'create', '--title', 'Waits');
      const first = await s.f('next', '--claim', '--session', 'S');
      assert.equal(first.id, a, 'same createdAt: the smaller id wins');
      assert.equal(first.resumed, true);
      assert.deepEqual(first.blocked, [{ ref: 'waits', id: waits, waitingOn: ['blocker'] }]);
      assert.equal((await s.f('next', '--claim', '--session', 'S')).id, b);
    } finally {
      s.cleanup();
    }
  });

  test('next --claim resumes a job whose daemon owner has exited, though its heartbeat is fresh', async () => {
    const s = scratch();
    try {
      const q = await s.newJob('q');
      const gone = uuid();
      await s.f('job', 'claim', q, '--session', gone);
      writeRecord(s.root, q, { sessionId: gone, spawnSessionId: gone, pid: deadPid() });
      const next = await s.f('next', '--claim', '--session', 'S');
      assert.deepEqual([next.id, next.resumed], [q, true]);
      assert.equal(s.job(q).owner.session, 'S');
    } finally {
      s.cleanup();
    }
  });
});
