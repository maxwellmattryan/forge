// Repo proposals (issue #180): an agent proposes a member repo with `forge job repo propose`, the job
// parks (step RP1), and a human (or the foreman) approves or rejects it with `forge job human …
// approve-repos|reject-repos`. Scratch repos only (job-repos-fixture.ts: root `app`, member `lib`).
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { twoRepo } from './job-repos-fixture.ts';
import type { TwoRepo } from './job-repos-fixture.ts';
import { TRUST_ENV, trustDigest } from '../lib/config.ts';
import { loadJob, updateJob } from '../lib/jobs.ts';
import { pendingRepoProposals, repoProposals } from '../lib/repo-proposals.ts';
import { ev } from './step-fixture.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

/** The two-repo project plus a `tools` repos entry with no clone, whose clone check always fails. */
async function project(): Promise<TwoRepo> {
  const p = await twoRepo();
  cleanups.push(p.cleanup);
  p.config((c) => c.repos.push({ name: 'tools', remote: 'https://example.com/tools.git', defaultBranch: 'main' }));
  return p;
}

const dir = (p: TwoRepo, id: string) => path.join(p.root, '.forge', 'jobs', id);
const read = (p: TwoRepo, id: string, f: string) => (fs.existsSync(path.join(dir(p, id), f)) ? fs.readFileSync(path.join(dir(p, id), f), 'utf8') : null);
/** job.json, events.jsonl and both proposal files, to prove a refusal wrote nothing. */
const snapshot = (p: TwoRepo, id: string) => ['job.json', 'events.jsonl', 'repo-proposals.md', 'repo-proposals.json'].map((f) => read(p, id, f));

async function fails(p: TwoRepo, args: string[], re: RegExp, env: NodeJS.ProcessEnv = {}) {
  const r = await p.raw(args, env);
  assert.equal(r.status, 1, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr + r.stdout, re);
}

const daemonEnv = (p: TwoRepo, scope: string) => ({ FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(p.root), FORGE_DAEMON_SCOPE: scope });

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
    await fails(p, ['job', 'human', j.id, 'approve-repos'], /no pending repo proposals/);
    await fails(p, ['job', 'human', j.id, 'reject-repos'], /no pending repo proposals/);
    await p.f('job', 'repo', 'propose', j.id, 'lib', '--reason', 'core API');
    await p.f('job', 'repo', 'propose', j.id, 'tools', '--reason', 'cli flag');
    const before = snapshot(p, j.id);
    for (const action of ['approve-repos', 'reject-repos']) {
      await fails(p, ['job', 'human', j.id, action, '--note', 'x'], /a daemon session may not do/, daemonEnv(p, j.id));
      await fails(p, ['job', 'human', j.id, action, '--note', 'x'], /a daemon session may not do/, daemonEnv(p, '_inbox'));
      await fails(p, ['job', 'human', j.id, action, '--repo', 'nope'], /repo "nope" has no pending proposal/);
    }
    // tools has no clone: the whole approve fails before lib is added.
    await fails(p, ['job', 'human', j.id, 'approve-repos'], /repo tools: no path in \.forge\/local\.yml/);
    await fails(p, ['job', 'human', j.id, 'approve', '--repo', 'lib'], /--repo is only for approve-repos and reject-repos/);
    assert.deepEqual(snapshot(p, j.id), before);
    assert.equal(loadJob(p.root, j.id).repos.length, 1);
  });

  test('reject is logged and blocks a re-proposal', async () => {
    const p = await project();
    const j = await p.f('job', 'new', '--title', 'rejected');
    await p.f('job', 'repo', 'propose', j.id, 'lib', '--reason', 'core API');
    const r = await p.f('job', 'human', j.id, 'reject-repos', '--note', 'do it in app');
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
});

describe('repo proposals: the pipeline', () => {
  test("a spec that changes a library's API proposes its repo and waits for approval", async () => {
    const p = await project();
    p.config((c) => {
      c.components = [
        { name: 'core', repo: 'lib', path: '.', kind: 'library' },
        { name: 'app', repo: null, path: '.', kind: 'service', dependsOn: [{ component: 'core', type: 'build' }] },
      ];
    });
    const j = await p.f('job', 'new', '--title', 'app needs a core API');
    await p.f('job', 'set', j.id, '--stage', 'spec', '--state', 'running');
    fs.writeFileSync(path.join(dir(p, j.id), 'spec.md'), '# Spec\n\nSize: S\n\n## Approach\ncore gains `parse(text)` in lib; app calls it.\n');
    await p.f('job', 'agent', j.id, 'start', '--role', 'spec-writer');
    await p.f('job', 'agent', j.id, 'end', '--role', 'spec-writer', '--status', 'done');
    await p.f('job', 'repo', 'propose', j.id, 'lib', '--reason', "core's parse() API changes; app depends on core (build)");
    const park = await p.f('job', 'step', j.id);
    assert.equal(park.rule, 'RP1');
    assert.deepEqual(park.command, ['job', 'set', j.id, '--state', 'waiting', '--waiting-on', 'human', '--reason', 'repo proposal: lib']);
    await p.f(...park.command);
    const waiting = loadJob(p.root, j.id);
    assert.deepEqual([waiting.state, waiting.waitingOn, waiting.reason], ['waiting', 'human', 'repo proposal: lib']);
    assert.match((await p.f('job', 'step', j.id)).tell, /proposes repos \(repo proposal: lib\): .*repo-proposals\.md/);
    await p.f('job', 'human', j.id, 'approve-repos', '--note', 'yes');
    await p.f('job', 'set', j.id, '--state', 'running');
    const create = await p.f('job', 'step', j.id);
    assert.equal(create.rule, 'RP2');
    assert.deepEqual(create.command, ['worktree', 'create', j.id]);
    await p.f(...create.command);
    assert.ok(fs.existsSync(path.join(p.parent, 'lib.worktrees', j.id)));
    assert.notEqual((await p.f('job', 'step', j.id)).rule, 'RP2');
  });

  test('repoProposals reads only well-formed names and decisions after the proposal', () => {
    const job = { repos: [] } as any;
    const events = [
      ev('repo-proposed', 1, { repo: 'lib', reason: 'a\nb`c' }),
      ev('repo-proposed', 2, { repo: '../evil', reason: 'x' }),
      ev('repo-proposed', 3, { repo: 'tools', reason: 't' }),
      ev('human', 4, { action: 'reject-repos', repos: ['tools', '../evil'], note: 'no', actor: { login: 'a', source: 'gh' } }),
      ev('repo-proposed', 5, { repo: 'lib', reason: 'again' }),
    ];
    const rows = repoProposals(job, events as any);
    assert.deepEqual(rows.map((r) => [r.repo, r.status, r.reason]), [['lib', 'pending', 'again'], ['tools', 'rejected', 't']]);
    assert.deepEqual(rows[1].actor, { login: 'a', source: 'gh' });
    assert.deepEqual(pendingRepoProposals(job, events as any).map((r) => r.repo), ['lib']);
    assert.deepEqual(pendingRepoProposals({ repos: [{ repo: null }, { repo: 'lib' }] } as any, events as any), []);
    assert.equal(repoProposals(job, [ev('repo-proposed', 1, { repo: 'lib', reason: 'a\nb`c' })] as any)[0].reason, 'abc');
  });
});
