// The CLI passes the gh adapter, so `forge pr sync` still reads the PR through `gh`. Spawned tests,
// one per command path: fakeGh goes in the child's env only, never in this process's.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addOrigin, fakeGh, forgeAsync, ghPr, tempRepo } from '../../helpers.ts';
import { TRUST_ENV, loadConfig, trustDigest } from '#core/config/load.ts';
import { EVENT_SCHEMA_VERSION } from '#core/job/schema.ts';
import { createJob, setJob } from '#core/job/store.ts';
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

test('forge pr merge refuses --now and a broken scope under the daemon, with no gh merge call', { skip: process.platform === 'win32' }, async () => {
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
    const r = await forgeAsync(repo.dir, ['sync'], gh.env);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const row = JSON.parse(r.stdout).results.find((x: any) => x.id === id);
    assert.equal(row?.mergeDeferred, true, JSON.stringify(row));
    assert.equal(row.merge?.action, 'merged', JSON.stringify(row));
    const merges = gh.calls().filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
    assert.equal(merges.length, 1, JSON.stringify(gh.calls().map((c) => c.args.slice(0, 3))));
    assert.ok(merges[0].args.includes('--match-head-commit') && merges[0].args.includes(head), merges[0].args.join(' '));
  } finally {
    fs.rmSync(gh.dir, { recursive: true, force: true });
    repo.cleanup();
  }
});
