// Interim strategies through the CLI and the PR lifecycle. `forge job interim` resolves each edge's
// strategy (job override, then config, then local) and `forge job repo interim` sets and clears the
// override; `local` holds the consumer PR as a draft and off auto-merge, `sequential` defers it until
// the dependency's PR merges, then `pr sync` reopens the job; `forge job interim release` (human-only)
// records a dependency's release, which clears its consumers' release gate. Scratch repos with bare
// remotes and the fake `gh` from job-repos-fixture.ts; no real GitHub repo and no network.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dependsOn, prProject, ready } from '../../job-repos-fixture.ts';
import type { PrProject, TwoRepo } from '../../job-repos-fixture.ts';
import { TRUST_ENV, trustDigest } from '../../../lib/core/config/load.ts';
import { RELEASE_DAEMON_REFUSAL } from '../../../lib/engine/release/interim-apply.ts';
import { loadJob } from '../../../lib/core/job/store.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));
const project = () => prProject(cleanups);

async function opened(p: PrProject, id: string) {
  const r = await p.pr(['open', id]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const readies = (p: PrProject) => p.calls().filter((c) => c.startsWith('pr ready'));
const step = async (p: PrProject, id: string) => p.f('job', 'step', id);
/** Writes a member PR state straight into job.json, as a hand edit or a stale record would. */
function recordState(p: PrProject, id: string, repo: string, state: string): void {
  const file = path.join(p.root, '.forge', 'jobs', id, 'job.json');
  const job = JSON.parse(fs.readFileSync(file, 'utf8'));
  job.repos.find((r: any) => r.repo === repo).pr.state = state;
  fs.writeFileSync(file, JSON.stringify(job, null, 2));
}

const park = (p: PrProject, id: string) => p.f('job', 'set', id, '--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review');

/** A job with lib as a member (verify-only when asked), and no worktree. */
async function memberJob(p: TwoRepo, verifyOnly = false): Promise<string> {
  const j = await p.f('job', 'new', '--title', `interim ${Math.random().toString(36).slice(2, 8)}`);
  await p.f('job', 'repo', 'add', ...(verifyOnly ? ['--verify-only'] : []), j.id, 'lib');
  return j.id;
}

const brief = (r: any) => r.edges.map((e: any) => [e.consumer, e.dependency, e.strategy, e.source, e.state]);
const jobFile = (p: TwoRepo, id: string) => path.join(p.root, '.forge', 'jobs', id, 'job.json');
const jobJson = (p: TwoRepo, id: string) => JSON.parse(fs.readFileSync(jobFile(p, id), 'utf8'));

describe('interim strategies: CLI', { concurrency: 4 }, () => {
  test('job interim resolves default, config and job override', async () => {
    const p = await project();
    dependsOn(p, 'app-on-lib');
    const id = await memberJob(p);
    const first = await p.f('job', 'interim', id);
    assert.deepEqual(brief(first), [[null, 'lib', 'local', 'config', 'held']]);
    assert.equal(first.edges[0].detail, "the root repo's PR opens as a draft (interim: local)");
    assert.deepEqual(first.edges[0].links, [], 'no dependsOn link');
    p.config((c) => (c.repos[0].release = { interim: 'sequential' }));
    assert.deepEqual(brief(await p.f('job', 'interim', id)), [[null, 'lib', 'sequential', 'config', 'waiting']]);
    assert.equal((await p.f('job', 'interim', id)).edges[0].detail, 'repo lib has no PR yet');
    await p.f('job', 'repo', 'interim', id, 'lib', 'local');
    assert.deepEqual(brief(await p.f('job', 'interim', id)), [[null, 'lib', 'local', 'job', 'held']], 'a job override wins over config');
    const single = await p.f('job', 'new', '--title', 'single repo');
    assert.deepEqual((await p.f('job', 'interim', single.id)).edges, []);
  });

  test('root repo as dependency resolves through release.interim', async () => {
    const p = await project();
    dependsOn(p, 'lib-on-app');
    const id = await memberJob(p);
    assert.deepEqual(brief(await p.f('job', 'interim', id)), [['lib', null, 'local', 'config', 'held']]);
    p.config((c) => {
      c.release = { interim: 'sequential' };
      c.repos[0].release = { interim: 'git-ref' };
    });
    assert.deepEqual(brief(await p.f('job', 'interim', id)), [['lib', null, 'sequential', 'config', 'waiting']], "the root's own release.interim, not a member's");
    assert.deepEqual(await p.f('job', 'repo', 'interim', id, '--root', 'local'), { id, repo: null, interim: 'local' });
    assert.deepEqual(brief(await p.f('job', 'interim', id)), [['lib', null, 'local', 'job', 'held']]);
    const raw = jobJson(p, id);
    assert.deepEqual([raw.interim, raw.repos[0].interim, raw.repos[1].interim], ['local', 'local', null]);
  });

  // Its canary tail (npm-only) is canary.test.ts › "canary is npm-only, and its release record bumps the consumer".
  test('job repo interim sets, clears and refuses', async () => {
    const p = await project();
    dependsOn(p, 'app-on-lib');
    const id = await memberJob(p);
    assert.deepEqual(await p.f('job', 'repo', 'interim', id, 'lib', 'sequential'), { id, repo: 'lib', interim: 'sequential' });
    assert.equal(jobJson(p, id).repos[1].interim, 'sequential');
    assert.deepEqual(await p.f('job', 'repo', 'interim', id, 'lib', 'inherit'), { id, repo: 'lib', interim: null });
    assert.equal(jobJson(p, id).repos[1].interim, null);
    assert.deepEqual(p.events(id).filter((e) => e.type === 'job-repo-interim').map((e) => [e.repo, e.interim]), [['lib', 'sequential'], ['lib', null]]);

    const before = fs.readFileSync(jobFile(p, id), 'utf8');
    const daemon = await p.raw(['job', 'repo', 'interim', id, 'lib', 'canary'], { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(p.root) });
    assert.equal(daemon.status, 1, daemon.stdout);
    assert.match(daemon.stderr, /a daemon session may not change; a human runs it in their own session/);
    assert.equal(fs.readFileSync(jobFile(p, id), 'utf8'), before, 'job.json unchanged');

    const unknown = await p.raw(['job', 'repo', 'interim', id, 'nope', 'local']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /has no repo "nope"/);
    const bogus = await p.raw(['job', 'repo', 'interim', id, 'lib', 'publish']);
    assert.equal(bogus.status, 1);
    assert.match(bogus.stderr, /strategy must be one of canary \| git-ref \| local \| sequential \| inherit/);
    const v = await memberJob(p, true);
    const vo = await p.raw(['job', 'repo', 'interim', v, 'lib', 'local']);
    assert.equal(vo.status, 1);
    assert.match(vo.stderr, /repo lib is verify-only/);
    const set = await p.raw(['job', 'set', id, '--field', 'interim="canary"']);
    assert.equal(set.status, 1, 'job set cannot write the override');
  });
});

describe('interim strategies: pull requests', { concurrency: 4 }, () => {
  test('local holds the consumer PR as a draft', async () => {
    const p = await project();
    dependsOn(p, 'app-on-lib');
    p.config((c) => {
      c.pr.draft = false;
      c.merge.auto = true;
    });
    const j = await ready(p);
    await p.f('verify', j.id);
    const out = await opened(p, j.id);
    assert.equal(out.deferred, undefined, 'local defers nothing');
    const creates = p.calls().filter((c) => c.startsWith('pr create'));
    assert.equal(creates.length, 2);
    assert.match(creates[0], /^pr create -R o\/lib /);
    assert.doesNotMatch(creates[0], /--draft/, 'the dependency follows pr.draft');
    assert.match(creates[1], /^pr create -R o\/app .*--draft/, 'the consumer is a draft');
    assert.equal(loadJob(p.root, j.id).pr?.isDraft, true);
    // PR4 holds off while the edge is local, even with an auto-merge decision.
    await p.f('job', 'set', j.id, '--stage', 'pr', '--state', 'running');
    fs.writeFileSync(path.join(p.root, '.forge', 'jobs', j.id, 'decision.md'), 'APPROVE: fine\n\n- Auto-merge eligible: yes\n');
    const s = await step(p, j.id);
    assert.equal(s.rule, 'PR5');
  });

  test('sequential defers the consumer PR until the dependency merges', async () => {
    const p = await project();
    dependsOn(p, 'app-on-lib');
    p.config((c) => (c.repos[0].release = { interim: 'sequential' }));
    const j = await ready(p);
    await p.f('verify', j.id);
    const out = await opened(p, j.id);
    assert.deepEqual([out.number, out.url, out.created], [null, null, false]);
    assert.deepEqual(out.deferred, [{ repo: null, why: 'sequential', waitingOn: ['lib'] }]);
    assert.deepEqual(out.repos.map((r: any) => [r.repo, r.number, r.created]), [['lib', 7, true]]);
    assert.ok(!p.heads(p.rootBare).split('\n').includes(j.branch), 'nothing pushed for the root');
    assert.ok(p.heads(p.libBare).split('\n').includes(j.branch));
    assert.ok(!p.calls().some((c) => c.startsWith('pr create -R o/app')));
    const types = p.events(j.id).map((e) => e.type);
    assert.ok(types.lastIndexOf('pr-deferred') > types.lastIndexOf('repo-pr-opened'), 'pr-deferred is logged after the member PR');
    assert.deepEqual((await p.f('job', 'interim', j.id)).edges.map((e: any) => [e.state, e.detail]), [['waiting', 'repo lib PR #7 is not merged']]);
    await p.f('job', 'set', j.id, '--stage', 'pr', '--state', 'running');
    assert.equal((await step(p, j.id)).rule, 'PR8');
    await park(p, j.id);

    // Not merged yet: sync leaves the job parked.
    let r = await p.raw(['pr', 'sync', j.id], p.env);
    assert.equal(r.status, 0, r.stderr);
    let sync = JSON.parse(r.stdout);
    assert.equal(sync.reopen, undefined);
    assert.equal(loadJob(p.root, j.id).state, 'waiting');
    p.fake('lib.state', 'MERGED');
    r = await p.raw(['pr', 'sync', j.id], p.env);
    assert.equal(r.status, 0, r.stderr);
    sync = JSON.parse(r.stdout);
    assert.equal(sync.reopen, true);
    const job = loadJob(p.root, j.id);
    assert.deepEqual([job.state, job.waitingOn, job.reason], ['running', null, 'forge sync: dependencies merged: open the deferred PRs']);
    assert.equal((await step(p, j.id)).rule, 'PR7');
    const again = await opened(p, j.id);
    assert.deepEqual([again.number, again.created, again.deferred], [11, true, undefined]);
    assert.ok(p.heads(p.rootBare).split('\n').includes(j.branch));
    assert.equal(p.calls().filter((c) => c.startsWith('pr create -R o/lib')).length, 1, 'the merged dependency is not opened again');
  });

  test('sequential with the root as dependency defers the member', async () => {
    const p = await project();
    dependsOn(p, 'lib-on-app');
    p.config((c) => (c.release = { interim: 'sequential' }));
    const j = await ready(p);
    await p.f('verify', j.id);
    const out = await opened(p, j.id);
    assert.deepEqual([out.number, out.created], [11, true]);
    assert.deepEqual(out.deferred, [{ repo: 'lib', why: 'sequential', waitingOn: [null] }]);
    assert.deepEqual(out.repos, []);
    assert.ok(!p.heads(p.libBare).split('\n').includes(j.branch), 'nothing pushed for the member');
    const types = p.events(j.id).map((e) => e.type);
    assert.ok(types.lastIndexOf('pr-deferred') > types.lastIndexOf('pr-opened'), 'pr-deferred is logged after the root PR');
    await park(p, j.id);
    p.fake('app.state', 'MERGED');
    const r = await p.raw(['pr', 'sync', j.id], p.env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).reopen, true, 'reopening wins over waiting on the member');
    assert.equal(loadJob(p.root, j.id).state, 'running');
    const again = await opened(p, j.id);
    assert.deepEqual([again.number, again.created, again.deferred], [11, false, undefined]);
    assert.deepEqual(again.repos.map((x: any) => [x.repo, x.created]), [['lib', true]]);
    assert.ok(p.heads(p.libBare).split('\n').includes(j.branch));
    assert.equal(p.calls().filter((c) => c.startsWith('pr create -R o/app')).length, 1, 'the merged root is not opened again');
  });

  test('without interim edges a merged member PR is still checked and pushed', async () => {
    const p = await project();
    const j = await ready(p);
    await p.f('verify', j.id);
    await opened(p, j.id);
    recordState(p, j.id, 'lib', 'MERGED');
    const sha = p.commit(j.libWt, { 'more.txt': 'more\n' }, 'feat: more');
    await p.f('verify', j.id);
    const out = await opened(p, j.id);
    assert.deepEqual(out.repos.map((r: any) => r.repo), ['lib'], 'the member is not skipped');
    assert.equal(p.git(p.libBare, 'rev-parse', j.branch).trim(), sha, 'its new commit is pushed');
  });

  test('a recorded merge GitHub denies is corrected, so PR7 does not loop', async () => {
    const p = await project();
    dependsOn(p, 'app-on-lib');
    p.config((c) => (c.repos[0].release = { interim: 'sequential' }));
    const j = await ready(p);
    await p.f('verify', j.id);
    await opened(p, j.id);
    await p.f('job', 'set', j.id, '--stage', 'pr', '--state', 'running');
    recordState(p, j.id, 'lib', 'MERGED');
    assert.equal((await step(p, j.id)).rule, 'PR7', 'the record alone says the dependency merged');
    const out = await opened(p, j.id);
    assert.deepEqual(out.deferred, [{ repo: null, why: 'sequential', waitingOn: ['lib'] }], 'GitHub says it is open: still deferred');
    assert.equal(loadJob(p.root, j.id).repos.find((r) => r.repo === 'lib')?.pr?.state, 'OPEN', 'the record follows GitHub');
    assert.deepEqual(p.events(j.id).filter((e) => e.type === 'pr-state-corrected').map((e) => [e.repo, e.recorded, e.live]), [['lib', 'MERGED', 'OPEN']]);
    assert.equal((await step(p, j.id)).rule, 'PR8', 'no second PR7');

    recordState(p, j.id, 'lib', 'MERGED');
    p.fake('lib.viewfail', '1');
    const r = await p.pr(['open', j.id]);
    assert.equal(r.status, 5, 'a record GitHub cannot confirm stops pr open (external)');
    assert.match(r.stderr, /recorded MERGED, but GitHub can't confirm its state/);
  });

  test('a local consumer PR cannot leave draft before its dependency is released', async () => {
    const p = await project();
    dependsOn(p, 'app-on-lib');
    p.config((c) => (c.pr.draft = false));
    const j = await ready(p);
    await p.f('verify', j.id);
    await opened(p, j.id);
    assert.equal(loadJob(p.root, j.id).pr?.isDraft, true);
    const refused = await p.raw(['pr', 'ready', '--json', j.id], p.env);
    assert.equal(refused.status, 1, refused.stdout);
    const err = JSON.parse(refused.stdout).error;
    assert.equal(err.code, 'release_gate');
    assert.equal(err.message, `the root repo's PR stays a draft until repo lib's release is recorded; a human runs: forge job interim release ${j.id} lib <version>`);
    assert.equal((await p.raw(['pr', 'ready', j.id, '--root'], p.env)).status, 1, 'targeted too');
    assert.deepEqual(readies(p), [], 'no gh pr ready call');
    assert.equal(loadJob(p.root, j.id).pr?.isDraft, true);

    p.fake('lib.state', 'MERGED');
    assert.equal((await p.raw(['pr', 'sync', j.id], p.env)).status, 0);
    assert.equal((await p.f('job', 'interim', 'release', j.id, 'lib', '1.2.0')).recorded, true);
    const r = await p.raw(['pr', 'ready', j.id], p.env);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { id: j.id, ready: [{ repo: null, number: 11 }], skipped: [] });
    assert.deepEqual(readies(p), ['pr ready 11 -R o/app']);
    assert.equal(loadJob(p.root, j.id).pr?.isDraft, false);
    assert.deepEqual(p.events(j.id).filter((e) => e.type === 'pr-ready').map((e) => [e.repo, e.number]), [[undefined, 11]]);
    const again = await p.raw(['pr', 'ready', j.id, '--root'], p.env);
    assert.deepEqual(JSON.parse(again.stdout).skipped, [{ repo: null, number: 11, why: 'not a draft' }]);
    assert.equal(readies(p).length, 1, 'nothing to ready: no call');
  });

  test('sequential opens the consumer as a draft until the release is recorded', async () => {
    const p = await project();
    dependsOn(p, 'app-on-lib');
    p.config((c) => {
      c.pr.draft = false;
      c.repos[0].release = { interim: 'sequential' };
    });
    const j = await ready(p);
    await p.f('verify', j.id);
    assert.deepEqual((await opened(p, j.id)).deferred, [{ repo: null, why: 'sequential', waitingOn: ['lib'] }]);
    p.fake('lib.state', 'MERGED');
    assert.equal((await p.raw(['pr', 'sync', j.id], p.env)).status, 0);
    const out = await opened(p, j.id);
    assert.deepEqual([out.number, out.created], [11, true]);
    assert.match(p.calls().find((c) => c.startsWith('pr create -R o/app'))!, /--draft/, 'the consumer opens as a draft while the gate is held');
    assert.equal(loadJob(p.root, j.id).pr?.isDraft, true);
    const refused = await p.raw(['pr', 'ready', '--json', j.id], p.env);
    assert.equal(refused.status, 1);
    assert.equal(JSON.parse(refused.stdout).error.code, 'release_gate');
    assert.deepEqual(readies(p), []);
    await p.f('job', 'interim', 'release', j.id, 'lib', '1.2.0');
    const r = await p.raw(['pr', 'ready', j.id], p.env);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readies(p), ['pr ready 11 -R o/app']);
    assert.equal(loadJob(p.root, j.id).pr?.isDraft, false);
  });

  test('pr merge refuses a consumer whose dependency is unreleased', async () => {
    const p = await project();
    dependsOn(p, 'app-on-lib');
    const j = await ready(p);
    await p.f('verify', j.id);
    await opened(p, j.id);
    const job = loadJob(p.root, j.id);
    p.fake('app.head', job.pr!.pushedSha!);
    p.fake('lib.head', job.repos[1].pr!.pushedSha!);
    p.fake('app.checks', 'passing');
    p.fake('lib.checks', 'passing');
    const r = await p.pr(['merge', j.id]);
    assert.equal(r.status, 1, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual([out.action, out.reason, out.repo], ['refused', 'release', null]);
    assert.equal(out.error, `the root repo's PR stays a draft until repo lib's release is recorded; a human runs: forge job interim release ${j.id} lib <version>`);
    assert.deepEqual(out.parts.map((x: any) => [x.repo, x.action]), [['lib', 'merged'], [null, 'refused']], 'the dependency merged first');
    for (const flags of [['--now'], ['--root', '--now']]) {
      const n = await p.pr(['merge', j.id, ...flags]);
      assert.equal(n.status, 1, String(flags));
      assert.deepEqual([JSON.parse(n.stdout).action, JSON.parse(n.stdout).reason], ['refused', 'release'], String(flags));
    }
    assert.ok(!p.calls().some((c) => c.startsWith('pr merge 11 -R o/app')), 'no gh pr merge for the consumer');
    assert.deepEqual(p.events(j.id).filter((e) => e.type === 'pr-merge-refused').map((e) => e.reason), ['release', 'release', 'release']);
    assert.deepEqual(p.events(j.id).filter((e) => e.type === 'pr-merge-bypass'), [], '--now never bypasses a release gate');
  });

  test('bump-due consumers are not readied or merged', async () => {
    const p = await project();
    p.config((c) => {
      c.pr.draft = false;
      c.components = [
        { name: 'app', path: '.', kind: 'app', dependsOn: [{ component: 'lib', type: 'build', link: { ecosystem: 'npm', name: 'engine' } }] },
        { name: 'lib', repo: 'lib', path: '.', kind: 'library' },
      ];
    });
    const j = await ready(p);
    p.commit(j.rootWt, { 'package.json': '{\n  "name": "app",\n  "dependencies": {\n    "engine": "^1.0.0"\n  }\n}\n' });
    await p.f('verify', j.id);
    await opened(p, j.id);
    const job = loadJob(p.root, j.id);
    p.fake('app.head', job.pr!.pushedSha!);
    p.fake('lib.head', job.repos[1].pr!.pushedSha!);
    p.fake('app.checks', 'passing');
    p.fake('lib.checks', 'passing');
    p.fake('lib.state', 'MERGED');
    assert.equal((await p.raw(['pr', 'sync', j.id], p.env)).status, 0);
    await p.f('job', 'interim', 'release', j.id, 'lib', '1.2.0');
    assert.equal((await p.f('job', 'interim', j.id)).gates[0].gate, 'bump-due');
    const message = `the root repo's manifests don't name repo lib's released version 1.2.0 yet; run: forge verify ${j.id}, then forge pr open ${j.id}`;
    for (const flags of [[], ['--root']]) {
      const r = await p.raw(['pr', 'ready', '--json', j.id, ...flags], p.env);
      assert.equal(r.status, 1, r.stdout);
      assert.deepEqual([JSON.parse(r.stdout).error.code, JSON.parse(r.stdout).error.message], ['release_gate', message]);
    }
    assert.deepEqual(readies(p), [], 'no gh pr ready call');
    for (const flags of [[], ['--now'], ['--root', '--now']]) {
      const m = await p.pr(['merge', j.id, ...flags]);
      assert.equal(m.status, 1, String(flags));
      const out = JSON.parse(m.stdout);
      assert.deepEqual([out.action, out.reason, out.error], ['refused', 'release', message], String(flags));
    }
    assert.ok(!p.calls().some((c) => c.startsWith('pr merge 11 -R o/app')), 'no gh pr merge for the consumer');
    // Once verify bumped it, the gate is released and the consumer may leave draft.
    await p.f('verify', j.id);
    assert.equal((await p.f('job', 'interim', j.id)).gates[0].gate, 'released');
    const r = await p.raw(['pr', 'ready', j.id], p.env);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readies(p), ['pr ready 11 -R o/app']);
  });
});

/** The project, `app` (root) on `lib`, and a job with lib as a member. */
async function setup(edge: 'app-on-lib' | 'lib-on-app' = 'app-on-lib') {
  const p = await project();
  dependsOn(p, edge);
  return { p, id: await memberJob(p) };
}

/** Writes a PR record straight into job.json (null: the root's), as pr open and pr sync would. */
function recordPr(p: TwoRepo, id: string, repo: string | null, state: string, extra: Record<string, unknown> = {}): void {
  const job = jobJson(p, id);
  const pr = { number: repo === null ? 11 : 7, url: null, state, isDraft: false, ...extra };
  if (repo === null) job.pr = pr;
  else job.repos.find((r: any) => r.repo === repo).pr = pr;
  fs.writeFileSync(jobFile(p, id), JSON.stringify(job, null, 2));
}
const released = (p: TwoRepo, id: string) => p.events(id).filter((e) => e.type === 'interim-released');

// The git-ref and canary records are gitref.test.ts › "release record: git-ref, resume" and
// canary.test.ts › "canary is npm-only, and its release record bumps the consumer"; malformed
// records are interim.test.ts › "release gates: bump-due and released".
describe('interim release', { concurrency: 4 }, () => {
  test('release is human-only', async () => {
    const { p, id } = await setup();
    recordPr(p, id, 'lib', 'MERGED');
    const r = await p.raw(['job', 'interim', 'release', id, 'lib', '1.2.0'], { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(p.root) });
    assert.equal(r.status, 1, r.stdout);
    assert.ok(r.stderr.includes(RELEASE_DAEMON_REFUSAL), r.stderr);
    assert.equal(RELEASE_DAEMON_REFUSAL, "forge job interim release records a dependency's release, which a daemon session may not do; a human runs it in their own session");
    // Refused before the job is read: a job that does not exist gets the same answer.
    const none = await p.raw(['job', 'interim', 'release', 'no-such-job', 'lib', '1.2.0'], { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(p.root) });
    assert.ok(none.stderr.includes(RELEASE_DAEMON_REFUSAL), none.stderr);
    assert.deepEqual(released(p, id), []);
  });

  test('release refusals', async () => {
    const { p, id } = await setup();
    const refused = async (args: string[], re: RegExp) => {
      const r = await p.raw(['job', 'interim', 'release', ...args]);
      assert.equal(r.status, 1, `${args.join(' ')}: ${r.stdout}`);
      assert.match(r.stderr, re, args.join(' '));
    };
    await refused(['no-such-job', 'lib', '1.2.0'], /no-such-job/);
    await refused([id, 'other', '1.2.0'], /has no repo "other"/);
    await refused([id, '--root', '1.2.0'], /the root repo is not the dependency of an edge on job .* \(no edge depends on it\)/);
    await refused([id, 'lib', '1.2.0'], /repo lib's PR is not merged \(recorded state none\); a release comes from a merged change; run: forge pr sync /);
    recordPr(p, id, 'lib', 'OPEN');
    await refused([id, 'lib', '1.2.0'], /repo lib's PR is not merged \(recorded state OPEN\)/);
    recordPr(p, id, 'lib', 'MERGED');
    for (const bad of ['1.2', '01.2.0', 'latest', `1.2.0-${'x'.repeat(130)}`, '1.2.0 ']) await refused([id, 'lib', bad], /is not a semver version/);
    for (const canary of ['1.2.0-canary.abc123', '1.2.0-CANARY', '1.2.0+canary']) await refused([id, 'lib', canary], /is a canary; a release gate clears only on a released version/);
    const job = jobJson(p, id);
    for (const state of ['done', 'cancelled']) {
      fs.writeFileSync(jobFile(p, id), JSON.stringify({ ...job, state }, null, 2));
      await refused([id, 'lib', '1.2.0'], new RegExp(`job ${id} is ${state}`));
    }
    fs.writeFileSync(jobFile(p, id), JSON.stringify(job, null, 2));
    const usage = await p.raw(['job', 'interim', 'release', id, 'lib']);
    assert.equal(usage.status, 2, 'a missing version is a usage error');
    assert.deepEqual(released(p, id), [], 'no refusal writes an event');
  });

  test('release records once and opens the gate', async () => {
    const { p, id } = await setup();
    let interim = await p.f('job', 'interim', id);
    assert.deepEqual(interim.gates, [{ consumer: null, dependency: 'lib', strategy: 'local', gate: 'held' }]);
    recordPr(p, id, 'lib', 'MERGED');
    assert.deepEqual(await p.f('job', 'interim', 'release', id, 'lib', '1.2.0'), { id, repo: 'lib', version: '1.2.0', recorded: true, clear: [null], bump: [] });
    assert.deepEqual(released(p, id).map((e) => [e.repo, e.version]), [['lib', '1.2.0']]);
    assert.deepEqual(await p.f('job', 'interim', 'release', id, 'lib', '1.2.0'), { id, repo: 'lib', version: '1.2.0', recorded: false, clear: [null], bump: [] });
    assert.equal(released(p, id).length, 1, 'the same version again logs nothing');
    interim = await p.f('job', 'interim', id);
    assert.deepEqual(interim.gates, [{ consumer: null, dependency: 'lib', strategy: 'local', gate: 'released', version: '1.2.0' }]);
    assert.equal((await p.f('job', 'interim', 'release', id, 'lib', 'v1.3.0')).recorded, true, 'a later version is logged');
    assert.equal((await p.f('job', 'interim', id)).gates[0].version, 'v1.3.0', 'the latest wins');
  });

  test('--root in either position', async () => {
    const { p, id } = await setup('lib-on-app');
    p.config((c) => (c.release = { interim: 'sequential' }));
    recordPr(p, id, null, 'MERGED');
    assert.deepEqual(await p.f('job', 'interim', 'release', id, '--root', '2.0.0'), { id, repo: null, version: '2.0.0', recorded: true, clear: ['lib'], bump: [] });
    assert.deepEqual(await p.f('job', 'interim', 'release', id, '2.0.1', '--root'), { id, repo: null, version: '2.0.1', recorded: true, clear: ['lib'], bump: [] });
    assert.deepEqual(released(p, id).map((e) => [e.repo, e.version]), [[null, '2.0.0'], [null, '2.0.1']]);
    assert.deepEqual((await p.f('job', 'interim', id)).gates, [{ consumer: 'lib', dependency: null, strategy: 'sequential', gate: 'released', version: '2.0.1' }]);
    const extra = await p.raw(['job', 'interim', 'release', id, 'lib', '2.0.0', '--root']);
    assert.equal(extra.status, 2, 'a name and --root together is a usage error');
  });
});
