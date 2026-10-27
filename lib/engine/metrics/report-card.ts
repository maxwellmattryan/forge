// A mandate's report card: one fixed-shape object over its jobs (what merged, how it scored, how much
// review and human help it took, what it cost against its budget, what happened after the merges), built
// with no I/O from the job figures lib/office/mandates/progress.ts reads (the CLI records, the archive,
// the CLI copy of the events and the spend ledger).
//
// A figure still waiting on a post-merge measurement reads 'pending', never 0 (the pending rule on
// CardFigure in lib/api/repo.ts). The card goes on GET /api/mandates without the token, so it carries no
// free text: counts, finite numbers, 'pending', null, WAITING_ON keys and ISO times it built itself. Its
// inputs are typed by shape, as this layer can't import the office's: progress.ts's MandateJob and
// JobFigures fit them. runningScore is the median a mandate's quality floor reads: the same scored values,
// without the pending rule, which under continuous work would keep it 'pending'. docs/IMPROVEMENT.md ›
// Mandate report card.
import { WAITING_ON } from '#core/job/schema.ts';
import { isForemanActor } from '#core/job/store.ts';
import { outcomeWindowDays } from '../evals/outcome.ts';
import { mergeTime, scoreAwaited } from '../evals/scoring.ts';
import { median, reviewRounds } from './stats.ts';
import type { CardFigure, Config, Job, JobEvent, MandateReportCard, MandateScoring, WaitingOn } from '#core/types.ts';

/** One of a mandate's jobs as the card reads it (lib/office/mandates/progress.ts MandateJob): its CLI record, its events, its class against the until, and whether it is live. */
export interface CardJob {
  job: Job;
  events: JobEvent[];
  class: string;
  live: boolean;
}

/** What the card is built from (lib/office/mandates/progress.ts JobFigures). */
export interface CardFigures {
  jobs: CardJob[];
  counts: { reached: number; inFlight: number };
  spentUsd: number;
  started: number;
}

/** The mandate terms the card reads. */
export interface CardMandate {
  id: string;
  budget: { usd: number; jobs: number };
  scoring: MandateScoring;
}

const DAY_MS = 86_400_000;

const r2 = (n: number): number => Math.round(n * 100) / 100;
const ratio = (n: number, d: number): number => Math.round((n / d) * 1000) / 1000;

/** The pending rule: 'pending' while something is awaited, null when nothing is counted, else the value. */
const figure = (awaited: number, counted: number, value: () => number): CardFigure => (awaited > 0 ? 'pending' : counted === 0 ? null : value());

/** A stored time as ms, or null for anything Date.parse can't read. */
const timeOf = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** A time the card built, or null when it is outside what a Date can hold. */
const isoOf = (t: number): string | null => {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** A scored record's value when it is a number from 0 to 5; anything else counts as unscored. */
const scoreValue = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 5 ? v : null);

/**
 * The park a job was at when event `i` was recorded: the latest transition before it, when that went
 * to `waiting` on a WAITING_ON value; else `none`. A forged waitingOn string never becomes a key.
 */
function gateAt(events: JobEvent[], i: number): WaitingOn | 'none' {
  for (let k = i - 1; k >= 0; k--) {
    const e = events[k];
    if (e?.type !== 'transition') continue;
    const to = e.to && typeof e.to === 'object' ? (e.to as { state?: unknown; waitingOn?: unknown }) : {};
    return to.state === 'waiting' && (WAITING_ON as readonly unknown[]).includes(to.waitingOn) ? (to.waitingOn as WaitingOn) : 'none';
  }
  return 'none';
}

/** A job's score value when it is scored with a number from 0 to 5, else null: the one rule the card and the quality floor share. */
const scoredValue = (j: Pick<CardJob, 'job'>): number | null => {
  const s = j.job.score;
  return s?.status === 'scored' ? scoreValue(s.value) : null;
};

/** The values of the merged jobs scored 0-5, in job order. */
function scoredValues(merged: Pick<CardJob, 'job'>[]): number[] {
  const values: number[] = [];
  for (const j of merged) {
    const v = scoredValue(j);
    if (v !== null) values.push(v);
  }
  return values;
}

/** The running median over the merged jobs scored 0-5, pending ones aside: what a mandate's quality floor reads. */
export function runningScore(jobs: Pick<CardJob, 'job'>[]): { scored: number; median: number | null } {
  const values = scoredValues(jobs.filter((j) => j.job.pr?.state === 'MERGED'));
  return { scored: values.length, median: values.length ? r2(median(values) as number) : null };
}

/** The merged jobs' scores, each job in exactly one bucket. */
function scoresOf(merged: CardJob[], m: Pick<CardMandate, 'scoring'>, config: Config, now: Date): MandateReportCard['scores'] {
  const values = scoredValues(merged);
  let held = 0;
  let failed = 0;
  let pending = 0;
  let unscored = 0;
  for (const j of merged) {
    const s = j.job.score;
    if (scoredValue(j) !== null) continue;
    if (s?.status === 'held') held++;
    else if (s?.status === 'failed') failed++;
    // Sync and `forge job score record` read only live jobs: an archived one's score never comes.
    else if (j.live && scoreAwaited(j.job, now, config, m.scoring)) pending++;
    else unscored++;
  }
  return {
    scored: values.length,
    held,
    failed,
    pending,
    unscored,
    median: figure(pending, values.length, () => r2(median(values) as number)),
    below3: figure(pending, values.length, () => values.filter((v) => v < 3).length),
  };
}

/** The merged jobs' outcomes, each job in exactly one bucket, and when the last window closes. */
function outcomesOf(merged: CardJob[], config: Config): MandateReportCard['outcomes'] {
  const windowMs = outcomeWindowDays(config) * DAY_MS;
  let final = 0;
  let open = 0;
  let reverted = 0;
  let followedUp = 0;
  // Each final or open job's window close: its outcome's closesAt, or for one not measured yet its merge time plus the window.
  const closes: number[] = [];
  for (const j of merged) {
    const o = j.job.outcome;
    let closesAt: number | null = null;
    if (o?.status === 'final') {
      final++;
      if (o.reverted === true) reverted++;
      if (typeof o.followUps === 'number' && o.followUps > 0) followedUp++;
      closesAt = timeOf(o.closesAt);
    } else if (j.live && config.pr?.enabled && (!o || o.status === 'open')) {
      open++;
      const merge = o ? null : mergeTime(j.job);
      closesAt = o ? timeOf(o.closesAt) : merge === null ? null : merge + windowMs;
    }
    if (closesAt !== null && Number.isFinite(closesAt)) closes.push(closesAt);
  }
  return {
    final,
    open,
    unmeasured: merged.length - final - open,
    reverted: figure(open, final, () => reverted),
    followedUp: figure(open, final, () => followedUp),
    finalAt: closes.length ? isoOf(Math.max(...closes)) : null,
  };
}

/** The settled jobs with verdicts: their mean last round and the share that passed every lens in round 1. */
function reviewOf(jobs: CardJob[]): MandateReportCard['review'] {
  let reviewed = 0;
  let rounds = 0;
  let firstPass = 0;
  for (const j of jobs) {
    if (j.class === 'inFlight') continue;
    const r = reviewRounds(j.job);
    if (!r || !Number.isFinite(r.rounds)) continue;
    reviewed++;
    rounds += r.rounds;
    if (r.firstPass) firstPass++;
  }
  return { reviewed, avgRounds: reviewed ? r2(rounds / reviewed) : null, firstPassRate: reviewed ? ratio(firstPass, reviewed) : null };
}

/** Every person's (not the foreman's) `human` event on the jobs, keyed by the park it was recorded at. */
function interventionsOf(jobs: CardJob[]): MandateReportCard['interventions'] {
  const counts = new Map<WaitingOn | 'none', number>();
  let total = 0;
  for (const j of jobs) {
    j.events.forEach((e, i) => {
      if (e?.type !== 'human' || isForemanActor(e)) return;
      total++;
      const k = gateAt(j.events, i);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    });
  }
  const byGate: MandateReportCard['interventions']['byGate'] = {};
  for (const k of [...WAITING_ON, 'none'] as const) {
    const n = counts.get(k);
    if (n) byGate[k] = n;
  }
  return { total, byGate };
}

/** The mandate's report card at `at` (ms), from its job figures. No I/O. */
export function buildReportCard(m: CardMandate, f: CardFigures, config: Config, at: number): MandateReportCard {
  const merged = f.jobs.filter((j) => j.job.pr?.state === 'MERGED');
  return {
    mandate: m.id,
    at: new Date(at).toISOString(),
    jobs: { total: f.jobs.length, reached: f.counts.reached, merged: merged.length, inFlight: f.counts.inFlight },
    scores: scoresOf(merged, m, config, new Date(at)),
    review: reviewOf(f.jobs),
    interventions: interventionsOf(f.jobs),
    spend: { usd: f.spentUsd, budgetUsd: m.budget.usd, started: f.started, budgetJobs: m.budget.jobs },
    outcomes: outcomesOf(merged, config),
  };
}
