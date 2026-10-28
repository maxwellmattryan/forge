// The CLI passes the gh adapter, so `forge pr sync` still reads the PR through `gh`. Spawned tests,
// one per command path: fakeGh goes in the child's env only, never in this process's.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addOrigin, fakeGh, forgeAsync, ghPr, tempRepo } from '../../helpers.ts';
import { TRUST_ENV, loadConfig, trustDigest } from '#core/config/load.ts';
import { listRequests } from '#core/job/requests.ts';
import { EVENT_SCHEMA_VERSION } from '#core/job/schema.ts';
import { createJob, loadJob, readEvents, setJob } from '#core/job/store.ts';
import { jobFiles } from '#core/paths.ts';

const VIEW_FIELDS = 'number,url,state,isDraft,isCrossRepository,headRefName,baseRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,mergedAt';

/** A Forge-initialised scratch repo (tracker o/r, `extra` config on top) with one job at PR #7. */
async function prRepo(name: string, extra: Record<string, unknown> = {}) {
  const repo = tempRepo();
  const answers = path.join(repo.dir, '..', `answers-${path.basename(repo.dir)}.json`);
  fs.writeFileSync(answers, JSON.stringify({ tracker: { github: { repo: 'o/r' } }, ...extra }));
  const init = await forgeAsync(repo.dir, ['init', 'write', '--answers', answers]);
  fs.rmSync(answers, { force: true });
  assert.equal(init.status, 0, init.stderr);
  const id = createJob(repo.dir, loadConfig(repo.dir).config, { title: name }).id;
  setJob(repo.dir, id, { owned: { pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' } } });
  const head = repo.git('rev-parse', 'HEAD').toString().trim();
  return { repo, id, head };
}

test('forge pr sync reads the PR through gh', { skip: process.platform === 'win32' }, async () => {
  const { repo, id } = await prRepo('sync through gh');
  const gh = fakeGh({
    'pr view': JSON.stringify(ghPr({ statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] })),
    'api graphql': JSON.stringify({ data: { repository: { pullRequest: {} } } }),
  });
  try {
    const r = await forgeAsync(repo.dir, ['pr', 'sync', id], gh.env);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const out = JSON.parse(r.stdout);
    assert.deepEqual([out.pr.state, out.pr.checks.state], ['OPEN', 'passing']);
    assert.ok(
      gh.calls().some((c) => c.args.join(' ') === `pr view 7 -R o/r --json ${VIEW_FIELDS}`),
      JSON.stringify(gh.calls().map((c) => c.args.slice(0, 4))),
    );
  } finally {
    fs.rmSync(gh.dir, { recursive: true, force: true });
    repo.cleanup();
  }
});

test('forge pr rerun re-runs through gh run rerun --failed and logs ci-rerun', { skip: process.platform === 'win32' }, async () => {
  const { repo, id } = await prRepo('rerun through gh');
  const sha = 'b'.repeat(40);
  const checks = { state: 'failing', passing: 0, failing: 1, pending: 0 };
  setJob(repo.dir, id, { stage: 'pr', state: 'waiting', waitingOn: 'pr-review', owned: { pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', headOid: sha, checks } } });
  const gh = fakeGh({
    'pr view': JSON.stringify(ghPr({ headRefOid: sha, statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/101/job/201' }] })),
    'run view': JSON.stringify({ headSha: sha, status: 'completed', conclusion: 'failure' }),
    'run rerun': '',
  });
  const reruns = () => gh.calls().filter((c) => c.args[0] === 'run' && c.args[1] === 'rerun');
  try {
    const r = await forgeAsync(repo.dir, ['pr', 'rerun', id], gh.env);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(JSON.parse(r.stdout), { action: 'rerun', id, head: sha, runs: ['101'], jobs: ['201'], checks: ['test'] });
    assert.deepEqual(reruns().map((c) => c.args), [['run', 'rerun', '101', '--failed', '-R', 'o/r']]);
    const e = readEvents(repo.dir, id).find((x) => x.type === 'ci-rerun');
    assert.deepEqual([e?.head, e?.runs, e?.jobs, e?.actor?.source], [sha, ['101'], ['201'], 'env'], JSON.stringify(e));
    assert.deepEqual([loadJob(repo.dir, id).stage, loadJob(repo.dir, id).waitingOn], ['pr', 'pr-review']);
    // Not parked on pr-review: refused, with no gh call.
    setJob(repo.dir, id, { stage: 'build', state: 'running', waitingOn: null });
    const calls = gh.calls().length;
    const refused = await forgeAsync(repo.dir, ['pr', 'rerun', id], gh.env);
    assert.equal(refused.status, 1, refused.stderr + refused.stdout);
    assert.match(refused.stderr + refused.stdout, /is not waiting on pr-review; nothing re-run/);
    assert.equal(gh.calls().length, calls);
  } finally {
    fs.rmSync(gh.dir, { recursive: true, force: true });
    repo.cleanup();
  }
});

test('forge pr merge refuses --now and a broken scope under the daemon, with no gh merge call',{ skip: process.platform === 'win32' }, async () => {
  const { repo, id } = await prRepo('merge under the daemon');
  const gh = fakeGh({ 'pr view': JSON.stringify(ghPr({ statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] })), 'api graphql': '{"data":{}}', 'pr merge': '' });
  try {
    const daemon = (scope: string) => ({ ...gh.env, FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(repo.dir), FORGE_DAEMON_SCOPE: scope });
    const now = await forgeAsync(repo.dir, ['pr', 'merge', id, '--now'], daemon(id));
    assert.equal(now.status, 1, now.stderr + now.stdout);
    assert.match(now.stderr + now.stdout, /--now is a human's override/);
    const broken = await forgeAsync(repo.dir, ['pr', 'merge', id], daemon('../not-a-scope'));
    assert.equal(broken.status, 1, broken.stderr + broken.stdout);
    assert.match(broken.stderr + broken.stdout, /FORGE_DAEMON_SCOPE is missing or invalid/);
    assert.deepEqual(gh.calls().filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge'), []);
  } finally {
    fs.rmSync(gh.dir, { recursive: true, force: true });
    repo.cleanup();
  }
});

test('forge sync continues a deferred merge through mergePr', { skip: process.platform === 'win32' }, async () => {
  const { repo, id, head } = await prRepo('deferred merge', { merge: { auto: true } });
  setJob(repo.dir, id, { stage: 'pr', state: 'waiting', waitingOn: 'pr-review' });
  // A person asked for rework after the deferral, and the job went back to build: sync must not finish its merge.
  const stale = createJob(repo.dir, loadConfig(repo.dir).config, { title: 'stale deferral' }).id;
  setJob(repo.dir, stale, { owned: { pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' } } });
  // The gate re-reads the base from the push remote.
  addOrigin(repo);
  const gh = fakeGh({
    'pr view': JSON.stringify(ghPr({ headRefOid: head, statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] })),
    'api graphql': JSON.stringify({ data: { repository: { pullRequest: {} } } }),
    'pr merge': '',
  });
  try {
    // Forge pushed well past the settling window, the approver's APPROVE covers this head, and the last merge attempt deferred.
    const line = (type: string, ts: string, data: Record<string, unknown> = {}) => `${JSON.stringify({ v: EVENT_SCHEMA_VERSION, ts, type, ...data })}\n`;
    const now = new Date().toISOString();
    const events =
      line('pr-opened', new Date(Date.now() - 30 * 60_000).toISOString(), { number: 7 }) +
      line('decision', now, { decision: 'APPROVE', reason: null, autoMerge: true, head }) +
      line('pr-merge-deferred', now, { number: 7, checks: 'pending' });
    // Forge reads the CLI copy's events, so every copy gets them.
    for (const f of jobFiles(repo.dir, id, 'events.jsonl')) fs.appendFileSync(f, events);
    const rework = line('human', now, { action: 'rework', actor: { login: 'al', source: 'env' } });
    for (const f of jobFiles(repo.dir, stale, 'events.jsonl')) fs.appendFileSync(f, events + rework);
    setJob(repo.dir, stale, { stage: 'build', state: 'running', waitingOn: null });
    const r = await forgeAsync(repo.dir, ['sync'], gh.env);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const results = JSON.parse(r.stdout).results;
    const row = results.find((x: any) => x.id === id);
    assert.equal(row?.mergeDeferred, true, JSON.stringify(row));
    assert.equal(row.merge?.action, 'merged', JSON.stringify(row));
    const staleRow = results.find((x: any) => x.id === stale);
    assert.equal(staleRow?.mergeDeferred, false, JSON.stringify(staleRow));
    assert.ok(!('merge' in staleRow), JSON.stringify(staleRow));
    const merges = gh.calls().filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
    assert.equal(merges.length, 1, JSON.stringify(gh.calls().map((c) => c.args.slice(0, 3))));
    assert.ok(merges[0].args.includes('--match-head-commit') && merges[0].args.includes(head), merges[0].args.join(' '));
    const merged = readEvents(repo.dir, id).find((e) => e.type === 'pr-merged');
    assert.deepEqual([merged?.via, merged?.actor], ['sync', { login: 'forge-test', source: 'env' }], JSON.stringify(merged));
    assert.ok(merged && !('scope' in merged), JSON.stringify(merged));
  } finally {
    fs.rmSync(gh.dir, { recursive: true, force: true });
    repo.cleanup();
  }
});

test("forge sync scores a mandate's merged job whatever scoring.sample says", { skip: process.platform === 'win32' }, async () => {
  const { repo } = await prRepo('an open PR');
  const gh = fakeGh({
    'pr view': JSON.stringify(ghPr({ statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] })),
    'api graphql': JSON.stringify({ data: { repository: { pullRequest: {} } } }),
    'pr diff': 'diff --git a/a.txt b/a.txt\n+a\n',
  });
  try {
    const m = await forgeAsync(repo.dir, ['mandate', 'new', 'm1', '--title', 'M', '--milestones', 'M1']);
    assert.equal(m.status, 0, m.stderr + m.stdout);
    const config = loadConfig(repo.dir).config;
    assert.equal(config.scoring.sample, 0, 'scoring.sample is at its default');
    const mergedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const done = (title: string, mandate: string | null, number: number) => {
      const id = createJob(repo.dir, config, { title, mandate }).id;
      setJob(repo.dir, id, { stage: 'done', state: 'done', owned: { pr: { number, url: `https://github.com/o/r/pull/${number}`, state: 'MERGED', mergedAt } } });
      return id;
    };
    const inMandate = done('in the mandate', 'm1', 11);
    const outside = done('outside it', null, 12);
    const r = await forgeAsync(repo.dir, ['sync'], gh.env);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const queued = JSON.parse(r.stdout).scoring?.queued ?? [];
    assert.ok(queued.includes(inMandate), r.stdout);
    assert.ok(!queued.includes(outside), r.stdout);
    assert.equal(loadJob(repo.dir, inMandate).score?.status, 'queued');
  } finally {
    fs.rmSync(gh.dir, { recursive: true, force: true });
    repo.cleanup();
  }
});

test('forge sync holds a deferred merge in the pass that queues its pr-feedback gate', { skip: process.platform === 'win32' }, async () => {
  const { repo, id, head } = await prRepo('feedback before the merge', { merge: { auto: true }, foreman: { enabled: true, decides: ['pr-feedback'], reserved: [] } });
  setJob(repo.dir, id, { stage: 'pr', state: 'waiting', waitingOn: 'pr-review' });
  addOrigin(repo);
  // A collaborator's unresolved thread and no change request: only the gate request can hold the merge.
  const thread = { isResolved: false, isOutdated: false, path: 'src.txt', line: 1, comments: { nodes: [{ author: { login: 'bob' }, authorAssociation: 'MEMBER', body: 'this breaks the parser', createdAt: '2026-10-24T10:00:00Z', url: 'https://github.com/o/r/pull/7#discussion_r1' }] } };
  const gh = fakeGh({
    'pr view': JSON.stringify(ghPr({ headRefOid: head, statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] })),
    'api graphql': JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [thread] } } } } }),
    'pr merge': '',
  });
  try {
    const line = (type: string, ts: string, data: Record<string, unknown> = {}) => `${JSON.stringify({ v: EVENT_SCHEMA_VERSION, ts, type, ...data })}\n`;
    const now = new Date().toISOString();
    const events =
      line('pr-opened', new Date(Date.now() - 30 * 60_000).toISOString(), { number: 7 }) +
      line('decision', now, { decision: 'APPROVE', reason: null, autoMerge: true, head }) +
      line('pr-merge-deferred', now, { number: 7, checks: 'pending' });
    for (const f of jobFiles(repo.dir, id, 'events.jsonl')) fs.appendFileSync(f, events);
    const r = await forgeAsync(repo.dir, ['sync'], gh.env);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const row = JSON.parse(r.stdout).results.find((x: any) => x.id === id);
    assert.deepEqual([row?.mergeDeferred, 'merge' in row], [false, false], JSON.stringify(row));
    assert.deepEqual(gh.calls().filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge'), []);
    const gates = listRequests(repo.dir).filter((q) => q.type === 'gate' && q.job === id);
    assert.deepEqual(gates.map((q) => [q.status, q.args.gate]), [['pending', 'pr-feedback']], JSON.stringify(gates));
    // Nothing else replaced the decision: the job still waits at pr, with no change request counted.
    const job = loadJob(repo.dir, id);
    assert.deepEqual([job.stage, job.state, job.waitingOn, job.pr?.changesRequested, job.pr?.unresolvedThreads], ['pr', 'waiting', 'pr-review', 0, 1]);
  } finally {
    fs.rmSync(gh.dir, { recursive: true, force: true });
    repo.cleanup();
  }
});
