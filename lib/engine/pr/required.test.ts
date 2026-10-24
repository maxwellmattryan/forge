// Required checks: evaluateRequired decides each requirement from the observations with its exact
// name, bound to its source, and requirementsFor picks config for the root, protection otherwise;
// a linked job's merge carries each PR's own verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addOrigin, ghPr, memoryGitHub, parkedAt, tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { logEvent, updateJob } from '#core/job/store.ts';
import type { BranchRules, CheckObservation, HeadChecks } from '#integrations/github/types.ts';
import { mergePr } from './merge.ts';
import { evaluateRequired, requiredError, requiredFor, requirementsFor } from './required.ts';
import type { Requirement, RequiredSummary } from './required.ts';

const CI = '.github/workflows/ci.yml';
const ACTIONS = { appId: 15368, app: 'github-actions', workflow: CI };

/** A check run from `src` (GitHub Actions' ci.yml by default). */
const run = (name: string, state: string, src: Partial<CheckObservation> = {}): CheckObservation => ({ name, kind: 'check-run', ...ACTIONS, creator: null, state, at: '2026-10-24T10:00:00Z', ...src });
/** A commit status posted by `creator`. */
const status = (name: string, state: string, creator = 'alice'): CheckObservation => ({ name, kind: 'status', appId: null, app: null, workflow: null, creator, state, at: '2026-10-24T10:00:00Z' });
const req = (name: string, bind: Partial<Requirement> = {}): Requirement => ({ name, appId: null, app: null, workflow: null, creator: null, ...bind });
const head = (checks: CheckObservation[], complete = true): HeadChecks => ({ checks, complete });

test('evaluateRequired', () => {
  const rows: [string, Requirement[], HeadChecks, RequiredSummary['state'], RequiredSummary['blocking']][] = [
    ['two required, one unreported', [req('test'), req('slow')], head([run('test', 'SUCCESS')]), 'pending', [{ name: 'slow', why: 'missing' }]],
    ['a required FAILURE', [req('test')], head([run('test', 'FAILURE')]), 'failing', [{ name: 'test', why: 'failing' }]],
    ['a required SKIPPED', [req('test')], head([run('test', 'SKIPPED')]), 'failing', [{ name: 'test', why: 'skipped' }]],
    ['a required NEUTRAL', [req('test')], head([run('test', 'NEUTRAL')]), 'failing', [{ name: 'test', why: 'neutral' }]],
    ['bound to app X, only a passing run from app Y', [req('test', { app: 'x-ci' })], head([run('test', 'SUCCESS')]), 'pending', [{ name: 'test', why: 'foreign' }]],
    ['bound to app X, a failing run from app Y', [req('test', { app: 'x-ci' })], head([run('test', 'FAILURE')]), 'failing', [{ name: 'test', why: 'failing' }]],
    ['bound to app X, a run from app Y in progress', [req('test', { app: 'x-ci' })], head([run('test', 'IN_PROGRESS')]), 'pending', [{ name: 'test', why: 'pending' }]],
    ['unbound, only a passing commit status', [req('test')], head([status('test', 'SUCCESS')]), 'pending', [{ name: 'test', why: 'status' }]],
    ['unbound, a passing status beside a passing check run', [req('test')], head([status('test', 'SUCCESS'), run('test', 'SUCCESS')]), 'passing', []],
    ['unbound, passing runs from two workflow files', [req('test')], head([run('test', 'SUCCESS'), run('test', 'SUCCESS', { workflow: '.github/workflows/evil.yml' })]), 'failing', [{ name: 'test', why: 'ambiguous' }]],
    ['same source, an older FAILURE and a newer SUCCESS', [req('test')], head([run('test', 'FAILURE', { at: '2026-10-24T09:00:00Z' }), run('test', 'SUCCESS', { at: '2026-10-24T11:00:00Z' })]), 'passing', []],
    ['same source, an older SUCCESS and a newer FAILURE', [req('test')], head([run('test', 'SUCCESS', { at: '2026-10-24T09:00:00Z' }), run('test', 'FAILURE', { at: '2026-10-24T11:00:00Z' })]), 'failing', [{ name: 'test', why: 'failing' }]],
    ['creator-bound, a status by that login (any case)', [req('ext', { creator: 'Alice' })], head([status('ext', 'SUCCESS', 'alice')]), 'passing', []],
    ['creator-bound, a status by another login only', [req('ext', { creator: 'alice' })], head([status('ext', 'SUCCESS', 'mallory')]), 'pending', [{ name: 'ext', why: 'foreign' }]],
    ['creator-bound, a check run of that name only', [req('ext', { creator: 'alice' })], head([run('ext', 'SUCCESS')]), 'pending', [{ name: 'ext', why: 'foreign' }]],
    ['workflow-bound, a run from another workflow path only', [req('test', { workflow: CI })], head([run('test', 'SUCCESS', { workflow: '.github/workflows/evil.yml' })]), 'pending', [{ name: 'test', why: 'foreign' }]],
    ['workflow-bound, the same name from its workflow and another', [req('test', { workflow: CI })], head([run('test', 'SUCCESS'), run('test', 'SUCCESS', { workflow: '.github/workflows/evil.yml' })]), 'passing', []],
    ['appId-bound (protection), a run from that app', [req('test', { appId: 15368 })], head([run('test', 'SUCCESS')]), 'passing', []],
    ['appId-bound (protection), a run from another app', [req('test', { appId: 99 })], head([run('test', 'SUCCESS')]), 'pending', [{ name: 'test', why: 'foreign' }]],
    ['a truncated read with everything passing', [req('test')], head([run('test', 'SUCCESS')], false), 'pending', [{ name: 'test', why: 'incomplete' }]],
    ['a failing check beside a missing one', [req('test'), req('slow')], head([run('test', 'TIMED_OUT')]), 'failing', [{ name: 'test', why: 'failing' }, { name: 'slow', why: 'missing' }]],
    ['a name that only differs in case is not the check', [req('test')], head([run('Test', 'SUCCESS')]), 'pending', [{ name: 'test', why: 'missing' }]],
  ];
  for (const [name, reqs, h, state, blocking] of rows) assert.deepEqual(evaluateRequired(reqs, h), { state, blocking }, name);
  // At most 10 blocking entries, whatever the number of requirements.
  const many = Array.from({ length: 12 }, (_, i) => req(`c${i}`));
  assert.equal(evaluateRequired(many, head([])).blocking.length, 10);
});

test('requirements: config for the root, protection for members', () => {
  const config = defaults();
  config.merge.requiredChecks = ['test', { name: 'slow', workflow: CI }];
  const protection: BranchRules = { status: 'read', checks: [{ name: 'build', appId: 15368 }, { name: 'lint', appId: null }], reviews: 1 };
  let reads = 0;
  const rules = (r: BranchRules) => () => {
    reads++;
    return r;
  };

  const root = requirementsFor(config, null, 'main', rules(protection));
  assert.deepEqual(root, { source: 'config', reqs: [req('test'), req('slow', { workflow: CI })] });
  assert.equal(reads, 0, 'the key set: protection is not read for the root');

  const member = requirementsFor(config, 'lib', 'main', rules(protection));
  assert.deepEqual(member, { source: 'protection', reqs: [req('build', { appId: 15368 }), req('lint')] }, "a member: its own protection, never the root's key");
  assert.equal(reads, 1);

  const empty = defaults();
  assert.deepEqual(requirementsFor(empty, null, 'main', rules(protection)).source, 'protection');
  assert.deepEqual(requirementsFor(empty, null, 'main', rules({ status: 'read', checks: [], reviews: 0 })), { source: 'none', reqs: [] });
  const unavailable = requirementsFor(empty, 'lib', 'release/1.0', rules({ status: 'unavailable', checks: [], reviews: null, error: 'HTTP 403: Resource not accessible' }));
  assert.deepEqual([unavailable.source, unavailable.reqs], ['unavailable', []]);
  assert.equal(unavailable.note, 'branch protection of release/1.0 could not be read (HTTP 403: Resource not accessible); deciding on the CI rollup alone');
});

test('requiredFor: an invalid merge.requiredChecks fails the root PR, and a member PR never reads it', () => {
  const sha = 'a'.repeat(40);
  const github = memoryGitHub();
  const rootReads = () => github.calls.filter((c) => (c.op === 'branchRules' || c.op === 'headChecks') && c.slug === 'o/r').length;
  github.setBranchRules('main', { status: 'read', checks: [{ name: 'build', appId: null }], reviews: 0 }, 'o/lib');
  github.setHeadChecks(sha, { repository: { object: { checkSuites: { pageInfo: { hasNextPage: false }, nodes: [] }, status: { contexts: [] } } } }, 'o/lib');
  // Entries `loadConfig` lets through: each one's problem, and the first entry that a tolerant read would keep alone.
  const lists: [string, unknown, RegExp][] = [
    ['a workflow outside .github/workflows/', ['test', { name: 'slow', workflow: 'ci.yml' }], /workflow must be a file under \.github\/workflows\//],
    ['an app that is not a slug', [{ name: 'slow', app: 'GitHub-Actions' }], /app must be a GitHub App slug/],
    ['a value that is not a list', 'slow', /must be a list/],
    ['a name listed twice', ['slow', 'slow'], /more than once/],
  ];
  for (const [name, list, problem] of lists) {
    const config = defaults();
    config.merge.requiredChecks = list as never;
    const root = requiredFor(github, '/', { repo: null, slug: 'o/r', base: 'main', headOid: sha }, config, new Map());
    assert.deepEqual([root.source, root.state, root.blocking], ['config', 'failing', []], name);
    assert.match(root.note ?? '', /^merge\.requiredChecks in \.forge\/config\.yml is invalid, so Forge refuses to merge: /, name);
    assert.match(root.note ?? '', problem, name);
    assert.equal(requiredError(root), `${root.note}; fix it (forge config validate), or a human merges anyway with forge pr merge --now in their own terminal`, name);
    assert.equal(rootReads(), 0, `${name}: nothing is read for the root`);

    const member = requiredFor(github, '/', { repo: 'lib', slug: 'o/lib', base: 'main', headOid: sha }, config, new Map());
    assert.deepEqual([member.source, member.state, member.blocking], ['protection', 'pending', [{ name: 'build', why: 'missing' }]], `${name}: a member uses its own protection`);
  }
});

/** HEAD_CHECKS_QUERY's `.data`: one GitHub Actions ci.yml suite whose runs conclude as `runs` says, no commit statuses. */
const headData = (runs: Record<string, string>) => {
  const nodes = Object.entries(runs).map(([name, conclusion]) => ({ name, status: 'COMPLETED', conclusion, startedAt: '2026-10-24T10:00:00Z', completedAt: '2026-10-24T10:01:00Z' }));
  const suite = { app: { databaseId: 15368, slug: 'github-actions' }, workflowRun: { file: { path: CI } }, checkRuns: { pageInfo: { hasNextPage: false }, nodes } };
  return { repository: { object: { checkSuites: { pageInfo: { hasNextPage: false }, nodes: [suite] }, status: { contexts: [] } } } };
};

test("mergePr on a linked job: the root PR decides on merge.requiredChecks, the member PR on its own repo's protection at its own base and head", async () => {
  const app = tempRepo();
  const lib = tempRepo();
  try {
    addOrigin(app);
    const libBare = addOrigin(lib);
    // The member PR targets develop, the root's main: a base taken from the root would read another branch.
    lib.git('push', '-q', 'origin', 'main:develop');
    const work = (repo: ReturnType<typeof tempRepo>, file: string): string => {
      repo.git('checkout', '-q', '-b', 'feat');
      fs.writeFileSync(path.join(repo.dir, file), `${file}\n`);
      repo.git('add', '-A');
      repo.git('commit', '-qm', file);
      const sha = repo.git('rev-parse', 'HEAD').toString().trim();
      repo.git('checkout', '-q', 'main');
      return sha;
    };
    const head = work(app, 'src.txt');
    const libHead = work(lib, 'lib.txt');
    const config = defaults();
    config.tracker.github.repo = 'o/r';
    config.merge.auto = true;
    config.merge.requiredChecks = ['test'];
    config.repos = [{ name: 'lib', remote: libBare, defaultBranch: 'main', tracker: { kind: 'github', repo: 'o/lib' } }];
    const id = parkedAt(app.dir, 'pr-review', { config, pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', pushedSha: head } }).id;
    fs.writeFileSync(path.join(app.dir, '.forge', 'local.yml'), `repos:\n  lib:\n    path: ${path.relative(app.dir, lib.dir)}\n`);
    const libPr = { number: 8, url: 'https://github.com/o/lib/pull/8', state: 'OPEN' as const, isDraft: false, lastSyncedAt: new Date().toISOString() };
    const job = updateJob(app.dir, id, (j) => {
      j.repos = [j.repos[0], { repo: 'lib', worktree: null, branch: j.branch, base: 'develop', pr: libPr, verifyOnly: false, interim: null }];
    });
    logEvent(app.dir, id, 'pr-opened', { number: 7 });
    logEvent(app.dir, id, 'decision', { decision: 'APPROVE', reason: null, autoMerge: true, head, heads: { lib: libHead } });

    const github = memoryGitHub();
    const passing = [{ name: 'test', conclusion: 'SUCCESS' }];
    github.put(ghPr({ headRefOid: head, statusCheckRollup: passing }));
    github.put(ghPr({ number: 8, url: libPr.url, headRefName: job.branch, baseRefName: 'develop', headRefOid: libHead, statusCheckRollup: passing }), 'o/lib');
    github.setHeadChecks(head, headData({ test: 'SUCCESS' }));
    // The member's own protection names other checks than the root's key; its head reports build only.
    github.setBranchRules('develop', { status: 'read', checks: [{ name: 'build', appId: null }, { name: 'lint', appId: null }], reviews: 1 }, 'o/lib');
    github.setHeadChecks(libHead, headData({ build: 'SUCCESS' }), 'o/lib');

    const r = await mergePr(app.dir, config, github, id, { clock: () => Date.now() + 10 * 60_000 });
    const member = { source: 'protection', state: 'pending', blocking: [{ name: 'lint', why: 'missing' }] };
    assert.deepEqual(
      r.parts?.map((p) => [p.repo, p.action, p.required]),
      [
        [null, 'merged', { source: 'config', state: 'passing', blocking: [] }],
        ['lib', 'deferred', member],
      ],
    );
    assert.deepEqual([r.action, r.repo, r.required], ['deferred', 'lib', member], "the top level carries the last part's verdict");
    // Each PR read at its own repo, base and head: protection for the member only, never for the root.
    assert.deepEqual(github.calls.filter((c) => c.op === 'branchRules'), [{ op: 'branchRules', slug: 'o/lib', base: 'develop' }]);
    assert.deepEqual(
      github.calls.filter((c) => c.op === 'headChecks').map((c) => [c.slug, c.sha]),
      [
        ['o/r', head],
        ['o/lib', libHead],
      ],
    );
    assert.deepEqual(github.calls.filter((c) => c.op === 'merge').map((c) => [c.slug, c.number]), [['o/r', 7]]);
  } finally {
    app.cleanup();
    lib.cleanup();
  }
});
