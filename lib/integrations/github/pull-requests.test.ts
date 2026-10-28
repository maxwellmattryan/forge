// The typed GitHub seam: parsePr and parseFeedback keep only checked values from gh's JSON, and the
// gh adapter makes one gh call per operation. In-process: the runner is a recording closure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ghPr } from '../../../test/helpers.ts';
import { ForgeError } from '#core/errors.ts';
import type { RunResult } from '#core/os/process.ts';
import { createGhGitHub, failingCheckNames, parseFeedback, parsePr, summarizeChecks } from './pull-requests.ts';
import type { GhRun } from './pull-requests.ts';
import type { GitHub, PrSnapshot } from './types.ts';

const SHA = 'a'.repeat(40);
const isExternal = (e: unknown) => e instanceof ForgeError && e.code === 'external';

/** ghPr() with `key` removed: a field gh left out. */
function without(key: string): Record<string, unknown> {
  const raw = ghPr();
  delete raw[key];
  return raw;
}

const BAD_ROLLUP = [
  { name: 'lint', conclusion: 'FAILURE' },
  { name: 'x; rm -rf /', conclusion: 'FAILURE' },
  { name: 'build', conclusion: 'SUCCESS' },
];

const RUN_URL = 'https://github.com/o/r/actions/runs/101/job/201';
/** A PR whose one failing check run links `detailsUrl`. */
const failingAt = (detailsUrl: unknown) => ghPr({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'verify', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl }] });
const MATRIX = 'verify (node 22.18.0, shard 2/2)';
/** 21 failing Actions jobs, each in its own run. */
const MANY_RUNS = Array.from({ length: 21 }, (_, i) => ({ name: `job ${i}`, conclusion: 'FAILURE', detailsUrl: `https://github.com/o/r/actions/runs/${i + 1}/job/${i + 100}` }));

const PR_ROWS: [string, Record<string, unknown>, Partial<PrSnapshot>][] = [
  ['a safe number', ghPr({ number: 7 }), { number: 7 }],
  ['number 0', ghPr({ number: 0 }), { number: null }],
  ['number -1', ghPr({ number: -1 }), { number: null }],
  ['number 1.5', ghPr({ number: 1.5 }), { number: null }],
  ["number '7'", ghPr({ number: '7' }), { number: null }],
  ['an https url', ghPr(), { url: 'https://github.com/o/r/pull/7' }],
  ['an http url', ghPr({ url: 'http://github.com/o/r/pull/7' }), { url: null }],
  ['a javascript: url', ghPr({ url: 'javascript:alert(1)' }), { url: null }],
  ['state MERGED', ghPr({ state: 'MERGED' }), { state: 'MERGED' }],
  ["state 'DRAFT'", ghPr({ state: 'DRAFT' }), { state: null }],
  ['isDraft true', ghPr({ isDraft: true }), { isDraft: true }],
  ["isDraft 'true'", ghPr({ isDraft: 'true' }), { isDraft: false }],
  ['isCrossRepository false', ghPr({ isCrossRepository: false }), { isCrossRepository: false }],
  ['isCrossRepository missing', without('isCrossRepository'), { isCrossRepository: true }],
  ["isCrossRepository 'false'", ghPr({ isCrossRepository: 'false' }), { isCrossRepository: true }],
  ['isCrossRepository null', ghPr({ isCrossRepository: null }), { isCrossRepository: true }],
  ['safe refs', ghPr(), { headRefName: 'forge/x', baseRefName: 'main' }],
  ['an option-like head ref', ghPr({ headRefName: '--upload-pack=x' }), { headRefName: null }],
  ['a head ref with a space', ghPr({ headRefName: 'a b' }), { headRefName: null }],
  ['a dot-led base ref', ghPr({ baseRefName: '.hidden' }), { baseRefName: null }],
  ['a numeric base ref', ghPr({ baseRefName: 7 }), { baseRefName: null }],
  ['a 40-hex head', ghPr({ headRefOid: SHA }), { headOid: SHA }],
  ["head 'zz'", ghPr({ headRefOid: 'zz' }), { headOid: null }],
  ['a 6-character hex head', ghPr({ headRefOid: 'abcdef' }), { headOid: null }],
  ['an object head', ghPr({ headRefOid: {} }), { headOid: null }],
  ['merge fields as text', ghPr({ mergeable: 'CONFLICTING', mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED', mergedAt: '2026-10-01T00:00:00Z' }), { mergeable: 'CONFLICTING', mergeState: 'BLOCKED', reviewDecision: 'APPROVED', mergedAt: '2026-10-01T00:00:00Z' }],
  ['merge fields capped at 40 safe characters', ghPr({ mergeable: `A\nB\`${'C'.repeat(60)}` }), { mergeable: `AB${'C'.repeat(38)}` }],
  ['merge fields that are not strings or are empty', ghPr({ mergeable: 5, mergeStateStatus: '', reviewDecision: '', mergedAt: null }), { mergeable: null, mergeState: null, reviewDecision: null, mergedAt: null }],
  ['a rollup', ghPr({ statusCheckRollup: BAD_ROLLUP }), { checks: summarizeChecks(BAD_ROLLUP), failingChecks: failingCheckNames(BAD_ROLLUP) }],
  ['a rollup that is not an array', ghPr({ statusCheckRollup: 'x' }), { checks: summarizeChecks([]), failingChecks: { names: [], more: 0 }, failingRuns: [] }],
  ['a failing Actions job', failingAt(RUN_URL), { failingRuns: [{ slug: 'o/r', run: '101', job: '201' }] }],
  ['a passing Actions job', ghPr({ statusCheckRollup: [{ name: 'verify', conclusion: 'SUCCESS', detailsUrl: RUN_URL }] }), { failingRuns: [] }],
  ['a commit status with only a targetUrl', ghPr({ statusCheckRollup: [{ __typename: 'StatusContext', context: 'ci/x', state: 'FAILURE', targetUrl: RUN_URL }] }), { failingRuns: [] }],
  ...(
    [
      ['an option-like run id', 'https://github.com/o/r/actions/runs/--help/job/1'],
      ['run id 0', 'https://github.com/o/r/actions/runs/0/job/1'],
      ['a leading-zero job id', 'https://github.com/o/r/actions/runs/1/job/01'],
      ['an http url', 'http://github.com/o/r/actions/runs/101/job/201'],
      ['another host', 'https://github.com.evil/o/r/actions/runs/101/job/201'],
      ['a query string', `${RUN_URL}?x=1`],
      ['a trailing path', `${RUN_URL}/logs`],
      ['a 21-digit id', `https://github.com/o/r/actions/runs/${'1'.repeat(21)}/job/201`],
      ['a 10k-character url', `https://github.com/o/r/actions/runs/${'1/'.repeat(5000)}job/201`],
      ['a number', 101],
    ] as [string, unknown][]
  ).map(([name, url]): [string, Record<string, unknown>, Partial<PrSnapshot>] => [`a failing check with ${name}`, failingAt(url), { failingRuns: [] }]),
  ['a 20-digit run id kept as text', failingAt(`https://github.com/o/r/actions/runs/${'9'.repeat(20)}/job/201`), { failingRuns: [{ slug: 'o/r', run: '9'.repeat(20), job: '201' }] }],
  ['at most 20 failing runs', ghPr({ statusCheckRollup: MANY_RUNS }), { failingRuns: MANY_RUNS.slice(0, 20).map((_, i) => ({ slug: 'o/r', run: String(i + 1), job: String(i + 100) })) }],
  ['a matrix check name', ghPr({ statusCheckRollup: [{ name: MATRIX, conclusion: 'FAILURE' }] }), { failingChecks: { names: [MATRIX], more: 0 } }],
];

test("parsePr keeps only checked values from gh's PR JSON", () => {
  for (const [name, raw, want] of PR_ROWS) {
    const got = parsePr(raw) as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(want)) assert.deepEqual(got[k], v, `${name}: ${k}`);
  }
  // The hostile check name is dropped and counted, never passed on.
  assert.deepEqual(parsePr(ghPr({ statusCheckRollup: BAD_ROLLUP })).failingChecks, { names: ['lint'], more: 1 });
  for (const raw of [null, [], 'x']) assert.throws(() => parsePr(raw), isExternal, JSON.stringify(raw));
});

const node = (login: string, association: string, body: string) => ({ author: { login }, authorAssociation: association, body, createdAt: '2026-10-01T00:00:00Z', url: 'https://github.com/o/r/pull/7#c' });
const thread = (comments: unknown[], over: Record<string, unknown> = {}) => ({ isResolved: false, isOutdated: false, path: 'lib/a.ts', line: 3, comments: { nodes: comments }, ...over });
const review = (login: string, association: string, state: string, body = '') => ({ ...node(login, association, body), state, submittedAt: '2026-10-01T00:00:00Z' });
const data = (pr: { threads?: unknown[]; reviews?: unknown[]; comments?: unknown[] }) => ({
  repository: { pullRequest: { reviewThreads: { nodes: pr.threads ?? [] }, reviews: { nodes: pr.reviews ?? [] }, comments: { nodes: pr.comments ?? [] } } },
});

test("parseFeedback keeps people's feedback and counts only trusted", () => {
  const fb = parseFeedback(
    data({
      threads: [
        thread([node('alice', 'MEMBER', 'rename this')]),
        thread([node('bob', 'OWNER', 'done already')], { isResolved: true }),
        thread([node('ci[bot]', 'NONE', 'coverage dropped')]),
        thread([node('forge', 'OWNER', 'summary <!-- forge -->')]),
      ],
      reviews: [
        review('carol', 'COLLABORATOR', 'CHANGES_REQUESTED'),
        review('dave', 'NONE', 'APPROVED'),
        review('erin', 'CONTRIBUTOR', 'COMMENTED', 'looks fine'),
        review('bot[bot]', 'OWNER', 'CHANGES_REQUESTED', 'auto'),
      ],
      comments: [node('frank', 'NONE', 'hello'), node('dependabot[bot]', 'NONE', 'bump'), node('me', 'OWNER', '<!-- forge --> status')],
    }),
  );
  assert.deepEqual(fb.threads.map((t) => t.comments.map((c) => [c.login, c.trusted])), [[['alice', true]]]);
  assert.deepEqual(fb.reviews.map((r) => [r.login, r.state, r.trusted]), [
    ['carol', 'CHANGES_REQUESTED', true],
    ['erin', 'COMMENTED', false],
  ]);
  assert.deepEqual(fb.comments.map((c) => [c.login, c.trusted]), [['frank', false]]);

  const rows: [string, unknown, number][] = [
    [
      'NONE and CONTRIBUTOR threads with a FIRST_TIMER change request',
      data({ threads: [thread([node('a', 'NONE', 'x')]), thread([node('b', 'CONTRIBUTOR', 'y')])], reviews: [review('c', 'FIRST_TIMER', 'CHANGES_REQUESTED', 'z')] }),
      0,
    ],
    ['a MEMBER thread with an OWNER change request', data({ threads: [thread([node('a', 'MEMBER', 'x')])], reviews: [review('b', 'OWNER', 'CHANGES_REQUESTED')] }), 2],
  ];
  for (const [name, input, trusted] of rows) assert.equal(parseFeedback(input).trusted, trusted, name);
  for (const empty of [null, {}]) assert.deepEqual(parseFeedback(empty), { threads: [], reviews: [], comments: [], trusted: 0 }, JSON.stringify(empty));
});

const VIEW_FIELDS = 'number,url,state,isDraft,isCrossRepository,headRefName,baseRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,mergedAt';
const ok = (stdout = ''): RunResult => ({ ok: true, stdout, stderr: '', status: 0 });
const failed = (stderr: string, stdout = ''): RunResult => ({ ok: false, stdout, stderr, status: 1 });

/** A gh adapter over a runner that records each call and answers `reply`. */
function recording(reply: RunResult) {
  const calls: { cwd: string | undefined; args: string[]; opts: unknown }[] = [];
  const run: GhRun = (cwd, args, opts) => {
    calls.push({ cwd, args, opts });
    return reply;
  };
  return { github: createGhGitHub(run), calls };
}

const GRAPHQL = (vars: string[]) => (args: string[]) => {
  assert.deepEqual(args.slice(0, 3), ['api', 'graphql', '-f']);
  assert.match(args[3], /^query=/);
  assert.deepEqual(args.slice(4), vars);
};

const OPS: { name: string; reply: RunResult; call: (g: GitHub) => unknown; argv: string[] | ((args: string[]) => void); result?: unknown; opts?: unknown }[] = [
  { name: 'view', reply: ok(JSON.stringify(ghPr())), call: (g) => g.view('/r', 'o/r', 7).number, argv: ['pr', 'view', '7', '-R', 'o/r', '--json', VIEW_FIELDS], result: 7 },
  {
    name: 'viewBody',
    reply: ok(JSON.stringify({ number: 7, body: 'text', headRefName: 'forge/x', baseRefName: 'main' })),
    call: (g) => g.viewBody('/r', 'o/r', 7),
    argv: ['pr', 'view', '7', '-R', 'o/r', '--json', 'number,body,headRefName,baseRefName'],
    result: { number: 7, body: 'text', headRefName: 'forge/x', baseRefName: 'main' },
  },
  {
    name: 'list',
    reply: ok(JSON.stringify([ghPr()])),
    call: (g) => g.list('/r', 'o/r', 'forge/x', 'all').map((p) => p.number),
    argv: ['pr', 'list', '-R', 'o/r', '--head', 'forge/x', '--state', 'all', '--json', 'number,url,state,isDraft,isCrossRepository,headRefName,baseRefName', '--limit', '5'],
    result: [7],
  },
  { name: 'list, gh prints a non-array', reply: ok('{}'), call: (g) => g.list('/r', 'o/r', 'forge/x', 'open'), argv: (a) => assert.equal(a[1], 'list'), result: [] },
  {
    name: 'closing',
    reply: ok(JSON.stringify({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [{ number: 9, state: 'OPEN', isCrossRepository: false, authorAssociation: 'MEMBER' }] } } } } })),
    call: (g) => g.closing('/r', 'o/r', 5),
    argv: GRAPHQL(['-f', 'owner=o', '-f', 'name=r', '-F', 'num=5']),
    result: [{ number: 9, state: 'OPEN', isCrossRepository: false, trusted: true }],
  },
  {
    name: 'feedback',
    reply: ok(JSON.stringify({ data: { repository: { pullRequest: {} } } })),
    call: (g) => g.feedback('/r', 'o/r', 7),
    argv: GRAPHQL(['-f', 'owner=o', '-f', 'name=r', '-F', 'num=7']),
    result: { threads: [], reviews: [], comments: [], trusted: 0 },
  },
  {
    name: 'create',
    reply: ok('Creating pull request\nhttps://github.com/o/r/pull/12\n'),
    call: (g) => g.create('/w', { slug: 'o/r', base: 'main', head: 'forge/x', title: 'T', bodyFile: '/b.md', draft: true, labels: ['l'], reviewers: ['rv'] }),
    argv: ['pr', 'create', '-R', 'o/r', '--base', 'main', '--head', 'forge/x', '--title', 'T', '--body-file', '/b.md', '--draft', '--label', 'l', '--reviewer', 'rv'],
    result: { number: 12, url: 'https://github.com/o/r/pull/12' },
  },
  ...['done', 'http://github.com/o/r/pull/12', 'https://github.com/o/r/issues/3'].map((line) => ({
    name: `create, last line ${JSON.stringify(line)}`,
    reply: ok(`${line}\n`),
    call: (g: GitHub) => g.create('/w', { slug: 'o/r', base: 'main', head: 'forge/x', title: 'T', bodyFile: '/b.md', draft: false, labels: [], reviewers: [] }),
    argv: (a: string[]) => assert.equal(a[1], 'create'),
    result: { number: null, url: null },
  })),
  { name: 'editBase', reply: ok(), call: (g) => g.editBase('/r', 'o/r', 7, 'develop'), argv: ['pr', 'edit', '7', '-R', 'o/r', '--base', 'develop'] },
  { name: 'editBody', reply: ok(), call: (g) => g.editBody('/r', 'o/r', 7, '/b.md'), argv: ['pr', 'edit', '7', '-R', 'o/r', '--body-file', '/b.md'] },
  { name: 'ready', reply: ok(), call: (g) => g.ready('/r', 'o/r', 7), argv: ['pr', 'ready', '7', '-R', 'o/r'] },
  {
    name: 'headChecks',
    reply: ok(JSON.stringify({ data: { repository: { object: { checkSuites: { pageInfo: { hasNextPage: false }, nodes: [] }, status: null } } } })),
    call: (g) => g.headChecks('/r', 'o/r', SHA),
    argv: GRAPHQL(['-f', 'owner=o', '-f', 'name=r', '-f', `oid=${SHA}`]),
    result: { checks: [], complete: true },
  },
  {
    name: 'merge',
    reply: ok(),
    call: (g) => g.merge('/r', 'o/r', 7, { method: 'squash', auto: true, matchHead: SHA }),
    argv: ['pr', 'merge', '7', '-R', 'o/r', '--squash', '--auto', '--match-head-commit', SHA],
    opts: { allowFail: true },
    result: { ok: true },
  },
  {
    name: 'merge, refused',
    reply: failed('  auto-merge is not allowed\n', 'ignored'),
    call: (g) => g.merge('/r', 'o/r', 7, { method: 'merge', auto: false, matchHead: null }),
    argv: ['pr', 'merge', '7', '-R', 'o/r', '--merge'],
    result: { ok: false, error: 'auto-merge is not allowed' },
  },
  {
    name: 'merge, refused with only stdout',
    reply: failed('', ' not mergeable \n'),
    call: (g) => g.merge('/r', 'o/r', 7, { method: 'rebase', auto: false, matchHead: null }),
    argv: ['pr', 'merge', '7', '-R', 'o/r', '--rebase'],
    result: { ok: false, error: 'not mergeable' },
  },
  {
    name: 'viewRun',
    reply: ok(JSON.stringify({ headSha: SHA, status: 'COMPLETED', conclusion: 'FAILURE' })),
    call: (g) => g.viewRun('/r', 'o/r', '101'),
    argv: ['run', 'view', '101', '-R', 'o/r', '--json', 'headSha,status,conclusion'],
    result: { headSha: SHA, status: 'completed', conclusion: 'failure' },
  },
  {
    name: 'viewRun, a head that is not a sha',
    reply: ok(JSON.stringify({ headSha: 'zz', status: 'in_progress', conclusion: '' })),
    call: (g) => g.viewRun('/r', 'o/r', '101'),
    argv: (a) => assert.equal(a[1], 'view'),
    result: { headSha: null, status: 'in_progress', conclusion: null },
  },
  {
    name: 'rerunFailed',
    reply: ok(),
    call: (g) => g.rerunFailed('/r', 'o/r', '101'),
    argv: ['run', 'rerun', '101', '--failed', '-R', 'o/r'],
    opts: { allowFail: true },
    result: { ok: true },
  },
  {
    name: 'rerunFailed, refused',
    reply: failed('  HTTP 403: Resource not accessible by integration\n', 'ignored'),
    call: (g) => g.rerunFailed('/r', 'o/r', '101'),
    argv: ['run', 'rerun', '101', '--failed', '-R', 'o/r'],
    result: { ok: false, error: 'HTTP 403: Resource not accessible by integration' },
  },
  {
    name: 'rerunFailed, refused with only stdout',
    reply: failed('', ' run 101 cannot be rerun \n'),
    call: (g) => g.rerunFailed('/r', 'o/r', '101'),
    argv: ['run', 'rerun', '101', '--failed', '-R', 'o/r'],
    result: { ok: false, error: 'run 101 cannot be rerun' },
  },
];

test('the gh adapter makes one gh call per operation', () => {
  for (const op of OPS) {
    const { github, calls } = recording(op.reply);
    const got = op.call(github);
    assert.equal(calls.length, 1, `${op.name}: one gh call`);
    if (typeof op.argv === 'function') op.argv(calls[0].args);
    else assert.deepEqual(calls[0].args, op.argv, op.name);
    if (op.opts !== undefined) assert.deepEqual(calls[0].opts, op.opts, `${op.name}: opts`);
    if ('result' in op) assert.deepEqual(got, op.result, `${op.name}: result`);
  }
  // A read that fails or prints non-JSON throws `external`, after one call; an edit that fails throws.
  const failures: [string, RunResult, (g: GitHub) => unknown][] = [
    ['view, gh fails', failed('HTTP 404'), (g) => g.view('/r', 'o/r', 7)],
    ['view, not JSON', ok('<html>'), (g) => g.view('/r', 'o/r', 7)],
    ['feedback, gh fails', failed('rate limited'), (g) => g.feedback('/r', 'o/r', 7)],
    ['headChecks, gh fails', failed('HTTP 502'), (g) => g.headChecks('/r', 'o/r', SHA)],
    ['editBody, gh fails', failed('no permission'), (g) => g.editBody('/r', 'o/r', 7, '/b.md')],
    ['viewRun, gh fails', failed('HTTP 404'), (g) => g.viewRun('/r', 'o/r', '101')],
    ['viewRun, not JSON', ok('<html>'), (g) => g.viewRun('/r', 'o/r', '101')],
  ];
  for (const [name, reply, call] of failures) {
    const { github, calls } = recording(reply);
    assert.throws(() => call(github), isExternal, name);
    assert.equal(calls.length, 1, `${name}: one gh call`);
  }
  // A run id or slug that would reach argv unchecked makes no gh call at all.
  for (const [run, slug] of [['-1', 'o/r'], ['1 2', 'o/r'], ['01', 'o/r'], ['101', 'o/r -R x'], ['101', '--repo']]) {
    const { github, calls } = recording(ok());
    const refused = github.rerunFailed('/r', slug, run);
    assert.equal(refused.ok, false, `${run} ${slug}: rerunFailed refuses`);
    assert.match(refused.ok ? '' : refused.error, /^refused: /);
    assert.throws(() => github.viewRun('/r', slug, run), isExternal, `${run} ${slug}: viewRun throws`);
    assert.equal(calls.length, 0, `${run} ${slug}: no gh call`);
  }
});
