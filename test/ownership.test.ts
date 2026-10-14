// Who keeps a job's claim alive (only the owner's own activity), when idle claims are released
// (parking, split children), and how `forge next --claim` resumes queued jobs before new items.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import { refreshDependencyWait, DEP_REASON } from '../lib/deps.ts';
import { claimJob, createJob, jobDir, loadJob, readEvents, recordAgent, releaseJob, setJob, touchJob, updateJob } from '../lib/jobs.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const OLD = '2020-01-02T03:04:05.000Z';
const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000).toISOString();

/** A scratch repo with a local tracker, PRs off and worktrees in `<repo>.wt`. */
function scratch() {
  const repo = tempRepo();
  const root = repo.dir;
  const wtRoot = `${root}.wt`;
  const raw = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: root } });
  const f = (...args: string[]) => {
    const r = raw(...args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return r.stdout.trim();
    }
  };
  const answers = path.join(root, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false }, worktrees: { root: `../${path.basename(root)}.wt` } }));
  f('init', 'write', '--answers', answers);
  const jobFile = (id: string) => path.join(jobDir(root, id), 'job.json');
  const job = (id: string) => JSON.parse(fs.readFileSync(jobFile(id), 'utf8'));
  /** Edits job.json behind the CLI's back, as a hand edit or an older Forge would have left it. */
  const plant = (id: string, mutate: (j: any) => void) => {
    const j = job(id);
    mutate(j);
    fs.writeFileSync(jobFile(id), JSON.stringify(j, null, 2));
  };
  const newJob = (ref: string) => f('job', 'new', '--title', `Job ${ref}`, '--ref', ref).id as string;
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

test("only the owner's own activity refreshes the heartbeat", () => {
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

test('a sync that unblocks a parked job does not refresh a stale owner', () => {
  const s = scratch();
  try {
    const d = s.newJob('d');
    const j = s.newJob('j');
    s.f('job', 'set', j, '--field', 'dependsOn=["d"]');
    assert.equal(s.job(j).state, 'waiting');
    const stale = minutesAgo(45);
    // Jobs parked before this change kept their owner.
    s.plant(j, (x) => (x.owner = { session: 'A', host: 'h', since: stale, heartbeat: stale }));
    s.f('job', 'set', d, '--state', 'done');
    const sync = s.f('sync');
    assert.deepEqual(sync.results.find((r: any) => r.id === j), { id: j, unblocked: true });
    assert.equal(s.job(j).state, 'queued');
    assert.equal(s.job(j).owner.heartbeat, stale, 'sync left the heartbeat alone');
    assert.equal(s.f('job', 'claim', j, '--session', 'B').owner.session, 'B', 'the stale owner yields without --force');
  } finally {
    s.cleanup();
  }
});

test("foreign writes never keep someone else's claim alive", () => {
  const s = scratch();
  try {
    const j = s.newJob('j');
    s.f('job', 'claim', j, '--session', 'A');
    const stale = minutesAgo(45);
    s.plant(j, (x) => (x.owner.heartbeat = stale));
    s.f('job', 'set', j, '--note', 'x');
    s.f('job', 'set', j, '--field', 'kind=bug');
    s.f('requests', 'add', 'approve', '--job', j);
    s.f('job', 'step', j, '--session', 'B');
    assert.equal(s.job(j).owner.heartbeat, stale);
    assert.equal(s.f('job', 'claim', j, '--session', 'B').owner.session, 'B');
  } finally {
    s.cleanup();
  }
});

test('job step --session refreshes only its own claim', () => {
  const s = scratch();
  try {
    const j = s.newJob('j');
    s.f('job', 'claim', j, '--session', 'A');
    s.plant(j, (x) => (x.owner.heartbeat = OLD));
    const dir = jobDir(s.root, j);
    const before = snapshot(dir);
    const plain = s.raw('job', 'step', j);
    assert.equal(plain.status, 0);
    assert.deepEqual(snapshot(dir), before, 'no --session: read-only');
    const other = s.raw('job', 'step', j, '--session', 'B');
    assert.equal(other.stdout, plain.stdout);
    assert.deepEqual(snapshot(dir), before, 'another session: read-only');
    const own = s.raw('job', 'step', j, '--session', 'A');
    assert.equal(own.status, 0);
    assert.equal(own.stdout, plain.stdout, 'the output is the same JSON');
    assert.ok(s.job(j).owner.heartbeat > OLD, "the owner's step is its heartbeat");
  } finally {
    s.cleanup();
  }
});

test('touchJob refreshes only the named owner', () => {
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

test('a live owner still refuses and --force still overrides', () => {
  const s = scratch();
  try {
    const j = s.newJob('j');
    s.f('job', 'claim', j, '--session', 'A');
    const fresh = s.raw('job', 'claim', j, '--session', 'B');
    assert.equal(fresh.status, 3);
    assert.match(fresh.stderr, /job j is being driven by session A \(last active .+\); pass --force to take over/);

    s.plant(j, (x) => (x.owner.heartbeat = minutesAgo(45)));
    s.f('job', 'agent', j, 'start', '--role', 'builder');
    const running = s.raw('job', 'claim', j, '--session', 'B');
    assert.equal(running.status, 3);
    assert.match(running.stderr, /session A \(an agent is still running\)/);

    assert.equal(s.f('job', 'claim', j, '--session', 'B', '--force').owner.session, 'B');
  } finally {
    s.cleanup();
  }
});

test('a job parked on dependencies has no owner', () => {
  const s = scratch();
  try {
    s.newJob('d');
    const q = s.newJob('q');
    s.f('job', 'claim', q, '--session', 'A');
    s.f('job', 'set', q, '--field', 'dependsOn=["d"]');
    const parked = s.job(q);
    assert.equal(parked.state, 'waiting');
    assert.equal(parked.owner, null);
    assert.ok(parked.runs.at(-1).endedAt, 'the run ends');
    const t = s.types(q);
    assert.ok(t.lastIndexOf('released') > t.lastIndexOf('transition'), 'released follows the parking transition');

    // Parked by another session's refused claim.
    const r = s.newJob('r');
    s.f('job', 'claim', r, '--session', 'A');
    s.plant(r, (x) => (x.dependsOn = ['d']));
    assert.equal(s.raw('job', 'claim', r, '--session', 'B').status, 4);
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

test('a forced claim on a parked job survives sync', () => {
  const s = scratch();
  try {
    const d = s.newJob('d');
    const q = s.newJob('q');
    s.f('job', 'set', q, '--field', 'dependsOn=["d"]');
    s.f('job', 'claim', q, '--session', 'F', '--force');
    assert.equal(s.job(q).state, 'waiting');
    s.f('job', 'set', d, '--stage', 'build', '--state', 'running');
    s.f('sync');
    assert.equal(s.job(q).reason, `${DEP_REASON}d (build/running)`, 'sync rewrote the reason');
    assert.equal(s.job(q).owner?.session, 'F');
    s.f('job', 'set', d, '--state', 'done');
    s.f('sync');
    assert.equal(s.job(q).state, 'queued');
    assert.equal(s.job(q).owner?.session, 'F', 'unparking keeps the forced owner');
  } finally {
    s.cleanup();
  }
});

test('split children start unowned', () => {
  const s = scratch();
  try {
    const u = s.newJob('u');
    const c = s.f('job', 'new', '--title', 'c', '--parent', u, '--session', 'S').id;
    assert.equal(s.job(c).owner, null);
    assert.equal(s.types(c).includes('claimed'), false);
    assert.deepEqual(s.job(u).children, [c]);
    const x = s.f('job', 'new', '--title', 'x', '--session', 'S').id;
    assert.equal(s.job(x).owner.session, 'S');
  } finally {
    s.cleanup();
  }
});
