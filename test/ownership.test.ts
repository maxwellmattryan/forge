// Who keeps a job's lease live (only the driver's own activity), how claims take it over (an
// expired lease, or --force, each a new epoch), when it is released (parking, split children), and
// how `forge next --claim` resumes queued jobs before new items.
// Every test gets its own copy of one initialised repo, so they run side by side.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, repoTemplate, tempRepo } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import { refreshDependencyWait, DEP_REASON } from '../lib/deps.ts';
import { AGENT_LEASE_MS, LEASE_MS, claimJob, createJob, jobDir, leaseStatus, loadJob, readEvents, recordAgent, releaseJob, renewLease, setJob, updateJob } from '../lib/jobs.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const OLD = '2020-01-02T03:04:05.000Z';
const FAR = '2099-01-01T00:00:00.000Z';
const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000).toISOString();

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
  /** Edits job.json behind the CLI's back, as a hand edit, a clock jump or an older Forge would have left it. */
  const plant = (id: string, mutate: (j: any) => void) => {
    const j = job(id);
    mutate(j);
    fs.writeFileSync(jobFile(id), JSON.stringify(j, null, 2));
  };
  /** The lease as a dead driver leaves it: renewed long ago, expired since. */
  const expire = (id: string, renewedAt = minutesAgo(45)) => plant(id, (j) => Object.assign(j.lease, { renewedAt, expiresAt: minutesAgo(15) }));
  const newJob = async (ref: string) => (await f('job', 'new', '--title', `Job ${ref}`, '--ref', ref)).id as string;
  const types = (id: string) => readEvents(root, id).map((e) => e.type);
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(wtRoot, { recursive: true, force: true });
  };
  return { root, raw, f, job, jobFile, plant, expire, newJob, types, cleanup };
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

describe('leases', { concurrency: 4 }, () => {
  test("only the driver's own activity renews the lease", async () => {
    const s = scratch();
    const config = defaults();
    try {
      const id = createJob(s.root, config, { title: 'Owned' }).id;
      claimJob(s.root, id, 'A');
      s.plant(id, (j) => Object.assign(j.lease, { renewedAt: OLD, expiresAt: FAR }));
      const unchanged = (what: string) => assert.equal(loadJob(s.root, id).lease.renewedAt, OLD, `${what} leaves the lease alone`);

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

      // A parked job that still has a driver: a reason rewrite and the unpark keep the lease.
      const dep = createJob(s.root, config, { title: 'Dep' }).id;
      s.plant(id, (j) => Object.assign(j, { state: 'waiting', waitingOn: 'external', reason: `${DEP_REASON}old text`, dependsOn: [dep] }));
      refreshDependencyWait(s.root, id);
      assert.equal(loadJob(s.root, id).reason, `${DEP_REASON}${dep} (backlog/queued)`);
      unchanged('a park-rewrite');
      setJob(s.root, dep, { state: 'done' });
      assert.equal(refreshDependencyWait(s.root, id).released, true);
      assert.equal(loadJob(s.root, id).state, 'queued');
      assert.equal(loadJob(s.root, id).lease.driver, 'A', 'unparking keeps the driver');
      unchanged('an unpark');

      assert.equal(renewLease(s.root, id, { session: 'A' }), true);
      assert.ok(loadJob(s.root, id).lease.renewedAt! > OLD, 'renewLease by the driver renews');
      s.plant(id, (j) => (j.lease.renewedAt = OLD));
      claimJob(s.root, id, 'A');
      assert.ok(loadJob(s.root, id).lease.renewedAt! > OLD, 'claimJob renews');
    } finally {
      s.cleanup();
    }
  });

  test('a sync that unblocks a parked job does not renew an expired lease', async () => {
    const s = scratch();
    try {
      const d = await s.newJob('d');
      const j = await s.newJob('j');
      await s.f('job', 'set', j, '--field', 'dependsOn=["d"]');
      assert.equal(s.job(j).state, 'waiting');
      const stale = minutesAgo(45);
      // A job parked by hand, or by an older Forge, can keep its driver.
      s.plant(j, (x) => (x.lease = { driver: 'A', epoch: 1, since: stale, renewedAt: stale, expiresAt: minutesAgo(15) }));
      await s.f('job', 'set', d, '--state', 'done');
      const sync = await s.f('sync');
      assert.deepEqual(sync.results.find((r: any) => r.id === j), { id: j, unblocked: true });
      assert.equal(s.job(j).state, 'queued');
      assert.equal(s.job(j).lease.renewedAt, stale, 'sync left the lease alone');
      assert.equal((await s.f('job', 'claim', j, '--session', 'B')).lease.driver, 'B', 'the expired lease is taken without --force');
    } finally {
      s.cleanup();
    }
  });

  test("foreign writes never keep someone else's lease alive", async () => {
    const s = scratch();
    try {
      const j = await s.newJob('j');
      await s.f('job', 'claim', j, '--session', 'A');
      const stale = minutesAgo(45);
      s.expire(j, stale);
      await s.f('job', 'set', j, '--note', 'x');
      await s.f('job', 'set', j, '--field', 'kind=bug');
      await s.f('requests', 'add', 'approve', '--job', j);
      await s.f('job', 'step', j, '--session', 'B');
      assert.equal(s.job(j).lease.renewedAt, stale);
      assert.equal((await s.f('job', 'claim', j, '--session', 'B')).lease.driver, 'B');
    } finally {
      s.cleanup();
    }
  });

  test('job step --session renews only its own lease', async () => {
    const s = scratch();
    try {
      const j = await s.newJob('j');
      await s.f('job', 'claim', j, '--session', 'A');
      s.plant(j, (x) => (x.lease.renewedAt = OLD));
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
      assert.ok(s.job(j).lease.renewedAt > OLD, "the driver's step renews its lease");
    } finally {
      s.cleanup();
    }
  });

  test('renewLease renews only the named driver, and a session-less renewal never revives an expired lease', async () => {
    const s = scratch();
    try {
      const id = createJob(s.root, defaults(), { title: 'Renew' }).id;
      const file = s.jobFile(id);
      const same = () => ({ bytes: fs.readFileSync(file, 'utf8'), mtime: fs.statSync(file).mtimeMs });
      let before = same();
      assert.equal(renewLease(s.root, id, { session: 'A' }), false, 'no driver');
      assert.equal(renewLease(s.root, id), false, 'no driver, no session');
      assert.deepEqual(same(), before);

      claimJob(s.root, id, 'A');
      s.plant(id, (j) => (j.lease.renewedAt = OLD));
      before = same();
      assert.equal(renewLease(s.root, id, { session: 'B' }), false, 'not the driver');
      assert.deepEqual(same(), before);
      assert.equal(renewLease(s.root, id, { session: 'A' }), true);
      assert.ok(loadJob(s.root, id).lease.renewedAt! > OLD);
      s.plant(id, (j) => (j.lease.renewedAt = OLD));
      assert.equal(renewLease(s.root, id), true, 'no session renews a live lease');
      assert.ok(loadJob(s.root, id).lease.renewedAt! > OLD);

      // Expired: an orphan agent's worktree command can't bring a dead driver back; the driver itself can.
      s.expire(id);
      before = same();
      assert.equal(renewLease(s.root, id), false, 'session-less renewal of an expired lease');
      assert.deepEqual(same(), before);
      assert.equal(leaseStatus(loadJob(s.root, id)).status, 'expired');
      const epoch = loadJob(s.root, id).lease.epoch;
      assert.equal(renewLease(s.root, id, { session: 'A' }), true, 'its own driver may renew while nobody took over');
      assert.equal(leaseStatus(loadJob(s.root, id)).status, 'live');
      assert.equal(loadJob(s.root, id).lease.epoch, epoch, 'a renewal keeps the epoch');
    } finally {
      s.cleanup();
    }
  });

  test('claims: a live lease refuses, an expired one is taken over, --force and a new driver bump the epoch', async () => {
    const s = scratch();
    try {
      const j = await s.newJob('j');
      const a = await s.f('job', 'claim', j, '--session', 'A');
      assert.equal(a.epoch, 1);
      assert.equal(a.lease.driver, 'A');
      assert.ok(Date.parse(a.lease.expiresAt) >= Date.now() + LEASE_MS - 60_000, 'a claim gives 30 minutes');

      const fresh = await s.raw('job', 'claim', j, '--session', 'B', '--json');
      assert.equal(fresh.status, 3);
      assert.equal(JSON.parse(fresh.stdout).error.code, 'owned');
      assert.match(JSON.parse(fresh.stdout).error.message, /job j is being driven by session A \(lease renewed .+, expires .+\); pass --force to take over/);

      const since = s.job(j).lease.since;
      const again = await s.f('job', 'claim', j, '--session', 'A');
      assert.deepEqual([again.epoch, again.lease.since], [1, since], 'a re-claim by the same driver keeps epoch and since');

      s.expire(j);
      const b = await s.f('job', 'claim', j, '--session', 'B');
      assert.deepEqual([b.lease.driver, b.epoch], ['B', 2], 'an expired lease is taken without --force, at the next epoch');
      const events = readEvents(s.root, j);
      assert.ok(events.some((e) => e.type === 'note' && e.text === 'took over from session A (lease expired)'));
      assert.equal(events.findLast((e) => e.type === 'claimed')?.epoch, 2, 'the claimed event records the epoch');

      const c = await s.f('job', 'claim', j, '--session', 'C', '--force');
      assert.deepEqual([c.lease.driver, c.epoch], ['C', 3], '--force bumps the epoch');
      assert.ok(readEvents(s.root, j).some((e) => e.type === 'note' && e.text === 'took over from session B (forced)'));

      // agent start keeps the lease for the longest agent run.
      await s.f('job', 'agent', j, 'start', '--role', 'builder');
      assert.ok(Date.parse(s.job(j).lease.expiresAt) >= Date.now() + AGENT_LEASE_MS - 60_000, 'agent start extends to 2 h');
      const running = await s.raw('job', 'claim', j, '--session', 'D');
      assert.equal(running.status, 3, 'a long agent keeps its driver');
    } finally {
      s.cleanup();
    }
  });

  test('a job parked on dependencies has no driver, and keeps its epoch', async () => {
    const s = scratch();
    try {
      await s.newJob('d');
      const q = await s.newJob('q');
      await s.f('job', 'claim', q, '--session', 'A');
      await s.f('job', 'set', q, '--field', 'dependsOn=["d"]');
      const parked = s.job(q);
      assert.equal(parked.state, 'waiting');
      assert.equal(parked.lease.driver, null);
      assert.equal(parked.lease.expiresAt, null);
      assert.equal(parked.lease.epoch, 1, 'release keeps the epoch');
      assert.equal(parked.owner, undefined, 'job.json has no owner');
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
      assert.equal(rj.lease.driver, null);
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
      assert.equal(s.job(q).lease.driver, 'F');
      await s.f('job', 'set', d, '--state', 'done');
      await s.f('sync');
      assert.equal(s.job(q).state, 'queued');
      assert.equal(s.job(q).lease.driver, 'F', 'unparking keeps the forced driver');
    } finally {
      s.cleanup();
    }
  });

  test('split children start with no driver', async () => {
    const s = scratch();
    try {
      const u = await s.newJob('u');
      const c = (await s.f('job', 'new', '--title', 'c', '--parent', u, '--session', 'S')).id;
      assert.deepEqual(s.job(c).lease, { driver: null, epoch: 0, since: null, renewedAt: null, expiresAt: null });
      assert.equal(s.types(c).includes('claimed'), false);
      assert.deepEqual(s.job(u).children, [c]);
      const x = (await s.f('job', 'new', '--title', 'x', '--session', 'S')).id;
      assert.deepEqual([s.job(x).lease.driver, s.job(x).lease.epoch], ['S', 1]);
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
      assert.equal(s.job(q).lease.driver, 'S');
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
        ['a live lease', (q) => s.f('job', 'claim', q, '--session', 'A')],
        ['a running agent', async (q) => {
          await s.f('job', 'claim', q, '--session', 'A');
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
        const before = s.job(q).lease.driver;
        await s.f('tracker', 'create', '--title', `T${n}`);
        const next = await s.f('next', '--claim', '--session', 'S');
        assert.equal(next.resumed, false, `${what}: not resumed`);
        assert.equal(next.ref, `t${n}`, `${what}: the tracker item starts instead`);
        assert.notEqual(next.id, q);
        assert.equal(s.job(q).lease.driver, before, `${what}: the job's driver is unchanged`);
      }
    } finally {
      s.cleanup();
    }
  });

  test('next --claim takes over an expired lease, oldest first', async () => {
    const s = scratch();
    try {
      const newer = await s.newJob('newer');
      const older = await s.newJob('older');
      for (const [q, created] of [[newer, '2026-01-02T00:00:00.000Z'], [older, '2026-01-01T00:00:00.000Z']]) {
        await s.f('job', 'claim', q, '--session', 'A');
        s.expire(q);
        s.plant(q, (j) => (j.createdAt = created));
      }
      const first = await s.f('next', '--claim', '--session', 'S');
      assert.equal(first.id, older);
      assert.equal(first.resumed, true);
      assert.deepEqual([s.job(older).lease.driver, s.job(older).lease.epoch], ['S', 2], 'taken over without --force, at the next epoch');
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

  test('lease status agrees with what a claim would do', async () => {
    const at = Date.parse('2026-06-01T12:00:00.000Z');
    const iso = (m: number) => new Date(at + m * 60 * 1000).toISOString();
    const lease = (expiresAt: string | null) => ({ driver: 'A', epoch: 1, since: iso(-90), renewedAt: iso(-5), expiresAt });
    assert.deepEqual(leaseStatus({ lease: { driver: null, epoch: 3, since: null, renewedAt: null, expiresAt: null } }, at), { status: 'none', session: null, since: null, renewedAt: null, expiresAt: null, epoch: 3, jobSession: false });
    assert.deepEqual(leaseStatus({ lease: lease(iso(25)) }, at), { status: 'live', session: 'A', since: iso(-90), renewedAt: iso(-5), expiresAt: iso(25), epoch: 1, jobSession: false });
    assert.equal(leaseStatus({ lease: lease(iso(0)) }, at).status, 'expired', 'expiry at now is expired');
    assert.equal(leaseStatus({ lease: lease(null) }, at).status, 'expired', 'no expiry reads as expired, never live');

    const repo = tempRepo();
    const root = repo.dir;
    const config = defaults();
    try {
      const cases: [string, string, (id: string) => void][] = [
        ['none', 'none', () => {}],
        ['live by claim', 'live', (id) => claimJob(root, id, 'A')],
        ['live by agent', 'live', (id) => {
          claimJob(root, id, 'A');
          renewLease(root, id, { ttl: AGENT_LEASE_MS });
          updateJob(root, id, (j) => (j.lease.renewedAt = minutesAgo(45)));
        }],
        ['expired', 'expired', (id) => {
          claimJob(root, id, 'A');
          updateJob(root, id, (j) => (j.lease.expiresAt = minutesAgo(1)));
        }],
        ['released', 'none', (id) => {
          claimJob(root, id, 'A');
          releaseJob(root, id);
        }],
      ];
      for (const [what, status, setup] of cases) {
        const id = createJob(root, config, { title: what }).id;
        setup(id);
        const st = leaseStatus(loadJob(root, id));
        assert.equal(st.status, status, what);
        let claimed = true;
        try {
          claimJob(root, id, 'B');
        } catch (e: any) {
          assert.deepEqual([e.exitCode, e.code], [3, 'owned']);
          claimed = false;
        }
        assert.equal(claimed, st.status !== 'live', `${what}: a claim succeeds exactly when the lease is not live`);
        assert.equal(st.jobSession, false, `${what}: only the server sets jobSession`);
      }
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
});
