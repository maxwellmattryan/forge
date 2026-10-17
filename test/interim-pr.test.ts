// Interim strategies in the PR lifecycle: `local` holds the consumer PR as a draft and off
// auto-merge, `sequential` defers it until the dependency's PR merges, then `pr sync` reopens the job.
// Scratch repos with bare remotes and the fake `gh` from job-repos-fixture.ts; no real GitHub repo.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dependsOn, prProject, ready } from './job-repos-fixture.ts';
import type { PrProject } from './job-repos-fixture.ts';
import { loadJob } from '../lib/jobs.ts';

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
