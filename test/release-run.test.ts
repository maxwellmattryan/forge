// forge release plan|run|status through the CLI (issue #190), in the two-repo fixture whose origins
// are local bare repos. The release tools are sh stubs in a temp bin/ that log their argv and never
// reach a registry; nothing here pushes anywhere but the fixture's bare repos.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TRUST_ENV, trustDigest } from '../lib/core/config/load.ts';
import { loadJob } from '../lib/core/job/store.ts';
import { type TwoRepo, dependsOn, twoRepo } from './job-repos-fixture.ts';

const posix = process.platform === 'win32' ? 'the stubs are sh scripts and forge release run refuses native Windows' : false;

// Publishes by touching published-<dir>, which `view` then reports; fail-<dir> makes publish exit 1.
const NPM = `#!/bin/sh
d="$STUB_DIR"
name=$(basename "$PWD")
echo "npm $* @$name" >> "$d/argv.log"
case "$1" in
  publish) if [ -f "$d/fail-$name" ]; then echo "publish failed" >&2; exit 1; fi; : > "$d/published-$name"; echo "published $name" ;;
  view) spec="$2"; n="\${spec%@*}"; v="\${spec##*@}"; if [ -f "$d/published-$n" ]; then echo "$v"; else echo "404" >&2; exit 1; fi ;;
esac
`;
const TAG = 'echo "tag $(basename "$PWD")" >> "$STUB_DIR/argv.log" && git tag v1.0.0 && git push -q origin v1.0.0';

interface Release extends TwoRepo {
  env: NodeJS.ProcessEnv;
  stubs: string;
  argv: () => string[];
  run: (args: string[], env?: NodeJS.ProcessEnv) => Promise<{ status: number | null; stdout: string; stderr: string; json: any }>;
  /** Edits config, then commits and pushes the root so its preflight passes. */
  setup: (edit: (c: any) => void) => void;
  dir: string;
}

const json = (s: string): any => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

async function project(cleanups: (() => void)[]): Promise<Release> {
  const p = await twoRepo();
  cleanups.push(p.cleanup);
  const stubs = path.join(p.parent, 'stubs');
  fs.mkdirSync(path.join(stubs, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(stubs, 'bin', 'npm'), NPM, { mode: 0o755 });
  fs.writeFileSync(path.join(stubs, 'argv.log'), '');
  dependsOn(p, 'app-on-lib');
  p.commit(p.lib, { 'package.json': JSON.stringify({ name: 'lib', version: '1.0.0' }) }, 'lib package');
  p.git(p.lib, 'push', '-q', 'origin', 'main');
  const env = { PATH: `${path.join(stubs, 'bin')}${path.delimiter}${process.env.PATH}`, STUB_DIR: stubs };
  const setup = (edit: (c: any) => void) => {
    p.config(edit);
    p.commit(p.root, { 'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }) }, 'release config');
    p.git(p.root, 'push', '-q', 'origin', 'main');
  };
  return {
    ...p,
    env,
    stubs,
    setup,
    dir: path.join(p.root, '.forge', 'runtime', 'release'),
    argv: () => fs.readFileSync(path.join(stubs, 'argv.log'), 'utf8').split('\n').filter(Boolean),
    run: async (args, extra = {}) => {
      const r = await p.raw(['release', ...args], { ...env, ...extra });
      return { ...r, json: json(r.stdout) };
    },
  };
}

/** Both repos on `tag` + npm, publish allowed: a run needs no terminal. */
const allowBoth = (c: any) => {
  c.release = { ...c.release, mechanism: 'tag', command: TAG, registry: 'npm', publish: 'allow' };
  c.repos[0].release = { mechanism: 'tag', command: TAG, registry: 'npm', publish: 'allow' };
};

const steps = (p: Release) => JSON.parse(fs.readFileSync(path.join(p.dir, 'release.json'), 'utf8'));
const state = (p: Release) => JSON.parse(fs.readFileSync(path.join(p.dir, 'state.json'), 'utf8'));

describe('forge release', { concurrency: 4 }, () => {
  const cleanups: (() => void)[] = [];
  process.on('exit', () => cleanups.forEach((c) => c()));

  // The order is release-plan.test.ts's ("a two-repo plan orders the library first"); the order the
  // steps run in is "a failure mid-run resumes".
  test('plan writes release.md and release.json', async () => {
    const p = await project(cleanups);
    p.setup(allowBoth);
    const r = await p.run(['plan']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.plan, path.join(p.dir, 'release.md'));
    assert.equal(r.json.steps, path.join(p.dir, 'release.json'));
    assert.equal(r.json.total, 6);
    assert.match(r.json.hash, /^[0-9a-f]{12}$/);
    assert.deepEqual(r.json.skipped, []);
    const plan = steps(p);
    assert.equal(plan.version, 1);
    assert.deepEqual(plan.repos.find((x: any) => x.repo === 'lib').steps.map((s: any) => s.id), ['lib/preflight', 'lib/release', 'lib/publish']);
    assert.ok(fs.readFileSync(r.json.plan, 'utf8').startsWith('# Release plan\n'));
    assert.equal(p.argv().length, 0, 'planning runs nothing');
    assert.equal(fs.existsSync(path.join(p.dir, 'state.json')), false);
  });

  test('selection by --job and --since', async () => {
    const p = await project(cleanups);
    p.setup((c) => {
      c.release = { ...c.release, mechanism: 'tag', command: TAG };
      c.repos[0].release = { interim: 'local' };
    });
    // Neither flag: every repo; lib has no mechanism.
    const all = await p.run(['plan']);
    assert.equal(all.status, 0, all.stderr);
    assert.deepEqual(all.json.skipped, [{ repo: 'lib', reason: 'no release.mechanism' }]);
    assert.deepEqual(all.json.order, ['(root)']);
    // --since: lib has no tag; the root has one with a commit after it, then none after.
    p.git(p.root, 'tag', 'v0');
    const none = await p.run(['plan', '--since', 'v0']);
    assert.equal(none.status, 0, none.stderr);
    assert.deepEqual(none.json.skipped, [
      { repo: '(root)', reason: 'no commits since v0' },
      { repo: 'lib', reason: 'no tag v0' },
    ]);
    p.commit(p.root, { 'more.txt': 'x\n' });
    const since = await p.run(['plan', '--since', 'v0']);
    assert.deepEqual(since.json.order, ['(root)']);
    assert.deepEqual(since.json.skipped, [{ repo: 'lib', reason: 'no tag v0' }]);
    const missing = await p.run(['plan', '--since', 'nope']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no repo has the tag nope/);
    const dash = await p.run(['plan', '--since', '-x']);
    assert.equal(dash.status, 2, dash.stderr);
    const both = await p.run(['plan', '--job', 'x', '--since', 'v0']);
    assert.equal(both.status, 2);
    // --job: the job's PR repos, each with a merged PR.
    const j = await p.f('job', 'new', '--title', 'Release me');
    await p.f('job', 'repo', 'add', j.id, 'lib');
    const unknown = await p.run(['plan', '--job', 'no-such-job']);
    assert.equal(unknown.status, 1);
    const file = path.join(p.root, '.forge', 'jobs', j.id, 'job.json');
    const setPr = (repo: string | null, s: string) => {
      const job = JSON.parse(fs.readFileSync(file, 'utf8'));
      const pr = { number: repo === null ? 11 : 7, url: null, state: s, isDraft: false };
      if (repo === null) job.pr = pr;
      else job.repos.find((r: any) => r.repo === repo).pr = pr;
      fs.writeFileSync(file, JSON.stringify(job, null, 2));
    };
    setPr(null, 'MERGED');
    setPr('lib', 'OPEN');
    const open = await p.run(['plan', '--job', j.id]);
    assert.equal(open.status, 1);
    assert.match(open.stderr, new RegExp(`forge release plan --job ${j.id}: lib have no merged PR; run forge pr sync ${j.id} first`));
    setPr('lib', 'MERGED');
    const job = await p.run(['plan', '--job', j.id]);
    assert.equal(job.status, 0, job.stderr);
    assert.deepEqual(job.json.order, ['(root)']);
    assert.deepEqual(job.json.skipped, [{ repo: 'lib', reason: 'no release.mechanism' }]);
    assert.deepEqual(steps(p).selection, { kind: 'job', job: j.id });
    // A member whose clone fails its check: skipped without --job, refused with it.
    fs.writeFileSync(path.join(p.root, '.forge', 'local.yml'), 'repos:\n  lib:\n    path: ../nowhere\n');
    const gone = await p.run(['plan']);
    assert.equal(gone.status, 0, gone.stderr);
    assert.match(gone.json.skipped[0].reason, /^clone: missing clone at /);
    const refused = await p.run(['plan', '--job', j.id]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /repo lib: missing clone at /);
  });

  test('a failure mid-run resumes without repeating finished steps', { skip: posix }, async () => {
    const p = await project(cleanups);
    p.setup(allowBoth);
    assert.equal((await p.run(['plan'])).status, 0);
    fs.writeFileSync(path.join(p.stubs, 'fail-app'), '');
    const first = await p.run(['run']);
    assert.equal(first.status, 1, first.stderr);
    assert.equal(first.json.ok, false);
    assert.equal(first.json.stopped.step, '(root)/publish');
    assert.equal(first.json.stopped.reason, 'exit');
    assert.match(first.json.stopped.log, /06-root-publish\.log$/);
    assert.match(fs.readFileSync(first.json.stopped.log, 'utf8'), /publish failed/);
    const s1 = state(p);
    for (const id of ['lib/preflight', 'lib/release', 'lib/publish', '(root)/preflight', '(root)/release']) assert.equal(s1.steps[id].status, 'done', id);
    assert.equal(s1.steps['(root)/publish'].status, 'failed');
    assert.deepEqual(s1.steps['lib/release'].tags, ['v1.0.0']);
    assert.equal(s1.steps['lib/publish'].version, '1.0.0');
    assert.equal(s1.finishedAt, null);
    fs.rmSync(path.join(p.stubs, 'fail-app'));
    const before = p.argv().length;
    const second = await p.run(['run']);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(second.json.ran, ['(root)/publish']);
    assert.equal(second.json.done, 6);
    const again = p.argv().slice(before);
    assert.ok(again.every((l) => !l.endsWith('@lib') && l !== 'tag lib'), `no second lib command: ${again.join(' | ')}`);
    assert.equal(p.argv().filter((l) => l === 'tag lib').length, 1);
    assert.equal(p.argv().filter((l) => l === 'npm publish @lib').length, 1);
    assert.ok(state(p).finishedAt);
    assert.equal(p.git(p.libBare, 'tag', '--list').trim(), 'v1.0.0');
    assert.equal(fs.existsSync(path.join(p.root, '.forge', 'locks', 'release')), false, 'the lock is released');
  });

  test('check-first skips a step that already happened', { skip: posix }, async () => {
    const p = await project(cleanups);
    p.setup((c) => {
      c.repos[0].release = { mechanism: 'tag', command: TAG, registry: 'npm', publish: 'allow' };
    });
    const plan = await p.run(['plan']);
    assert.deepEqual(plan.json.order, ['lib']);
    // The tag command ran and pushed, then the run crashed before its checkpoint.
    p.git(p.lib, 'tag', 'v1.0.0');
    p.git(p.lib, 'push', '-q', 'origin', 'v1.0.0');
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(p.dir, 'state.json'), JSON.stringify({ version: 1, planHash: steps(p).hash, startedAt: at, updatedAt: at, finishedAt: null, steps: { 'lib/preflight': { status: 'done', at }, 'lib/release': { status: 'started', at } } }));
    const r = await p.run(['run']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.skipped, ['lib/release']);
    assert.deepEqual(r.json.ran, ['lib/publish']);
    assert.equal(state(p).steps['lib/release'].skipped, true);
    assert.deepEqual(p.argv().filter((l) => !l.startsWith('npm view')), ['npm publish @lib']);
  });

  test('a failing check stops the run', { skip: posix }, async () => {
    const p = await project(cleanups);
    p.setup((c) => {
      c.repos[0].release = { mechanism: 'tag', command: 'echo "tag $(basename "$PWD")" >> "$STUB_DIR/argv.log"', publish: 'allow' };
    });
    await p.run(['plan']);
    const r = await p.run(['run']);
    assert.equal(r.status, 1);
    assert.equal(r.json.stopped.step, 'lib/release');
    assert.equal(r.json.stopped.reason, 'check');
    assert.match(r.json.stopped.detail, /^check tag-pushed failed: HEAD carries no tag$/);
    assert.equal(state(p).steps['lib/release'].reason, 'check');
    assert.deepEqual(p.argv(), ['tag lib']);
  });

  test('publish steps need confirmation', { skip: posix }, async () => {
    const p = await project(cleanups);
    p.setup((c) => {
      c.repos[0].release = { mechanism: 'tag', command: TAG, registry: 'npm' };
    });
    await p.run(['plan']);
    const r = await p.run(['run']);
    assert.equal(r.status, 1);
    assert.equal(r.json.stopped.step, 'lib/release');
    assert.equal(r.json.stopped.reason, 'needs_confirmation');
    assert.match(r.json.stopped.detail, /release\.publish: allow for lib/);
    assert.deepEqual(p.argv(), [], 'nothing runs');
    assert.equal(p.git(p.libBare, 'tag', '--list').trim(), '');
    // A manual step needs a terminal even with publish allowed.
    p.setup((c) => {
      c.repos[0].release = { mechanism: 'release-please', publish: 'allow' };
    });
    assert.equal((await p.run(['plan', '--force'])).status, 0, 'the stopped run is discarded');
    const manual = await p.run(['run']);
    assert.equal(manual.status, 1);
    assert.equal(manual.json.stopped.reason, 'manual');
    assert.equal(manual.json.stopped.detail, "Merge lib's open release-please PR on GitHub; its workflow tags the release.");
  });

  test('re-plan keeps or guards checkpoints', async () => {
    const p = await project(cleanups);
    p.setup((c) => {
      c.repos[0].release = { mechanism: 'tag', command: TAG };
    });
    const first = await p.run(['plan']);
    const at = new Date().toISOString();
    const stateFile = path.join(p.dir, 'state.json');
    const write = (finishedAt: string | null) =>
      fs.writeFileSync(stateFile, JSON.stringify({ version: 1, planHash: steps(p).hash, startedAt: at, updatedAt: at, finishedAt, steps: { 'lib/preflight': { status: 'done', at } } }));
    write(null);
    const same = await p.run(['plan']);
    assert.equal(same.status, 0, same.stderr);
    assert.equal(same.json.hash, first.json.hash);
    assert.ok(fs.existsSync(stateFile), 'the same hash keeps state.json');
    p.config((c) => {
      c.repos[0].release.command = 'git tag v2';
    });
    const guarded = await p.run(['plan']);
    assert.equal(guarded.status, 1);
    assert.match(guarded.stderr, /a release run is in progress \(1\/2 steps done\); finish it with forge release run, or re-plan with --force, which discards its checkpoints/);
    assert.ok(fs.existsSync(stateFile));
    assert.equal(steps(p).hash.slice(0, 12), first.json.hash, 'release.json is untouched');
    const daemon = await p.run(['plan', '--force'], { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(p.root) });
    assert.equal(daemon.status, 1);
    assert.match(daemon.stderr, /daemon session may not/);
    assert.ok(fs.existsSync(stateFile));
    const forced = await p.run(['plan', '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.notEqual(forced.json.hash, first.json.hash);
    assert.match(forced.stderr, /discarded the checkpoints/);
    assert.equal(fs.existsSync(stateFile), false);
    // A finished run of another plan is replaced without asking.
    write(new Date().toISOString());
    p.config((c) => {
      c.repos[0].release.command = 'git tag v3';
    });
    const after = await p.run(['plan']);
    assert.equal(after.status, 0, after.stderr);
    assert.equal(fs.existsSync(stateFile), false);
  });

  test('refusals: daemon, lock, stale or edited plan, symlink', async () => {
    const p = await project(cleanups);
    const daemon = await p.run(['run'], { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(p.root) });
    assert.equal(daemon.status, 1);
    assert.match(daemon.stderr, /forge release run runs release and publish commands, which a daemon session may not do; a human runs it in their own session/);
    if (posix) return;
    assert.equal((await p.run(['run'])).status, 1, 'no plan');
    p.setup((c) => {
      c.repos[0].release = { mechanism: 'tag', command: TAG, publish: 'allow' };
    });
    await p.run(['plan']);
    // A live lock holder (this test process), then a dead one's lock is taken over.
    const lock = path.join(p.root, '.forge', 'locks', 'release');
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const owned = await p.run(['run', '--json']);
    assert.equal(owned.status, 3);
    assert.equal(owned.json.error.code, 'owned');
    assert.match(owned.json.error.message, new RegExp(`another forge release run \\(pid ${process.pid}\\) is in progress`));
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: dead, startedAt: new Date().toISOString() }));
    // An argv edited in release.json: stale, and nothing runs.
    const file = path.join(p.dir, 'release.json');
    const good = fs.readFileSync(file, 'utf8');
    const edited = JSON.parse(good);
    edited.repos[0].steps[1].shell = 'echo planted >> "$STUB_DIR/argv.log"';
    fs.writeFileSync(file, JSON.stringify(edited));
    const stale = await p.run(['run']);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /the release plan no longer matches config and the repos \(plan [0-9a-f]{12}, now [0-9a-f]{12}\); run forge release plan/);
    fs.writeFileSync(file, good);
    // Config changed after planning.
    p.config((c) => {
      c.repos[0].release.command = 'echo changed >> "$STUB_DIR/argv.log"';
    });
    const moved = await p.run(['run']);
    assert.equal(moved.status, 1);
    assert.match(moved.stderr, /no longer matches config/);
    assert.deepEqual(p.argv(), []);
    assert.equal(fs.existsSync(path.join(p.dir, 'state.json')), false);
    p.config((c) => {
      c.repos[0].release.command = TAG;
    });
    const unversioned = JSON.parse(good);
    unversioned.version = 99;
    fs.writeFileSync(file, JSON.stringify(unversioned));
    const old = await p.run(['run']);
    assert.equal(old.status, 1);
    assert.match(old.stderr, /re-run forge release plan/);
    fs.writeFileSync(file, good);
    // The dead pid's lock is taken over, and the run goes through.
    const ok = await p.run(['run']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(fs.existsSync(lock), false);
    // A symlinked release dir.
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-elsewhere-'));
    cleanups.push(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
    fs.rmSync(p.dir, { recursive: true });
    fs.symlinkSync(elsewhere, p.dir);
    const linkedPlan = await p.run(['plan']);
    assert.equal(linkedPlan.status, 1);
    assert.match(linkedPlan.stderr, /is a symlink/);
    const linkedRun = await p.run(['run']);
    assert.equal(linkedRun.status, 1);
    assert.match(linkedRun.stderr, /is a symlink/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  });

  test("a --job run records the dependency's release", { skip: posix }, async () => {
    const tagged = (command: string) => async () => {
      const p = await project(cleanups);
      p.setup((c) => {
        c.repos[0].release = { mechanism: 'tag', command, publish: 'allow', interim: 'local' };
      });
      const j = await p.f('job', 'new', '--title', `Release run ${Math.random().toString(36).slice(2, 8)}`);
      await p.f('job', 'repo', 'add', j.id, 'lib');
      const file = path.join(p.root, '.forge', 'jobs', j.id, 'job.json');
      const job = JSON.parse(fs.readFileSync(file, 'utf8'));
      job.pr = { number: 11, url: null, state: 'OPEN', isDraft: true };
      job.repos.find((r: any) => r.repo === 'lib').pr = { number: 7, url: null, state: 'MERGED', isDraft: false };
      fs.writeFileSync(file, JSON.stringify(job, null, 2));
      await p.f('job', 'set', j.id, '--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review');
      const plan = await p.run(['plan', '--job', j.id]);
      assert.equal(plan.status, 0, plan.stderr);
      assert.deepEqual(plan.json.skipped, [{ repo: '(root)', reason: "PR not merged: it waits on its dependencies' release" }]);
      return { p, id: j.id as string, releases: () => p.events(j.id).filter((e) => e.type === 'interim-released') };
    };
    // The tag check of this run names v1.0.0: recorded, and the job resumes.
    const one = await tagged(TAG)();
    const r = await one.p.run(['run']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.released, [{ repo: 'lib', version: 'v1.0.0', recorded: true }]);
    assert.deepEqual(one.releases().map((e) => [e.repo, e.version]), [['lib', 'v1.0.0']]);
    const resumed = loadJob(one.p.root, one.id);
    assert.deepEqual([resumed.state, resumed.waitingOn], ['running', null]);
    assert.match(String(resumed.reason), /^release of repo lib v1\.0\.0 recorded: bump its consumers/);
    // A state.json that says every step is done, with a forged version: nothing runs, nothing is logged.
    assert.equal((await one.p.run(['plan', '--job', one.id, '--force'])).status, 0);
    const at = new Date().toISOString();
    const forged = { status: 'done', at, tags: ['v9.9.9'], version: '9.9.9' };
    fs.writeFileSync(path.join(one.p.dir, 'state.json'), JSON.stringify({ version: 1, planHash: steps(one.p).hash, startedAt: at, updatedAt: at, finishedAt: null, steps: { 'lib/preflight': { status: 'done', at }, 'lib/release': forged } }));
    const again = await one.p.run(['run']);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(again.json.released, []);
    assert.equal(one.releases().length, 1, 'no event from state.json');
    // Two version tags at HEAD: ambiguous, nothing recorded, and the hint names the command.
    const two = await tagged('git tag v1.0.0 && git tag v1.0.1 && git push -q origin v1.0.0 v1.0.1')();
    const amb = await two.p.run(['run']);
    assert.equal(amb.status, 0, amb.stderr);
    assert.deepEqual(amb.json.released, [{ repo: 'lib', version: null, recorded: false, hint: `forge job interim release ${two.id} lib <version>` }]);
    assert.deepEqual(two.releases(), []);
  });

  test('status shows progress and staleness', { skip: posix }, async () => {
    const p = await project(cleanups);
    assert.equal((await p.run(['status'])).json.plan, null);
    p.setup((c) => {
      c.repos[0].release = { mechanism: 'tag', command: TAG, registry: 'npm', publish: 'allow' };
    });
    await p.run(['plan']);
    const fresh = (await p.run(['status'])).json;
    assert.equal(fresh.next, 'lib/preflight');
    assert.equal(fresh.stale, false);
    assert.equal(fresh.done, 0);
    assert.equal(fresh.total, 3);
    assert.deepEqual(fresh.selection, { kind: 'all' });
    fs.writeFileSync(path.join(p.stubs, 'fail-lib'), '');
    await p.run(['run']);
    const mid = (await p.run(['status'])).json;
    assert.equal(mid.next, 'lib/publish');
    assert.equal(mid.done, 2);
    const release = mid.steps.find((s: any) => s.id === 'lib/release');
    assert.deepEqual(release.tags, ['v1.0.0']);
    assert.equal(release.publish, true);
    assert.equal(mid.steps.find((s: any) => s.id === 'lib/publish').status, 'failed');
    assert.equal(mid.steps.find((s: any) => s.id === 'lib/publish').reason, 'exit');
    assert.equal(mid.finishedAt, null);
    p.config((c) => {
      c.repos[0].release.registry = 'none';
    });
    const stale = (await p.run(['status'])).json;
    assert.equal(stale.stale, true);
    assert.match(stale.staleReason, /^plan [0-9a-f]{12}, now [0-9a-f]{12}$/);
  });
});
