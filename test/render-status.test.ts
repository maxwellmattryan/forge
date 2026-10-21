// lib/commands/render/status.ts: `forge status`, `forge stats` and `forge requests list` in human mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requests, stats, status } from '../lib/commands/render/status.ts';
import { statsSections, statsText } from '../lib/commands/status.ts';
import { HOSTILE, NOW, assertSafe, plain } from './render-helpers.ts';
import type { StatusView } from '../lib/commands/status.ts';
import type { ForgeRequest, ReviewerStats, Stats } from '../lib/types.ts';

const row = (o: Partial<StatusView>): StatusView => ({ id: 'j', stage: 'build', state: 'running', waitingOn: null, round: 0, tasks: { done: 0, total: 0 }, pr: null, session: null, reason: null, ...o });
const ROWS = [
  row({ id: 'add-login', state: 'running', round: 2, tasks: { done: 3, total: 5 }, pr: 12, session: 'abcdef1234567' }),
  row({ id: 'fix-bug', stage: 'spec', state: 'waiting', waitingOn: 'input' }),
];

test('status: the agent table\'s columns and widths', () => {
  assert.equal(
    plain(status, ROWS),
    ['job        stage  state          round  tasks  pr   session', 'add-login  build  running        r2     3/5    #12  abcdef12', 'fix-bug    spec   waiting:input  -      -      -    -'].join('\n'),
  );
});

test('status: a reason column when some row has a reason', () => {
  const rows = [ROWS[0], { ...ROWS[1], reason: 'needs\napproval' }];
  assert.equal(
    plain(status, rows),
    [
      'job        stage  state          round  tasks  pr   session   reason',
      'add-login  build  running        r2     3/5    #12  abcdef12  -',
      'fix-bug    spec   waiting:input  -      -      -    -         needs approval',
    ].join('\n'),
  );
});

test('status: no rows', () => {
  assert.equal(plain(status, []), 'no active jobs');
  assert.equal(plain(status, { id: 'x' }), null);
});

const reviewer = (changeRate: number | null, disputeRate: number | null): ReviewerStats => ({ reviews: 4, changes: 2, blockers: 0, changeRate, findings: 3, fixed: 2, disputes: 1, disputeRate }) as ReviewerStats;

const STATS = {
  generatedAt: '2026-10-19T00:00:00.000Z',
  since: null,
  counts: { total: 4, active: 2, done: 1, cancelled: 1, failed: 0, waiting: 1, archived: 0 },
  waitingOn: {},
  quality: {
    firstPassReviewRate: 0.5,
    avgRounds: 1.5,
    verifyFirstPassRate: 1,
    escalationRate: 0.25,
    humanFeedbackOnPrRate: null,
    humanDeltaRate: 0.1,
    medianHumanDeltaLines: 12,
    humanDeltaCoverage: { merged: 2, measured: 1 },
    humanReworks: 1,
    foremanDecisions: 0,
    foremanReworks: 0,
    specFirstApprovalRate: 0.75,
    recurringFindings: 2,
    autonomyRate: 0.75,
    autonomyRateStrict: 0.5,
    revertRate: 0,
    followUpRate: 0.25,
    churnRate: 0.5,
    outcomeCoverage: { merged: 6, final: 4, open: 1 },
  },
  speed: { medianMinutesToPr: 30, medianMinutesToDone: null },
  cost: { totalTokens: 1234567, estCostUsd: 12.5, avgTokensPerJob: null, avgCostPerJobUsd: 3.13, reportingCoverage: { agentRuns: 10, withUsage: 9, exact: 8 }, byRole: {}, byModel: {} },
  reviewers: { code: reviewer(0.5, 0.1), security: reviewer(null, 0) },
  verifiers: { 'no-todo': { runs: 5, fails: 1, unanswered: 0, blocks: 1, hitRate: 0.2 } },
} as Stats;

const tokens = (1234567).toLocaleString();
const LINES = [
  'jobs 4 (active 2, done 1, waiting 1, cancelled 1)',
  'autonomy 75% (strict 50%) · reverted 0% · follow-ups 25% · churn 50% · outcomes final 4/6 (open 1)',
  'first-pass review 50% · avg rounds 1.5 · verify first-pass 100% · recurring findings 2',
  'escalations 25% · PRs with human feedback — · human reworks 1 · spec approved first try 75%',
  'human delta after push 10% · median 12 lines · measured 1/2',
  'median to PR 30 min · median to done — min',
  `tokens ${tokens} · est. API cost $12.5 · per job $3.13 · usage coverage 9/10 (exact 8)`,
];

test('statsText is unchanged', () => {
  assert.equal(statsText(STATS), [...LINES, 'reviewers: code 50% changes, 10% disputed · security — changes, 0% disputed', 'verifiers: no-todo 20% hit over 5 runs, 1 blocked'].join('\n'));
  const { verifiers: _v, ...older } = STATS;
  assert.equal(statsText(older as Stats), [...LINES, 'reviewers: code 50% changes, 10% disputed · security — changes, 0% disputed'].join('\n'));
  assert.deepEqual(statsSections(STATS).reviewers, [['code', '50% changes, 10% disputed'], ['security', '— changes, 0% disputed']]);
});

test('stats: headings, then reviewers and verifiers one per line', () => {
  const head = ['Jobs', `  ${LINES[0]}`, '', 'Quality', `  ${LINES[1]}`, `  ${LINES[2]}`, `  ${LINES[3]}`, `  ${LINES[4]}`, '', 'Speed', `  ${LINES[5]}`, '', 'Cost', `  ${LINES[6]}`];
  assert.equal(plain(stats, STATS), [...head, '', 'Reviewers', '  code  50% changes, 10% disputed', '  security  — changes, 0% disputed', '', 'Verifiers', '  no-todo  20% hit over 5 runs, 1 blocked'].join('\n'));
  const { verifiers: _v, ...older } = STATS;
  assert.equal(plain(stats, { ...older, reviewers: {} }), head.join('\n'), 'an older stats object with no verifiers, and no reviewers');
});

const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const reqs = (o: Partial<ForgeRequest>): ForgeRequest => ({ id: 'r1', type: 'resume', job: null, text: null, args: {}, from: 'cli', status: 'pending', createdAt: at(0), ...o });

test('requests: a table with relative ages', () => {
  const rows = [
    reqs({ id: 'r1', createdAt: at(30_000), job: 'add-login', text: 'go on\nplease' }),
    reqs({ id: 'r2', createdAt: at(5 * 60_000), type: 'approve', from: 'daemon:inbox' }),
    reqs({ id: 'r3', createdAt: at(3 * 3600_000 + 59 * 60_000), status: 'done' }),
    reqs({ id: 'r4', createdAt: at(2 * 86400_000 + 3600_000) }),
    reqs({ id: 'r5', createdAt: 'yesterday' }),
  ];
  assert.equal(
    plain(requests, rows),
    [
      'id  age  action   job        from          status   text',
      'r1  <1m  resume   add-login  cli           pending  go on please',
      'r2  5m   approve  -          daemon:inbox  pending  -',
      'r3  3h   resume   -          cli           done     -',
      'r4  2d   resume   -          cli           pending  -',
      'r5  -    resume   -          cli           pending  -',
    ].join('\n'),
  );
});

test('requests: no rows, with and without --all', () => {
  assert.equal(plain(requests, []), 'no pending requests');
  assert.equal(plain(requests, [], { all: true }), 'no requests');
});

test('status, stats and requests: sanitizes untrusted text', () => {
  assertSafe(plain(status, [row({ id: HOSTILE, stage: HOSTILE as any, state: HOSTILE as any, session: HOSTILE, reason: HOSTILE })]));
  assertSafe(plain(stats, { ...STATS, reviewers: { [HOSTILE]: reviewer(0, 0) }, verifiers: { [HOSTILE]: { runs: 1, fails: 0, unanswered: 0, blocks: 0, hitRate: 0 } } }));
  assertSafe(plain(requests, [reqs({ id: HOSTILE, type: HOSTILE as any, job: HOSTILE, from: HOSTILE, status: HOSTILE as any, text: HOSTILE })]));
});
