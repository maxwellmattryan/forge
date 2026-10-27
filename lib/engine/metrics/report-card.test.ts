// The mandate report card over synthetic jobs: every count 0 and every figure null for an empty mandate,
// the running totals, each merged job in exactly one score and outcome bucket, the pending rule, and
// malformed record values that never reach the card raw; the running score a quality floor reads; and a
// closing summary's stored card, rebuilt or refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '#core/config/load.ts';
import { WAITING_ON, normalizeJob } from '#core/job/schema.ts';
import { buildReportCard, closingCard, runningScore } from './report-card.ts';
import type { CardJob } from './report-card.ts';
import type { Config, Job, JobEvent, JobOutcome, JobScore, MandateReportCard } from '#core/types.ts';

const DAY = 86_400_000;
const AT = Date.parse('2026-10-20T12:00:00.000Z');
const ago = (days: number): string => new Date(AT - days * DAY).toISOString();

type Class = 'reached' | 'handled' | 'unfinishable' | 'inFlight';

/** One mandate job: live and in flight unless told otherwise. */
function mj(id: string, o: { class?: Class; live?: boolean; job?: Record<string, unknown>; events?: JobEvent[] } = {}): CardJob {
  return { class: o.class ?? 'inFlight', live: o.live ?? true, job: { ...normalizeJob({ id, mandate: 'm1' }), ...o.job } as Job, events: o.events ?? [] };
}

/** A merged PR, `days` ago. */
const merged = (days = 1) => ({ pr: { number: 7, url: 'https://github.com/acme/web/pull/7', state: 'MERGED', isDraft: false, lastSyncedAt: ago(0), mergedAt: ago(days) } });
const score = (status: JobScore['status'], value: unknown = null) => ({ status, value, outOf: 5, queuedAt: ago(1), recordedAt: status === 'queued' ? null : ago(0), judgeModel: null, builderModel: null });
const outcome = (status: JobOutcome['status'], o: Record<string, unknown> = {}) => ({
  status,
  windowDays: 14,
  mergedAt: ago(20),
  closesAt: ago(6),
  mergeSha: null,
  reverted: false,
  revertedBy: null,
  followUps: 0,
  followUpRefs: [],
  churn: null,
  measuredAt: ago(6),
  attempts: 1,
  ...o,
});
// Built as plain records, as a malformed one may be: the card reads only the fields it checks.
const transition = (to: Record<string, unknown>): JobEvent => ({ v: 1, ts: ago(2), type: 'transition', from: { state: 'running', stage: 'build', waitingOn: null }, to }) as unknown as JobEvent;
const human = (source: string): JobEvent => ({ v: 1, ts: ago(2), type: 'human', action: 'approve', actor: { login: source === 'foreman' ? null : 'alice', source } }) as unknown as JobEvent;

function card(jobs: CardJob[], o: { scoring?: 'all' | 'sample' | 'off'; prEnabled?: boolean; spentUsd?: number; started?: number } = {}): MandateReportCard {
  const config: Config = defaults();
  config.pr.enabled = o.prEnabled ?? true;
  const counts = { reached: 0, inFlight: 0, handled: 0, unfinishable: 0 };
  for (const j of jobs) counts[j.class as Class]++;
  return buildReportCard({ id: 'm1', budget: { usd: 50, jobs: 5 }, scoring: o.scoring ?? 'all' }, { jobs, counts, spentUsd: o.spentUsd ?? 0, started: o.started ?? jobs.length }, config, AT);
}

test('an empty mandate', () => {
  assert.deepEqual(card([], { started: 0 }), {
    mandate: 'm1',
    at: '2026-10-20T12:00:00.000Z',
    jobs: { total: 0, reached: 0, merged: 0, inFlight: 0 },
    scores: { scored: 0, held: 0, failed: 0, pending: 0, unscored: 0, median: null, below3: null },
    review: { reviewed: 0, avgRounds: null, firstPassRate: null },
    interventions: { total: 0, byGate: {} },
    spend: { usd: 0, budgetUsd: 50, started: 0, budgetJobs: 5 },
    outcomes: { final: 0, open: 0, unmeasured: 0, reverted: null, followedUp: null, finalAt: null },
  });
});

test('jobs, review, interventions and spend', () => {
  const jobs = [
    // Settled with verdicts: rounds 1 (first pass), 2 and 3 (the last round key, not the count).
    mj('a', {
      class: 'reached',
      job: { ...merged(), verdicts: { 1: { code: 'PASS', security: 'PASS' } } },
      events: [transition({ state: 'waiting', stage: 'spec', waitingOn: 'spec-approval' }), human('gh'), transition({ state: 'waiting', stage: 'review', waitingOn: 'escalation' }), human('dashboard'), human('foreman')],
    }),
    mj('b', { class: 'handled', job: { state: 'cancelled', verdicts: { 1: { code: 'CHANGES' }, 2: { code: 'PASS' } } }, events: [transition({ state: 'running', stage: 'build' }), human('cli')] }),
    mj('e', { class: 'reached', live: false, job: { ...merged(), verdicts: { 1: { code: 'CHANGES', docs: 'PASS' }, 3: { code: 'PASS' } } } }),
    // Unfinishable with no verdicts; a person's decision before any transition keys as none.
    mj('c', { class: 'unfinishable', job: { state: 'failed' }, events: [human('gh')] }),
    // In flight with verdicts: not counted in review; its decision at pr-review still counts.
    mj('d', { job: { verdicts: { 1: { code: 'CHANGES' }, 2: { code: 'CHANGES' }, 3: { code: 'CHANGES' } } }, events: [transition({ state: 'waiting', stage: 'pr', waitingOn: 'pr-review' }), human('gh')] }),
  ];
  const c = card(jobs, { spentUsd: 12.5, started: 4 });
  assert.deepEqual(c.jobs, { total: 5, reached: 2, merged: 2, inFlight: 1 });
  assert.deepEqual(c.review, { reviewed: 3, avgRounds: 2, firstPassRate: 0.333 });
  assert.equal(c.interventions.total, 5, 'every person, never the foreman');
  assert.deepEqual(c.interventions.byGate, { 'spec-approval': 1, escalation: 1, 'pr-review': 1, none: 2 });
  assert.deepEqual(Object.keys(c.interventions.byGate), ['spec-approval', 'escalation', 'pr-review', 'none'], 'WAITING_ON order, then none');
  assert.deepEqual(c.spend, { usd: 12.5, budgetUsd: 50, started: 4, budgetJobs: 5 });
});

const final3 = () => [
  mj('s1', { class: 'reached', job: { ...merged(), score: score('scored', 4.5) } }),
  mj('s2', { class: 'reached', job: { ...merged(), score: score('scored', 2) } }),
  mj('s3', { class: 'reached', live: false, job: { ...merged(), score: score('scored', 3) } }),
  mj('h', { class: 'reached', job: { ...merged(), score: score('held') } }),
  mj('f', { class: 'reached', job: { ...merged(), score: score('failed') } }),
  // Not merged: never in the scores, so in-flight work never makes them pending.
  mj('wip', { job: { score: null } }),
];

test('scores: final', () => {
  assert.deepEqual(card(final3()).scores, { scored: 3, held: 1, failed: 1, pending: 0, unscored: 0, median: 3, below3: 1 });
  assert.deepEqual(card([final3()[3], final3()[4]]).scores, { scored: 0, held: 1, failed: 1, pending: 0, unscored: 0, median: null, below3: null }, 'held and failed alone await nothing');
});

test('scores: a queued run is pending', () => {
  const queued = mj('q', { class: 'reached', job: { ...merged(), score: score('queued') } });
  assert.deepEqual(card([...final3(), queued]).scores, { scored: 3, held: 1, failed: 1, pending: 1, unscored: 0, median: 'pending', below3: 'pending' });
  // No score yet, merged a day ago, in a mandate that scores all: forge sync will still queue one.
  const due = mj('n', { class: 'reached', job: { ...merged(1), score: null } });
  assert.deepEqual([card([due]).scores.pending, card([due]).scores.median], [1, 'pending']);
});

test('scores: never-to-be-scored jobs are unscored', () => {
  const none = (o: { live?: boolean; days?: number } = {}) => mj('n', { class: 'reached', live: o.live, job: { ...merged(o.days ?? 1), score: null } });
  const unscored = (c: MandateReportCard) => [c.scores.pending, c.scores.unscored, c.scores.median, c.scores.below3];
  assert.deepEqual(unscored(card([none()], { scoring: 'off' })), [0, 1, null, null], 'a mandate that scores off');
  assert.deepEqual(unscored(card([none()], { scoring: 'sample' })), [0, 1, null, null], 'not in the sample (scoring.sample 0)');
  assert.deepEqual(unscored(card([none({ live: false })])), [0, 1, null, null], 'archived: sync reads only live jobs');
  assert.deepEqual(unscored(card([none()], { prEnabled: false })), [0, 1, null, null], 'pr.enabled false');
  assert.deepEqual(unscored(card([none({ days: 10 })])), [0, 1, null, null], 'merged past the 7-day lookback');
  const queued = (live: boolean) => mj('q', { class: 'reached', live, job: { ...merged(), score: score('queued') } });
  assert.deepEqual(unscored(card([queued(false)])), [0, 1, null, null], 'an archived queued run is never recorded');
  assert.deepEqual(unscored(card([queued(true)], { prEnabled: false })), [0, 1, null, null], 'a queued run with PRs disabled');
  // Beside final scores the figures are values again.
  assert.deepEqual(card([...final3(), none({ live: false })]).scores, { scored: 3, held: 1, failed: 1, pending: 0, unscored: 1, median: 3, below3: 1 });
});

test('running score', () => {
  assert.deepEqual(runningScore([]), { scored: 0, median: null });
  const queued = mj('q', { class: 'reached', job: { ...merged(), score: score('queued') } });
  // Scored but not merged: never counted, as the card leaves it out.
  const unmerged = mj('u', { job: { score: score('scored', 0) } });
  const bad = [9, -1, '1', NaN].map((v, i) => mj(`b${i}`, { class: 'reached', job: { ...merged(), score: score('scored', v) } }));
  const jobs = [...final3(), queued, unmerged, ...bad];
  // 4.5, 2 and 3: the pending run aside, where the card's median reads 'pending'.
  assert.deepEqual(runningScore(jobs), { scored: 3, median: 3 });
  assert.equal(runningScore(jobs).scored, card(jobs).scores.scored, 'the card and the floor count the same scored jobs');
  assert.equal(card(jobs).scores.median, 'pending');
  const even = [1, 2.004, 3.3, 5].map((v, i) => mj(`e${i}`, { class: 'reached', job: { ...merged(), score: score('scored', v) } }));
  assert.deepEqual(runningScore(even), { scored: 4, median: 2.65 }, 'the median to 2 decimals');
});

const finals = () => [
  mj('r', { class: 'reached', job: { ...merged(30), outcome: outcome('final', { reverted: true, followUps: 0, closesAt: ago(16) }) } }),
  mj('u', { class: 'reached', job: { ...merged(30), outcome: outcome('final', { reverted: false, followUps: 2, closesAt: ago(8) }) } }),
  mj('x', { class: 'reached', live: false, job: { ...merged(30), outcome: outcome('final', { reverted: null, followUps: 'unsupported', closesAt: ago(10) }) } }),
];

test('outcomes: final', () => {
  assert.deepEqual(card(finals()).outcomes, { final: 3, open: 0, unmeasured: 0, reverted: 1, followedUp: 1, finalAt: ago(8) });
});

test('outcomes: open and unmeasured', () => {
  const open = mj('o', { class: 'reached', job: { ...merged(5), outcome: outcome('open', { closesAt: new Date(AT + 9 * DAY).toISOString() }) } });
  assert.deepEqual(card([...finals(), open]).outcomes, { final: 3, open: 1, unmeasured: 0, reverted: 'pending', followedUp: 'pending', finalAt: new Date(AT + 9 * DAY).toISOString() });
  // Not measured yet: open, its window closing outcomes.windowDays (14) after its merge, the latest close.
  const fresh = mj('n', { class: 'reached', job: { ...merged(1), outcome: null } });
  const archivedOpen = mj('ao', { class: 'reached', live: false, job: { ...merged(5), outcome: outcome('open', { closesAt: new Date(AT + 30 * DAY).toISOString() }) } });
  assert.deepEqual(card([...finals(), open, fresh, archivedOpen]).outcomes, {
    final: 3,
    open: 2,
    unmeasured: 1,
    reverted: 'pending',
    followedUp: 'pending',
    finalAt: new Date(AT - DAY + 14 * DAY).toISOString(),
  });
  // With PRs disabled nothing will be measured: the open ones are unmeasured, and the figures are values.
  assert.deepEqual(card([...finals(), open, fresh], { prEnabled: false }).outcomes, { final: 3, open: 0, unmeasured: 2, reverted: 1, followedUp: 1, finalAt: ago(8) });
});

test('malformed record values', () => {
  const jobs = [
    mj('nine', { class: 'reached', job: { ...merged(), score: score('scored', 9) } }),
    mj('text', { class: 'reached', job: { ...merged(), score: score('scored', '4') } }),
    mj('nan', { class: 'reached', job: { ...merged(), score: score('scored', Number.NaN) } }),
    mj('bad-date', { class: 'reached', job: { ...merged(), outcome: outcome('final', { closesAt: 'not a date', reverted: 'yes', followUps: '3' }) } }),
    mj('no-merge', { class: 'reached', job: { pr: { ...merged().pr, mergedAt: 'soon' }, outcome: null } }),
    mj('forged', { events: [transition({ state: 'waiting', stage: 'pr', waitingOn: '<img src=x onerror=alert(1)>' }), human('gh'), transition({ state: 'waiting', stage: 'pr', waitingOn: '__proto__' }), human('gh')] }),
  ];
  const c = card(jobs);
  assert.deepEqual(card(jobs.slice(0, 3)).scores, { scored: 0, held: 0, failed: 0, pending: 0, unscored: 3, median: null, below3: null }, 'a scored value outside 0..5 or not a number is unscored');
  assert.deepEqual(c.interventions, { total: 2, byGate: { none: 2 } }, 'a waitingOn outside WAITING_ON keys as none');
  assert.deepEqual([c.outcomes.final, c.outcomes.reverted, c.outcomes.followedUp], [1, 'pending', 'pending']);
  assert.equal(card(jobs.slice(3, 5)).outcomes.finalAt, null, 'an unreadable closesAt and an unreadable merge time are skipped');
  assert.deepEqual(card([jobs[3]]).outcomes, { final: 1, open: 0, unmeasured: 0, reverted: 0, followedUp: 0, finalAt: null }, "reverted 'yes' and followUps '3' count as neither");

  // Every leaf is a finite number, 'pending', null or an ISO time; every byGate key is from WAITING_ON or none.
  const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
  const leaves = (v: unknown, at: string): void => {
    if (v !== null && typeof v === 'object') return Object.entries(v).forEach(([k, x]) => leaves(x, `${at}.${k}`));
    if (at === '.mandate') return assert.equal(v, 'm1');
    assert.ok((typeof v === 'number' && Number.isFinite(v)) || v === 'pending' || v === null || (typeof v === 'string' && ISO.test(v)), `${at}: ${String(v)}`);
  };
  for (const x of [c, card(jobs, { prEnabled: false })]) {
    leaves(x, '');
    for (const k of Object.keys(x.interventions.byGate)) assert.ok([...WAITING_ON, 'none'].includes(k), k);
  }
});

test('a stored card', () => {
  const gated = mj('g', { class: 'reached', job: { ...merged(), score: score('queued'), verdicts: { 1: { code: 'PASS' } } }, events: [transition({ state: 'waiting', stage: 'spec', waitingOn: 'spec-approval' }), human('gh'), human('cli')] });
  const open = mj('o', { class: 'reached', job: { ...merged(5), outcome: outcome('open', { closesAt: new Date(AT + 9 * DAY).toISOString() }) }, events: [human('gh')] });
  const built = card([...final3(), ...finals(), gated, open], { spentUsd: 3.25 });
  assert.deepEqual([built.scores.median, built.outcomes.reverted, built.interventions.byGate], ['pending', 'pending', { 'spec-approval': 2, none: 1 }], 'the fixture has figures pending and gates counted');
  /** What summary.json holds: the card through a JSON round trip. */
  const stored = (outcomesFinalAt: string | null) => JSON.parse(JSON.stringify({ card: built, outcomesFinalAt })) as { card: any; outcomesFinalAt: unknown };
  for (const at of [ago(0), null]) assert.deepEqual(closingCard(stored(at), 'm1'), stored(at), `outcomesFinalAt ${at}`);
  // The empty card, every figure null, reads back too.
  const empty = JSON.parse(JSON.stringify({ card: card([], { started: 0 }), outcomesFinalAt: null }));
  assert.deepEqual(closingCard(empty, 'm1'), empty);

  // An extra key, on the card or on a section, is dropped.
  const extra = stored(null);
  extra.card.title = 'x';
  extra.card.scores.title = 'x';
  assert.deepEqual(closingCard(extra, 'm1'), stored(null));

  /** A copy of the stored card with one change. */
  const tampered = (change: (s: { card: any; outcomesFinalAt: unknown }) => void) => {
    const s = stored(ago(0));
    change(s);
    return s;
  };
  const refused: [string, (s: { card: any; outcomesFinalAt: unknown }) => void][] = [
    ['another mandate', (s) => (s.card.mandate = 'm2')],
    ['card null', (s) => (s.card = null)],
    ['a count as a string', (s) => (s.card.jobs.total = '3')],
    ['a negative count', (s) => (s.card.scores.scored = -1)],
    ['a NaN count', (s) => (s.card.outcomes.open = Number.NaN)],
    ['a count null', (s) => (s.card.review.reviewed = null)],
    ['a figure as markup', (s) => (s.card.scores.median = '<img src=x onerror=alert(1)>')],
    ['a figure as a number string', (s) => (s.card.outcomes.reverted = '1')],
    ['a rate as pending', (s) => (s.card.review.firstPassRate = 'pending')],
    ['a forged gate', (s) => (s.card.interventions.byGate.evil = 1)],
    ['a __proto__ gate', (s) => (s.card.interventions.byGate = JSON.parse('{"__proto__": 1, "none": 1}'))],
    ['a gate count as a string', (s) => (s.card.interventions.byGate.none = '1')],
    ['byGate a list', (s) => (s.card.interventions.byGate = [1])],
    ['an unreadable at', (s) => (s.card.at = 'yesterday')],
    ['an unreadable finalAt', (s) => (s.card.outcomes.finalAt = 'soon')],
    ['an unreadable outcomesFinalAt', (s) => (s.outcomesFinalAt = 'later')],
    ['outcomesFinalAt missing', (s) => delete s.outcomesFinalAt],
    ['a missing section', (s) => delete s.card.review],
    ['a section as a list', (s) => (s.card.spend = [])],
  ];
  for (const [label, change] of refused) assert.equal(closingCard(tampered(change), 'm1'), null, label);
  assert.equal(closingCard({}, 'm1'), null, 'no card at all');
});
