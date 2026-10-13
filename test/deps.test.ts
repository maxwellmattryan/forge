import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

/** A scratch repo with a local tracker, PRs off and worktrees in `<repo>.wt`. */
function scratch() {
  const repo = tempRepo();
  const wtRoot = `${repo.dir}.wt`;
  const raw = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: repo.dir } });
  const f = (...args) => {
    const r = raw(...args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return r.stdout.trim();
    }
  };
  const answers = path.join(repo.dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false }, worktrees: { root: `../${path.basename(repo.dir)}.wt` } }));
  f('init', 'write', '--answers', answers);
  const jobFile = (id) => path.join(repo.dir, '.forge', 'jobs', id, 'job.json');
  const job = (id) => JSON.parse(fs.readFileSync(jobFile(id), 'utf8'));
  const newJob = (ref) => f('job', 'new', '--title', `Job ${ref}`, '--ref', ref).id;
  const commitIn = (cwd, file, msg) => {
    fs.writeFileSync(path.join(cwd, file), msg);
    execFileSync('git', ['add', '-A'], { cwd });
    execFileSync('git', ['commit', '-qm', msg], { cwd });
  };
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(wtRoot, { recursive: true, force: true });
  };
  return { repo, wtRoot, raw, f, job, jobFile, newJob, commitIn, cleanup };
}

test('dependsOn validation rejects bad values without writing (AC3)', () => {
  const s = scratch();
  try {
    const a = s.newJob('a');
    const b = s.newJob('b');
    const c = s.newJob('c');
    const rejects = (id, value, pattern) => {
      const before = fs.readFileSync(s.jobFile(id), 'utf8');
      const r = s.raw('job', 'set', id, '--field', `dependsOn=${value}`);
      assert.notEqual(r.status, 0, `dependsOn=${value} on ${id} should fail`);
      assert.match(r.stderr, pattern);
      assert.equal(fs.readFileSync(s.jobFile(id), 'utf8'), before, 'job.json is unchanged');
    };
    rejects(a, '["nope"]', /unknown job id\(s\) in dependsOn: nope/);
    rejects(a, '["a"]', /cannot depend on itself/);
    rejects(a, '5', /must be a JSON array/);
    rejects(a, 'b', /must be a JSON array/);
    rejects(a, '[1]', /must be a JSON array/);

    s.f('job', 'set', b, '--field', 'dependsOn=["a"]');
    rejects(a, '["b"]', /cycle: a → b → a/);
    s.f('job', 'set', c, '--field', 'dependsOn=["b"]');
    rejects(a, '["c"]', /cycle: a → c → b → a/);

    s.f('job', 'set', b, '--field', 'dependsOn=[]');
    assert.deepEqual(s.job(b).dependsOn, []);
    s.f('job', 'set', a, '--field', 'dependsOn=["b","b"]');
    assert.deepEqual(s.job(a).dependsOn, ['b'], 'duplicates collapse');
  } finally {
    s.cleanup();
  }
});

test('unmet dependencies park a queued job and refuse its claim until done (AC4–AC6)', () => {
  const s = scratch();
  try {
    const a = s.newJob('a');
    const b = s.newJob('b');
    const set = s.f('job', 'set', b, '--field', 'dependsOn=["a"]');
    assert.equal(set.state, 'waiting');
    assert.equal(set.waitingOn, 'external');
    assert.equal(s.job(b).reason, 'dependencies not done: a (backlog/queued)');

    const refused = s.raw('job', 'claim', b, '--session', 's1');
    assert.equal(refused.status, 4);
    assert.match(refused.stderr, /job b waits on dependencies not done: a \(backlog\/queued\); pass --force/);
    assert.equal(s.job(b).owner, null);

    s.f('job', 'set', a, '--stage', 'build', '--state', 'running');
    s.raw('job', 'claim', b, '--session', 's1');
    assert.equal(s.job(b).reason, 'dependencies not done: a (build/running)', 'a refused claim rewrites the reason');

    s.f('job', 'set', a, '--state', 'done');
    const claimed = s.f('job', 'claim', b, '--session', 's1');
    assert.equal(claimed.owner.session, 's1');
    assert.equal(claimed.dependenciesOverridden, undefined);
    assert.equal(s.job(b).state, 'queued');
    assert.equal(s.job(b).waitingOn, null);
    assert.equal(s.job(b).reason, null);

    // AC5: --force claims anyway and records what it overrode.
    const c = s.newJob('c');
    const d = s.newJob('d');
    s.f('job', 'set', d, '--field', 'dependsOn=["c"]');
    const forced = s.f('job', 'claim', d, '--session', 's1', '--force');
    assert.deepEqual(forced.dependenciesOverridden, ['c']);
    assert.equal(s.job(d).owner.session, 's1');

    // A cancelled dependency blocks too.
    s.f('job', 'set', c, '--state', 'cancelled');
    const e = s.newJob('e');
    s.f('job', 'set', e, '--field', 'dependsOn=["c"]');
    assert.equal(s.raw('job', 'claim', e, '--session', 's1').status, 4);
    assert.match(s.job(e).reason, /c \(backlog\/cancelled\)/);

    // AC6: another wait is never overwritten by parking.
    const g = s.newJob('g');
    s.newJob('h');
    s.f('job', 'set', g, '--stage', 'spec', '--state', 'waiting', '--waiting-on', 'spec-approval', '--reason', 'spec ready');
    s.f('job', 'set', g, '--field', 'dependsOn=["h"]');
    const gj = s.job(g);
    assert.deepEqual([gj.stage, gj.state, gj.waitingOn, gj.reason], ['spec', 'waiting', 'spec-approval', 'spec ready']);
  } finally {
    s.cleanup();
  }
});

test('forge next skips items whose job waits on dependencies (AC7)', () => {
  const s = scratch();
  try {
    s.newJob('blocker');
    // The job exists before its tracker item, so mirroring does not mark the item claimed:
    // the same situation as a tracker that keeps the item ready.
    const first = s.newJob('first-item');
    s.f('job', 'set', first, '--field', 'dependsOn=["blocker"]');
    s.f('tracker', 'create', '--title', 'First item');
    s.f('tracker', 'create', '--title', 'Second item');
    const before = fs.readFileSync(s.jobFile(first), 'utf8');

    const next = s.f('next');
    assert.equal(next.item.ref, 'second-item');
    assert.equal(next.more, 0);
    assert.deepEqual(next.blocked, [{ ref: 'first-item', id: 'first-item', waitingOn: ['blocker'] }]);

    const forced = s.f('next', '--force');
    assert.equal(forced.item.ref, 'first-item');
    assert.equal(forced.more, 1);
    assert.equal(forced.blocked, undefined);
    assert.equal(fs.readFileSync(s.jobFile(first), 'utf8'), before, 'forge next never changes job state');

    s.f('tracker', 'close', 'second-item');
    assert.deepEqual(s.f('next'), { item: null, blocked: [{ ref: 'first-item', id: 'first-item', waitingOn: ['blocker'] }] });
  } finally {
    s.cleanup();
  }
});

test('worktree create stacks on one unmerged dependency; sync retargets after it merges (AC8, AC9)', () => {
  const s = scratch();
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    const a = s.newJob('a');
    const b = s.newJob('b');
    s.f('job', 'set', b, '--field', 'dependsOn=["a"]');

    const noBranch = s.raw('worktree', 'create', b);
    assert.notEqual(noBranch.status, 0);
    assert.match(noBranch.stderr, /dependency a has no branch yet \(forge\/a\); create its worktree first/);
    assert.equal(fs.existsSync(path.join(s.wtRoot, b)), false);

    const wa = s.f('worktree', 'create', a);
    assert.equal(wa.stackedOn, undefined);
    s.commitIn(wa.path, 'a.txt', 'work on a');

    const wb = s.f('worktree', 'create', b);
    assert.equal(wb.stackedOn, 'a');
    assert.equal(wb.base, 'forge/a');
    assert.equal(s.job(b).base, 'forge/a');
    assert.match(git(wb.path, 'log', '--format=%s'), /work on a/, "a's commit is in b's history");

    // Two unmerged dependencies: refused before anything is created.
    const c = s.newJob('c');
    const wc = s.f('worktree', 'create', c);
    s.commitIn(wc.path, 'c.txt', 'work on c');
    const d = s.newJob('d');
    s.f('job', 'set', d, '--field', 'dependsOn=["a","c"]');
    const two = s.raw('worktree', 'create', d);
    assert.notEqual(two.status, 0);
    assert.match(two.stderr, /job d depends on more than one unmerged job \(a, c\); wait until at most one is unmerged/);
    assert.equal(fs.existsSync(path.join(s.wtRoot, d)), false);
    assert.equal(s.job(d).worktree, null);
    assert.equal(s.job(d).base, 'main');

    // A parked job is released by sync once its dependency is done.
    const p = s.newJob('p');
    const q = s.newJob('q');
    s.f('job', 'set', p, '--field', 'dependsOn=["q"]');
    assert.equal(s.job(p).state, 'waiting');
    s.f('job', 'set', q, '--state', 'done');

    git(s.repo.dir, 'merge', '-q', '--no-edit', 'forge/a');

    // Merged dependency: a new dependent starts from main.
    const e = s.newJob('e');
    s.f('job', 'set', e, '--field', 'dependsOn=["a"]');
    const we = s.f('worktree', 'create', e);
    assert.equal(we.stackedOn, undefined);
    assert.equal(s.job(e).base, 'main');
    assert.equal(git(we.path, 'rev-parse', 'HEAD'), git(s.repo.dir, 'rev-parse', 'main'));

    const sync = s.f('sync');
    assert.deepEqual(sync.results.find((r) => r.id === b), { id: b, retargeted: { from: 'forge/a', to: 'main', dependency: 'a' } });
    assert.equal(s.job(b).base, 'main');
    assert.deepEqual(sync.results.find((r) => r.id === p), { id: p, unblocked: true });
    assert.equal(s.job(p).state, 'queued');
    assert.equal(s.job(p).waitingOn, null);
    assert.equal(sync.results.some((r) => r.id === c || r.id === e), false);

    const again = s.f('sync');
    assert.equal(again.results.some((r) => r.retargeted || r.unblocked), false, 'a second sync has nothing to do');
  } finally {
    s.cleanup();
  }
});
