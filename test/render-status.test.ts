// lib/commands/render/status.ts: `forge status`, `forge stats` and `forge requests list` in human mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requests, stats, status } from '../lib/commands/render/status.ts';
import { statsSections, statsText } from '../lib/commands/status.ts';
import { HOSTILE, NOW, assertSafe, hasLines, plain } from './render-helpers.ts';
import type { StatusView } from '../lib/commands/status.ts';
import type { ForgeRequest, ReviewerStats, Stats } from '../lib/types.ts';

const row = (o: Partial<StatusView>): StatusView => ({ id: 'j', stage: 'build', state: 'running', waitingOn: null, round: 0, tasks: { done: 0, total: 0 }, pr: null, session: null, reason: null, handoff: null, ...o });
const ROWS = [
  row({ id: 'add-login', state: 'running', round: 2, tasks: { done: 3, total: 5 }, pr: 12, session: 'abcdef1234567' }),
  row({ id: 'fix-bug', stage: 'spec', state: 'waiting', waitingOn: 'input' }),
];

test('status: the agent table\'s columns and widths (golden)', () => {
  assert.equal(
    plain(status, ROWS),
    ['job        stage  state          round  tasks  pr   session', 'add-login  build  running        r2     3/5    #12  abcdef12', 'fix-bug    spec   waiting:input  -      -      -    -'].join('\n'),
  );
});

test('status: a reason column when some row has a reason', () => {
  const rows = [ROWS[0], { ...ROWS[1], reason: 'needs\napproval' }];
  hasLines(plain(status, rows), 'job        stage  state          round  tasks  pr   session   reason', 'add-login  build  running        r2     3/5    #12  abcdef12  -', 'fix-bug    spec   waiting:input  -      -      -    -         needs approval');
});

test('status: a handoff column when some job was left for a human', () => {
  const rows = [ROWS[0], { ...ROWS[1], waitingOn: 'escalation' as const, handoff: 'reserved: touches auth' }];
  assert.equal(
    plain(status, rows),
    [
      'job        stage  state               round  tasks  pr   session   handoff',
      'add-login  build  running             r2     3/5    #12  abcdef12  -',
      'fix-bug    spec   waiting:escalation  -      -      -    -         reserved: touches auth',
    ].join('\n'),
  );
});

test('status: no rows', () => {
  assert.equal(plain(status, []), 'no active jobs');
  assert.equal(plain(status, { id: 'x' }), null);
});

const reviewer = (changeRate: number | null, disputeRate: number | null): ReviewerStats => ({
  reviews: 4, changes: 2, blockers: 0, changeRate, findings: 3, fixed: 2, disputes: 1, disputeRate, recurring: 0,
  missChecked: 2, missed: 1, missRate: 0.5, blockerMajor: 1, severityKnown: 3, blockerMajorShare: 0.333, severityTrend: [],
});

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
    medianScore: 4,
    scoreCoverage: { merged: 6, sampled: 5, scored: 3, held: 1, failed: 0, queued: 1 },
    scoreByBuilderModel: { opus: { scored: 3, medianScore: 4 } },
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
  'score median 4/5 · scored 3/5 sampled (held 1, failed 0)',
  'first-pass review 50% · avg rounds 1.5 · verify first-pass 100% · recurring findings 2',
  'escalations 25% · PRs with human feedback — · human reworks 1 · spec approved first try 75%',
  'human delta after push 10% · median 12 lines · measured 1/2',
  'median to PR 30 min · median to done — min',
  `tokens ${tokens} · est. API cost $12.5 · per job $3.13 · usage coverage 9/10 (exact 8)`,
];

test('statsText is unchanged', () => {
  const REVIEWERS = 'reviewers: code 50% changes, 10% disputed, 50% missed · security — changes, 0% disputed, 50% missed';
  const VERIFIERS = 'verifiers: no-todo 20% hit over 5 runs, 1 blocked';
  hasLines(statsText(STATS), ...LINES, REVIEWERS, VERIFIERS);
  const { verifiers: _v, ...older } = STATS;
  const olderText = statsText(older as Stats);
  hasLines(olderText, ...LINES, REVIEWERS);
  assert.ok(!olderText.includes('verifiers:'), 'no verifiers line for an older stats object');
  assert.deepEqual(statsSections(STATS).reviewers, [['code', '50% changes, 10% disputed, 50% missed'], ['security', '— changes, 0% disputed, 50% missed']]);
  // A stats object from before the miss rate.
  const { missRate: _m, ...noMiss } = STATS.reviewers.code;
  assert.deepEqual(statsSections({ ...STATS, reviewers: { code: noMiss as ReviewerStats } }).reviewers, [['code', '50% changes, 10% disputed, — missed']]);
});

test('stats: score line with nothing scored, and from an older stats object', () => {
  const none = { ...STATS, quality: { ...STATS.quality, medianScore: null, scoreCoverage: { merged: 6, sampled: 1, scored: 0, held: 1, failed: 0, queued: 0 }, scoreByBuilderModel: {} } } as Stats;
  assert.ok(statsText(none).split('\n').includes('score median - · scored 0/1 sampled (held 1, failed 0)'));
  const { medianScore: _m, scoreCoverage: _c, scoreByBuilderModel: _b, ...olderQuality } = STATS.quality;
  assert.ok(statsText({ ...STATS, quality: olderQuality } as Stats).split('\n').includes('score median - · scored 0/0 sampled (held 0, failed 0)'));
});

test('stats: headings, then reviewers and verifiers one per line', () => {
  const head = ['Jobs', `  ${LINES[0]}`, 'Quality', `  ${LINES[1]}`, `  ${LINES[5]}`, 'Speed', `  ${LINES[6]}`, 'Cost', `  ${LINES[7]}`];
  hasLines(plain(stats, STATS), ...head, 'Reviewers', '  code  50% changes, 10% disputed, 50% missed', '  security  — changes, 0% disputed, 50% missed', 'Verifiers', '  no-todo  20% hit over 5 runs, 1 blocked');
  const { verifiers: _v, ...older } = STATS;
  const olderOut = plain(stats, { ...older, reviewers: {} });
  hasLines(olderOut, ...head);
  assert.ok(!olderOut!.includes('Reviewers') && !olderOut!.includes('Verifiers'), 'an older stats object with no verifiers, and no reviewers');
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
  hasLines(
    plain(requests, rows),
    'r1  <1m  resume   add-login  cli           pending  go on please',
    'r2  5m   approve  -          daemon:inbox  pending  -',
    'r3  3h   resume   -          cli           done     -',
    'r4  2d   resume   -          cli           pending  -',
    'r5  -    resume   -          cli           pending  -',
  );
});

test('requests: no rows, with and without --all', () => {
  assert.equal(plain(requests, []), 'no pending requests');
  assert.equal(plain(requests, [], { all: true }), 'no requests');
});

test('status, stats and requests: sanitizes untrusted text', () => {
  assertSafe(plain(status, [row({ id: HOSTILE, stage: HOSTILE as any, state: HOSTILE as any, session: HOSTILE, reason: HOSTILE, handoff: HOSTILE })]));
  assertSafe(plain(stats, { ...STATS, reviewers: { [HOSTILE]: reviewer(0, 0) }, verifiers: { [HOSTILE]: { runs: 1, fails: 0, unanswered: 0, blocks: 0, hitRate: 0 } } }));
  assertSafe(plain(requests, [reqs({ id: HOSTILE, type: HOSTILE as any, job: HOSTILE, from: HOSTILE, status: HOSTILE as any, text: HOSTILE })]));
});
