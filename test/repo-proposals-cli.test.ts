// Repo proposals on the CLI (issue #180): `forge job repo propose` and `forge job human …
// approve-repos|reject-repos`, their refusals and what they log. Split from repo-proposals.test.ts,
// which keeps the pipeline and pure tests, so the two halves run in parallel.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadJob, updateJob } from '../lib/core/job/store.ts';
import type { TwoRepo } from './job-repos-fixture.ts';
import { daemonEnv, fails, project, read, snapshot } from './repo-proposals-fixture.ts';

describe('repo proposals: the CLI', { concurrency: 4 }, () => {
  test('propose validates against config and job state', async () => {
    const p = await project();
    const j = await p.f('job', 'new', '--title', 'needs lib');
    const before = snapshot(p, j.id);
    await fails(p, ['job', 'repo', 'propose', j.id, 'nope', '--reason', 'x'], /repo "nope" is not a repos entry/);
    await fails(p, ['job', 'repo', 'propose', j.id, 'lib'], /needs --reason/);
    await fails(p, ['job', 'repo', 'propose', j.id, 'lib', '--reason', '   '], /needs --reason/);
    await fails(p, ['job', 'repo', 'propose', j.id, 'lib', '--reason'], /needs --reason/);
    await fails(p, ['job', 'repo', 'propose', j.id, 'lib', '--reason', 'x'.repeat(201)], /longer than 200/);
    assert.deepEqual(snapshot(p, j.id), before);

    const r = await p.f('job', 'repo', 'propose', j.id, 'lib', '--reason', 'core gains `parse()`; app calls it');
    assert.deepEqual(r, { id: j.id, repo: 'lib', pending: ['lib'] });
    const proposed = p.events(j.id).filter((e) => e.type === 'repo-proposed');
    assert.deepEqual(proposed.map((e) => [e.repo, e.reason]), [['lib', 'core gains parse(); app calls it']]);
    const md = read(p, j.id, 'repo-proposals.md')!;
    assert.match(md, /^> Untrusted data/);
    assert.match(md, /^## lib · pending$/m);
    assert.match(md, /```text\ncore gains parse\(\); app calls it\n```/);
    const json = JSON.parse(read(p, j.id, 'repo-proposals.json')!);
    assert.deepEqual(json.proposals.map((x: any) => [x.repo, x.status, x.reason]), [['lib', 'pending', 'core gains parse(); app calls it']]);

    // A repeat for a pending repo and for a member: `already`, no new event.
    assert.deepEqual(await p.f('job', 'repo', 'propose', j.id, 'lib', '--reason', 'again'), { id: j.id, repo: 'lib', pending: ['lib'], already: 'pending' });
    const m = await p.f('job', 'new', '--title', 'has lib');
    await p.f('job', 'repo', 'add', m.id, 'lib');
    assert.deepEqual(await p.f('job', 'repo', 'propose', m.id, 'lib', '--reason', 'x'), { id: m.id, repo: 'lib', pending: [], already: 'member' });
    assert.equal(p.events(j.id).filter((e) => e.type === 'repo-proposed').length, 1);
    assert.equal(p.events(m.id).filter((e) => e.type === 'repo-proposed').length, 0);

    // An eval job, a job at stage pr or done, and a cancelled or failed one.
    const e = await p.f('job', 'new', '--title', 'an eval');
    updateJob(p.root, e.id, (x) => void (x.kind = 'eval'));
    await fails(p, ['job', 'repo', 'propose', e.id, 'lib', '--reason', 'x'], /eval job/);
    for (const set of [['--stage', 'pr'], ['--stage', 'done', '--state', 'done'], ['--state', 'cancelled'], ['--state', 'failed']]) {
      const k = await p.f('job', 'new', '--title', `closed ${set.join(' ')}`);
      await p.f('job', 'set', k.id, ...set);
      const snap = snapshot(p, k.id);
      await fails(p, ['job', 'repo', 'propose', k.id, 'lib', '--reason', 'x'], /repos can be proposed only before its PR/);
      assert.deepEqual(snapshot(p, k.id), snap);
    }
  });

  test("propose runs only in the job's own session", async () => {
    const p = await project();
    const j = await p.f('job', 'new', '--title', 'scoped');
    const other = await p.f('job', 'new', '--title', 'another');
    const before = snapshot(p, j.id);
    await fails(p, ['job', 'repo', 'propose', j.id, 'lib', '--reason', 'x'], new RegExp(`runs only in job ${j.id}'s own session`), daemonEnv(p, other.id));
    await fails(p, ['job', 'repo', 'propose', j.id, 'lib', '--reason', 'x'], /own session/, daemonEnv(p, '_inbox'));
    await fails(p, ['job', 'repo', 'propose', j.id, 'lib', '--reason', 'x'], /not available in the office session/, daemonEnv(p, '_office'));
    assert.deepEqual(snapshot(p, j.id), before);
    // Adding stays human-only, even in the job's own session.
    await fails(p, ['job', 'repo', 'add', j.id, 'lib'], /daemon session may not change/, daemonEnv(p, j.id));
    const r = await p.raw(['job', 'repo', 'propose', j.id, 'lib', '--reason', 'core changes'], daemonEnv(p, j.id));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(JSON.parse(r.stdout).pending, ['lib']);
  });

  test('approve adds the repos and is logged with its actor', async () => {
    const p = await project();
    const j = await p.f('job', 'new', '--title', 'two proposals');
    await p.f('job', 'repo', 'propose', j.id, 'lib', '--reason', 'core API');
    await p.f('job', 'repo', 'propose', j.id, 'tools', '--reason', 'cli flag');
    const r = await p.f('job', 'human', j.id, 'approve-repos', '--repo', 'lib', '--note', 'needed for core');
    assert.deepEqual({ ...r, ok: undefined }, { ok: undefined, id: j.id, decision: 'approve', repos: ['lib'], added: ['lib'], pending: ['tools'] });
    const job = loadJob(p.root, j.id);
    assert.equal(job.repos.length, 2);
    assert.equal(job.repos[1].repo, 'lib');
    assert.equal(job.repos[1].base, 'main');
    assert.equal(job.repos[1].verifyOnly, false);
    const human = p.events(j.id).filter((e) => e.type === 'human');
    assert.equal(human.length, 1);
    assert.equal(human[0].action, 'approve-repos');
    assert.deepEqual(human[0].repos, ['lib']);
    assert.equal(human[0].note, 'needed for core');
    assert.equal(typeof human[0].actor?.source, 'string');
    assert.match(read(p, j.id, 'repo-proposals.md')!, /^## lib · approved$/m);
    assert.match(read(p, j.id, 'repo-proposals.md')!, /^## tools · pending$/m);
    const audit = await p.f('job', 'audit', j.id);
    const row = audit.rows.find((x: any) => x.action === 'approve-repos');
    assert.deepEqual(row.actor, human[0].actor);
    assert.equal(row.detail, 'lib');
    assert.equal(row.note, 'needed for core');
  });

  test('decisions are refused in job sessions and leave nothing behind on failure', async () => {
    const p = await project();
    const j = await p.f('job', 'new', '--title', 'refusals');
    // Nothing pending yet.
    await fails(p, ['job', 'human', j.id, 'approve-repos', '--repo', 'lib'], /no pending repo proposals/);
    await fails(p, ['job', 'human', j.id, 'reject-repos', '--repo', 'lib'], /no pending repo proposals/);
    await p.f('job', 'repo', 'propose', j.id, 'lib', '--reason', 'core API');
    await p.f('job', 'repo', 'propose', j.id, 'tools', '--reason', 'cli flag');
    const before = snapshot(p, j.id);
    for (const action of ['approve-repos', 'reject-repos']) {
      await fails(p, ['job', 'human', j.id, action, '--repo', 'lib', '--note', 'x'], /a daemon session may not do/, daemonEnv(p, j.id));
      await fails(p, ['job', 'human', j.id, action, '--repo', 'lib', '--note', 'x'], /a daemon session may not do/, daemonEnv(p, '_inbox'));
      await fails(p, ['job', 'human', j.id, action, '--repo', 'nope'], /repo "nope" has no pending proposal/);
      await fails(p, ['job', 'human', j.id, action, '--repo', 'lib,nope'], /repo "nope" has no pending proposal/);
      // Never "every pending repo": the decider names the ones it saw.
      await fails(p, ['job', 'human', j.id, action, '--note', 'x'], new RegExp(`${action} needs --repo`));
      await fails(p, ['job', 'human', j.id, action, '--repo', ''], new RegExp(`${action} needs --repo`));
    }
    // tools has no clone: the whole approve fails before lib is added.
    await fails(p, ['job', 'human', j.id, 'approve-repos', '--repo', 'lib,tools'], /repo tools: no path in \.forge\/local\.yml/);
    await fails(p, ['job', 'human', j.id, 'approve', '--repo', 'lib'], /--repo is only for approve-repos and reject-repos/);
    assert.deepEqual(snapshot(p, j.id), before);
    assert.equal(loadJob(p.root, j.id).repos.length, 1);
  });

  test('reject is logged and blocks a re-proposal', async () => {
    const p = await project();
    const j = await p.f('job', 'new', '--title', 'rejected');
    await p.f('job', 'repo', 'propose', j.id, 'lib', '--reason', 'core API');
    const r = await p.f('job', 'human', j.id, 'reject-repos', '--repo', 'lib', '--note', 'do it in app');
    assert.deepEqual([r.decision, r.repos, r.added, r.pending], ['reject', ['lib'], [], []]);
    assert.equal(loadJob(p.root, j.id).repos.length, 1);
    const human = p.events(j.id).filter((e) => e.type === 'human');
    assert.deepEqual(human.map((e) => [e.action, e.repos, e.note]), [['reject-repos', ['lib'], 'do it in app']]);
    assert.ok(human[0].actor);
    const md = read(p, j.id, 'repo-proposals.md')!;
    assert.match(md, /^## lib · rejected$/m);
    assert.match(md, /Note:\n\n```text\ndo it in app\n```/);
    const before = snapshot(p, j.id);
    await fails(p, ['job', 'repo', 'propose', j.id, 'lib', '--reason', 'please'], /was rejected on job/);
    assert.deepEqual(snapshot(p, j.id), before);
  });
  test('a verify-only member is promoted on approval', async () => {
    const p = await project();
    const { id, libWt } = await verifyOnlyLib(p);
    const r = await p.f('job', 'repo', 'propose', id, 'lib', '--reason', 'app needs a lib change too');
    assert.deepEqual(r, { id, repo: 'lib', pending: ['lib'] }, 'a verify-only member is not already a member');
    assert.equal((await p.f('job', 'step', id)).rule, 'RP1');
    const d = await p.f('job', 'human', id, 'approve-repos', '--repo', 'lib');
    assert.deepEqual([d.added, d.pending], [['lib'], []]);
    const job = loadJob(p.root, id);
    assert.deepEqual([job.repos[1].verifyOnly, job.repos[1].branch, job.repos[1].worktree], [false, job.branch, null]);
    assert.equal(fs.existsSync(libWt), false, 'the detached worktree is removed');
    assert.deepEqual(p.events(id).filter((e) => e.type === 'job-repo-promoted').map((e) => e.repo), ['lib']);
    assert.equal(p.events(id).filter((e) => e.type === 'job-repo-added').length, 1, 'promoted, not added again');
    const step = await p.f('job', 'step', id);
    assert.deepEqual([step.rule, step.command], ['RP2', ['worktree', 'create', id]]);
    await p.f('worktree', 'create', id);
    assert.equal(p.git(libWt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), job.branch, 'checked out on the job branch');
    assert.deepEqual(await p.f('job', 'repo', 'propose', id, 'lib', '--reason', 'x'), { id, repo: 'lib', pending: [], already: 'member' });
  });

  test('promotion refuses a dirty or advanced verify-only worktree', async () => {
    const p = await project();
    const { id, libWt } = await verifyOnlyLib(p);
    await p.f('job', 'repo', 'propose', id, 'lib', '--reason', 'app needs a lib change too');
    const before = snapshot(p, id);
    fs.writeFileSync(path.join(libWt, 'stray.txt'), 'x\n');
    await fails(p, ['job', 'human', id, 'approve-repos', '--repo', 'lib'], /repo lib: its verify-only worktree .* has uncommitted or untracked changes/);
    assert.deepEqual(snapshot(p, id), before);
    fs.rmSync(path.join(libWt, 'stray.txt'));
    p.commit(libWt, { 'lib.txt': 'work\n' }, 'work in a verify-only checkout');
    await fails(p, ['job', 'human', id, 'approve-repos', '--repo', 'lib'], /repo lib: its verify-only worktree .* has a HEAD that is not on origin\/main/);
    assert.deepEqual(snapshot(p, id), before);
    const job = loadJob(p.root, id);
    assert.equal(job.repos[1].verifyOnly, true);
    assert.ok(fs.existsSync(libWt));
  });

  test('rejecting a verify-only member keeps it verify-only', async () => {
    const p = await project();
    const { id, libWt } = await verifyOnlyLib(p);
    await p.f('job', 'repo', 'propose', id, 'lib', '--reason', 'app needs a lib change too');
    const d = await p.f('job', 'human', id, 'reject-repos', '--repo', 'lib');
    assert.deepEqual([d.added, d.pending], [[], []]);
    const job = loadJob(p.root, id);
    assert.deepEqual([job.repos[1].verifyOnly, job.repos[1].branch, job.repos[1].worktree], [true, null, libWt]);
    assert.ok(fs.existsSync(libWt));
    assert.equal(p.events(id).filter((e) => e.type === 'job-repo-promoted').length, 0);
    assert.notEqual((await p.f('job', 'step', id)).rule, 'RP1');
  });
});

/** A job in build with lib added verify-only and its detached worktree created. */
async function verifyOnlyLib(p: TwoRepo) {
  const j = await p.f('job', 'new', '--title', `verify-only lib ${Math.random().toString(36).slice(2, 8)}`);
  await p.f('job', 'repo', 'add', '--verify-only', j.id, 'lib');
  await p.f('worktree', 'create', j.id);
  await p.f('job', 'set', j.id, '--stage', 'build');
  const libWt = path.join(p.parent, 'lib.worktrees', j.id);
  assert.ok(fs.existsSync(libWt));
  return { id: j.id as string, libWt };
}
