// Branch protection and a commit's checks: readBranchRules makes its reads in order through a
// recording runner keyed by argv, and parseHeadChecks keeps only checked values from GitHub's GraphQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunResult } from '#core/os/process.ts';
import { parseHeadChecks, readBranchRules } from './protection.ts';
import type { GhRun } from './pull-requests.ts';
import type { BranchRules } from './types.ts';

const ok = (json: unknown): RunResult => ({ ok: true, stdout: JSON.stringify(json), stderr: '', status: 0 });
const failed = (stderr: string): RunResult => ({ ok: false, stdout: '', stderr, status: 1 });

/** A runner that answers each `gh api <path>` from `answers` (else a 404) and records every call. */
function recording(answers: Record<string, RunResult>) {
  const calls: { args: string[]; opts: unknown }[] = [];
  const run: GhRun = (_cwd, args, opts) => {
    calls.push({ args, opts });
    return answers[args[1]] ?? failed('gh: Not Found (HTTP 404)');
  };
  return { run, calls };
}

const RULES = 'repos/o/r/rules/branches/main?per_page=100';
const BRANCH = 'repos/o/r/branches/main';
const ADMIN = 'repos/o/r/branches/main/protection';
const FORBIDDEN = failed('gh: Resource not accessible by integration (HTTP 403)\n{"message":"Resource not accessible"}');

test('readBranchRules', () => {
  // The order and the exact argv, with an encoded base and the admin read only when protected.
  const enc = 'release%2F1.0';
  const order = recording({
    [`repos/o/r/rules/branches/${enc}?per_page=100`]: ok([]),
    [`repos/o/r/branches/${enc}`]: ok({ protected: true, protection: { required_status_checks: { checks: [{ context: 'test', app_id: 15368 }], contexts: ['test'] } } }),
    [`repos/o/r/branches/${enc}/protection`]: ok({ required_status_checks: { checks: [{ context: 'test', app_id: 15368 }, { context: 'slow', app_id: -1 }] }, required_pull_request_reviews: { required_approving_review_count: 1 } }),
  });
  assert.deepEqual(readBranchRules(order.run, '/r', 'o/r', 'release/1.0'), { status: 'read', checks: [{ name: 'test', appId: 15368 }, { name: 'slow', appId: null }], reviews: 1 });
  assert.deepEqual(
    order.calls.map((c) => c.args),
    [
      ['api', `repos/o/r/rules/branches/${enc}?per_page=100`],
      ['api', `repos/o/r/branches/${enc}`],
      ['api', `repos/o/r/branches/${enc}/protection`],
    ],
  );
  for (const c of order.calls) assert.deepEqual(c.opts, { allowFail: true });

  const rows: [string, Record<string, RunResult>, BranchRules, number][] = [
    [
      'rulesets: integration_id and the pull_request count; an unprotected branch makes no admin read',
      {
        [RULES]: ok([
          { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci', integration_id: 15368 }, { context: 'lint' }, { context: 'lint', integration_id: null }] } },
          { type: 'pull_request', parameters: { required_approving_review_count: 2 } },
          { type: 'copilot_code_review', parameters: {} },
        ]),
        [BRANCH]: ok({ protected: false, protection: { enabled: false, required_status_checks: { checks: [], contexts: [] } } }),
      },
      { status: 'read', checks: [{ name: 'ci', appId: 15368 }, { name: 'lint', appId: null }], reviews: 2 },
      2,
    ],
    [
      'classic: app_id null, bare contexts, deduped by (name, appId) across both reads',
      {
        [RULES]: ok([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'a' }] } }]),
        [BRANCH]: ok({ protected: true, protection: { required_status_checks: { checks: [{ context: 'a', app_id: null }], contexts: ['a', 'b'] } } }),
        [ADMIN]: ok({ required_status_checks: { checks: [{ context: 'b', app_id: null }] } }),
      },
      { status: 'read', checks: [{ name: 'a', appId: null }, { name: 'b', appId: null }], reviews: 0 },
      3,
    ],
    [
      'a 403 on /protection: read, the review count unknown (the non-admin path)',
      { [RULES]: ok([]), [BRANCH]: ok({ protected: true, protection: { required_status_checks: { checks: [{ context: 'test', app_id: null }] } } }), [ADMIN]: FORBIDDEN },
      { status: 'read', checks: [{ name: 'test', appId: null }], reviews: null },
      3,
    ],
    ['both non-admin reads answer, no check anywhere', { [RULES]: ok([]), [BRANCH]: ok({ protected: false }) }, { status: 'read', checks: [], reviews: 0 }, 2],
    ['both non-admin reads fail', { [RULES]: FORBIDDEN, [BRANCH]: FORBIDDEN }, { status: 'unavailable', checks: [], reviews: null, error: 'gh: Resource not accessible by integration (HTTP 403)' }, 2],
    ['the rulesets read fails and the branch has no check', { [RULES]: FORBIDDEN, [BRANCH]: ok({ protected: false }) }, { status: 'unavailable', checks: [], reviews: null, error: 'gh: Resource not accessible by integration (HTTP 403)' }, 2],
    ['the branch read prints something that is not JSON', { [RULES]: ok([]), [BRANCH]: { ok: true, stdout: '<html>', stderr: '', status: 0 } }, { status: 'unavailable', checks: [], reviews: null, error: 'gh printed output that is not JSON' }, 2],
    [
      'the branch read fails but a ruleset names a check',
      { [RULES]: ok([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci', integration_id: 7 }] } }]), [BRANCH]: FORBIDDEN },
      { status: 'read', checks: [{ name: 'ci', appId: 7 }], reviews: null },
      2,
    ],
  ];
  for (const [name, answers, want, calls] of rows) {
    const r = recording(answers);
    assert.deepEqual(readBranchRules(r.run, '/r', 'o/r', 'main'), want, name);
    assert.equal(r.calls.length, calls, `${name}: calls`);
  }

  // A base or slug that could inject a path or a flag makes no call.
  for (const [slug, base] of [
    ['o/r', '-x'],
    ['o/r', 'a..b'],
    ['o/r', 'a//b'],
    ['o/r/../x', 'main'],
    ['../..', 'main'],
  ]) {
    const r = recording({});
    const got = readBranchRules(r.run, '/r', slug, base);
    assert.deepEqual([got.status, r.calls.length], ['unavailable', 0], `${slug} ${base}`);
  }
});

const suite = (over: Record<string, unknown> = {}, runs: unknown[] = [], more = false) => ({
  app: { databaseId: 15368, slug: 'github-actions' },
  workflowRun: { file: { path: '.github/workflows/ci.yml' } },
  checkRuns: { pageInfo: { hasNextPage: more }, nodes: runs },
  ...over,
});
const data = (suites: unknown[], contexts: unknown[] | null = null, more = false) => ({
  repository: { object: { checkSuites: { pageInfo: { hasNextPage: more }, nodes: suites }, status: contexts === null ? null : { contexts } } },
});
const ACTIONS = { kind: 'check-run', appId: 15368, app: 'github-actions', workflow: '.github/workflows/ci.yml', creator: null };

test('parseHeadChecks', () => {
  const parsed = parseHeadChecks(
    data(
      [
        suite({}, [
          { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-24T10:00:00Z', completedAt: '2026-10-24T10:05:00Z' },
          { name: 'slow', status: 'IN_PROGRESS', conclusion: null, startedAt: '2026-10-24T10:00:00Z', completedAt: null },
          { name: 'odd', status: 'COMPLETED', conclusion: null, startedAt: null, completedAt: null },
          { name: 7, status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: '', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'no-status', conclusion: 'SUCCESS' },
          'not a node',
        ]),
        suite({ app: { databaseId: -1, slug: 'Bad Slug' }, workflowRun: null }, [{ name: 'ext', status: 'queued' }]),
        null,
      ],
      [
        { context: 'deploy', state: 'success', createdAt: '2026-10-24T10:01:00Z', creator: { login: 'ci-bot[bot]' } },
        { context: 'anon', state: 'PENDING', createdAt: null, creator: { login: 'not a login' } },
        { context: null, state: 'SUCCESS' },
      ],
    ),
  );
  assert.deepEqual(parsed, {
    complete: true,
    checks: [
      { name: 'test', ...ACTIONS, state: 'SUCCESS', at: '2026-10-24T10:05:00Z' },
      { name: 'slow', ...ACTIONS, state: 'IN_PROGRESS', at: '2026-10-24T10:00:00Z' },
      { name: 'odd', ...ACTIONS, state: 'UNKNOWN', at: null },
      { name: 'ext', kind: 'check-run', appId: null, app: null, workflow: null, creator: null, state: 'QUEUED', at: null },
      { name: 'deploy', kind: 'status', appId: null, app: null, workflow: null, creator: 'ci-bot[bot]', state: 'SUCCESS', at: '2026-10-24T10:01:00Z' },
      { name: 'anon', kind: 'status', appId: null, app: null, workflow: null, creator: null, state: 'PENDING', at: null },
    ],
  });
  // Any page GitHub cut short makes the read incomplete; an answer with no commit is incomplete and empty.
  assert.equal(parseHeadChecks(data([suite()], null, true)).complete, false, 'suites truncated');
  assert.equal(parseHeadChecks(data([suite({}, [], true)])).complete, false, 'runs truncated');
  for (const d of [null, {}, { repository: { object: null } }, 'x']) assert.deepEqual(parseHeadChecks(d), { checks: [], complete: false }, JSON.stringify(d));
});
