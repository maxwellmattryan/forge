// Required checks: evaluateRequired decides each requirement from the observations with its exact
// name, bound to its source, and requirementsFor picks config for the root, protection otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryGitHub } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import type { BranchRules, CheckObservation, HeadChecks } from '#integrations/github/types.ts';
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
