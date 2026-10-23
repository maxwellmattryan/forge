// `forge job repo downstream` (issue #186): adding a changed library's linked consumers as
// verify-only repos, what it logs, and who may run it. No worktree or command runs here;
// test/downstream-verify.test.ts drives verify itself.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TRUST_ENV, trustDigest } from '#core/config/load.ts';
import { loadJob, updateJob } from '#core/job/store.ts';
import { downstreamProject } from './downstream-fixture.ts';
import type { DownstreamProject } from './downstream-fixture.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

async function project(): Promise<DownstreamProject> {
  const p = await downstreamProject();
  cleanups.push(p.cleanup);
  return p;
}

const snapshot = (p: DownstreamProject, id: string) => ['job.json', 'events.jsonl'].map((f) => fs.readFileSync(path.join(path.dirname(p.jobFile(id)), f), 'utf8'));
const daemonEnv = (p: DownstreamProject, scope: string) => ({ FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(p.root), FORGE_DAEMON_SCOPE: scope });

async function fails(p: DownstreamProject, args: string[], re: RegExp, env: NodeJS.ProcessEnv = {}, status = 1) {
  const r = await p.raw(args, env);
  assert.equal(r.status, status, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr + r.stdout, re);
}

describe('downstream verification: the CLI', { concurrency: 4 }, () => {
  test('adds consumers verify-only and records the check', async () => {
    const p = await project();
    const j = await p.f('job', 'new', '--title', 'core change');
    const r = await p.f('job', 'repo', 'downstream', j.id);
    assert.deepEqual(r, { id: j.id, added: ['app-a', 'app-b'], skipped: [] });
    const job = loadJob(p.root, j.id);
    assert.deepEqual(
      job.repos.slice(1).map((m) => [m.repo, m.verifyOnly, m.branch, m.base]),
      [['app-a', true, null, 'main'], ['app-b', true, null, 'main']],
    );
    const raw = JSON.parse(fs.readFileSync(p.jobFile(j.id), 'utf8'));
    assert.deepEqual(raw.repos.slice(1).map((m: any) => [m.verifyOnly, m.branch]), [[true, null], [true, null]]);
    const evs = p.events(j.id);
    assert.deepEqual(evs.filter((e) => e.type === 'job-repo-added').map((e) => [e.repo, e.verifyOnly, e.downstream]), [['app-a', true, true], ['app-b', true, true]]);
    const checked = evs.filter((e) => e.type === 'downstream-checked');
    assert.deepEqual(checked.map((e) => [e.added, e.skipped]), [[['app-a', 'app-b'], []]]);

    // Skips are listed with their reasons; a repo already on the job is neither.
    const k = await p.f('job', 'new', '--title', 'core change, b skipped');
    p.config((c) => (c.downstream = { enabled: true, max: 5, skip: ['app-b'] }));
    assert.deepEqual(await p.f('job', 'repo', 'downstream', k.id), { id: k.id, added: ['app-a'], skipped: [{ repo: 'app-b', reason: 'listed in downstream.skip' }] });
    p.config((c) => (c.downstream = { enabled: true, max: 1, skip: [] }));
    const m = await p.f('job', 'new', '--title', 'core change, capped');
    assert.deepEqual(await p.f('job', 'repo', 'downstream', m.id), { id: m.id, added: ['app-a'], skipped: [{ repo: 'app-b', reason: 'over downstream.max (1)' }] });
  });

  test('a failing clone is skipped, the rest added', async () => {
    const p = await project();
    fs.writeFileSync(path.join(p.root, '.forge', 'local.yml'), 'repos:\n  app-a:\n    path: ../app-a\n  app-b:\n    path: ../no-such-clone\n');
    const j = await p.f('job', 'new', '--title', 'core change');
    const r = await p.f('job', 'repo', 'downstream', j.id);
    assert.deepEqual(r.added, ['app-a']);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].repo, 'app-b');
    assert.match(r.skipped[0].reason, /^repo app-b: /);
    assert.deepEqual(loadJob(p.root, j.id).repos.slice(1).map((x) => x.repo), ['app-a']);
    assert.deepEqual(p.events(j.id).filter((e) => e.type === 'downstream-checked').map((e) => e.skipped), [r.skipped]);
  });

  test('a second run adds nothing', async () => {
    const p = await project();
    const j = await p.f('job', 'new', '--title', 'core change');
    await p.f('job', 'repo', 'downstream', j.id);
    const before = loadJob(p.root, j.id).repos;
    assert.deepEqual(await p.f('job', 'repo', 'downstream', j.id), { id: j.id, added: [], skipped: [] });
    assert.deepEqual(loadJob(p.root, j.id).repos, before);
    assert.equal(p.events(j.id).filter((e) => e.type === 'downstream-checked').length, 2);
    assert.equal(p.events(j.id).filter((e) => e.type === 'job-repo-added').length, 2);
  });

  test("authority: refused outside the job's own session, never takes a name", async () => {
    const p = await project();
    const j = await p.f('job', 'new', '--title', 'scoped');
    const other = await p.f('job', 'new', '--title', 'another');
    const before = snapshot(p, j.id);
    // No repo name, no flag: the candidates are computed, never chosen.
    for (const args of [[j.id, 'app-a'], [j.id, '--verify-only'], [j.id, '--repo', 'app-a'], [], [j.id, 'app-a', 'app-b']])
      await fails(p, ['job', 'repo', 'downstream', ...args], /usage: forge job repo /, {}, 2);
    const usage = await p.raw(['job', 'repo', 'downstream', j.id, 'app-a', '--json']);
    assert.equal(JSON.parse(usage.stderr.trim() || usage.stdout.trim()).error.code, 'usage');
    await fails(p, ['job', 'repo', 'downstream', j.id], new RegExp(`runs only in job ${j.id}'s own session or a human's terminal`), daemonEnv(p, other.id));
    await fails(p, ['job', 'repo', 'downstream', j.id], /own session/, daemonEnv(p, '_inbox'));
    await fails(p, ['job', 'repo', 'downstream', j.id], /not available in the office session/, daemonEnv(p, '_office'));
    await fails(p, ['job', 'repo', 'downstream', j.id], /FORGE_DAEMON_SCOPE is missing or invalid/, daemonEnv(p, 'bad scope!'));
    assert.deepEqual(snapshot(p, j.id), before);
    // The job's own session may run it, and it adds only verify-only repos.
    const r = await p.raw(['job', 'repo', 'downstream', j.id], daemonEnv(p, j.id));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(JSON.parse(r.stdout).added, ['app-a', 'app-b']);
    assert.ok(loadJob(p.root, j.id).repos.slice(1).every((m) => m.verifyOnly && m.branch === null));
    // Adding by name stays human-only, even in the job's own session.
    await fails(p, ['job', 'repo', 'add', j.id, 'app-a'], /daemon session may not change/, daemonEnv(p, j.id));
    // A hand edit that marks a downstream member edited gives it no push or PR: events say it was never promoted.
    updateJob(p.root, j.id, (x) => void (x.repos[1].verifyOnly = false));
    assert.equal(loadJob(p.root, j.id).repos[1].verifyOnly, false);
    await fails(p, ['pr', 'open', j.id], /repo app-a joined job .* as a downstream consumer and was never promoted/);
    // And the edited-looking member is still not a candidate source a session can widen: a rerun adds nothing new.
    const again = await p.raw(['job', 'repo', 'downstream', j.id], daemonEnv(p, j.id));
    assert.deepEqual(JSON.parse(again.stdout).added, []);
  });

  test('eval and closed jobs are refused', async () => {
    const p = await project();
    const e = await p.f('job', 'new', '--title', 'an eval');
    updateJob(p.root, e.id, (x) => void (x.kind = 'eval'));
    const snap = snapshot(p, e.id);
    await fails(p, ['job', 'repo', 'downstream', e.id], /eval job; its repos are fixed/);
    assert.deepEqual(snapshot(p, e.id), snap);
    for (const set of [['--stage', 'pr'], ['--stage', 'done', '--state', 'done'], ['--state', 'cancelled'], ['--state', 'failed']]) {
      const k = await p.f('job', 'new', '--title', `closed ${set.join(' ')}`);
      await p.f('job', 'set', k.id, ...set);
      const before = snapshot(p, k.id);
      await fails(p, ['job', 'repo', 'downstream', k.id], /repos can be added only before its PR/);
      assert.deepEqual(snapshot(p, k.id), before);
    }
  });
});
