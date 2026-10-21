// Forge metrics. They describe Forge's behaviour, not the codebase's quality, which is
// what makes them comparable across every repo Forge runs in and gives the retro loop
// something stable to improve against.
import { listArchived } from './archive.ts';
import { judgeAutonomy } from './autonomy.ts';
import { jobFindings } from './findings.ts';
import type { JobFindings } from './findings.ts';
import { isForemanActor, listJobs, readEvents } from './jobs.ts';
import { csvCell, parseAuditDate } from './audit.ts';
import { LEDGER_BY, ledgerRows, spendLedger } from './spend.ts';
import type { LedgerBy } from './spend.ts';
import type { Config, Job, JobEvent, ReviewerStats, Stats, UsageRow, VerifierStats } from './types.ts';
import { ForgeError } from './util.ts';

/** One job stats reads: live (its files on disk) or archived (its record), with the same accessors. */
interface StatsSource {
  job: Job;
  events: () => JobEvent[];
  findings: () => JobFindings;
  archived: boolean;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const ratio = (n: number, d: number): number | null => (d ? Math.round((n / d) * 1000) / 1000 : null);
const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Whether the very first verify attempt of round 1 passed, or null when the job never got there.
 * Later attempts in the same round are retries and must not count as a first pass.
 */
export function firstVerifyRun(job: Pick<Job, 'verifyRuns' | 'verify'>): boolean | null {
  const first = (job.verifyRuns ?? []).find((r) => r.round === 1 && r.attempt === 1);
  if (first) return Boolean(first.ok);
  return job.verify?.[1] ? job.verify[1] === 'PASS' : null;
}

/**
 * Per-verifier counts from `verifiers` record events: how often each ran, said NO, gave no valid
 * answer, and blocked. A verifier that never fires (hitRate 0 over many runs) is a retro candidate.
 */
export function addVerifierStats(into: Record<string, VerifierStats>, events: JobEvent[]): void {
  for (const e of events) {
    if (e.type !== 'verifiers' || e.phase !== 'record' || !Array.isArray(e.results)) continue;
    for (const r of e.results as unknown[]) {
      if (!r || typeof r !== 'object') continue;
      const { name, mode, answer } = r as Record<string, unknown>;
      if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) continue;
      const s = (into[name] ??= { runs: 0, fails: 0, unanswered: 0, blocks: 0, hitRate: null });
      s.runs++;
      if (answer === 'no') s.fails++;
      else if (answer !== 'yes') s.unanswered++;
      if (answer !== 'yes' && mode === 'block') s.blocks++;
    }
  }
}

export function computeStats(root: string, opts: { since?: string; includeEvals?: boolean; jobs?: Job[] } = {}): Stats {
  const since = opts.since ? Date.parse(opts.since) : 0;
  const all: StatsSource[] = (opts.jobs ?? listJobs(root)).map((job) => ({ job, events: () => readEvents(root, job.id), findings: () => jobFindings(root, job.id), archived: false }));
  // Jobs passed in are the whole population (tests, evals): no archives join them.
  if (!opts.jobs) {
    for (const a of listArchived(root)) all.push({ job: a.job, events: () => a.events, findings: () => a.summary.findings, archived: true });
    // listJobs' order, so sums of rounded values come out the same after a job moves to the archive.
    all.sort((a, b) => String(b.job.updatedAt).localeCompare(String(a.job.updatedAt)));
  }
  const sources = all.filter(({ job: j }) => (opts.includeEvals || j.kind !== 'eval') && Date.parse((j.createdAt ?? 0) as string) >= since);
  const jobs = sources.map((s) => s.job);
  const counts = { total: jobs.length, active: 0, done: 0, cancelled: 0, failed: 0, waiting: 0, archived: sources.filter((s) => s.archived).length };
  let reviewed = 0, firstPass = 0, roundsSum = 0, decided = 0, escalated = 0, verified = 0, verifyFirstPass = 0;
  let withPr = 0, prWithHumanFeedback = 0, humanRework = 0, foremanDecisions = 0, foremanRework = 0, specJobs = 0, specFirstTry = 0;
  let merged = 0, deltaMeasured = 0, deltaNonEmpty = 0, recurringFindings = 0;
  // Outcomes: only final ones are judged, and each rate's denominator skips checks that never completed.
  let outcomesFinal = 0, outcomesOpen = 0, autonomous = 0, autonomousStrict = 0;
  let revertChecked = 0, reverted = 0, followUpChecked = 0, followedUp = 0, churnChecked = 0, churned = 0;
  // Post-merge scores: every non-null score counts as sampled, only scored ones give a value.
  const scoreCoverage = { merged: 0, sampled: 0, scored: 0, held: 0, failed: 0, queued: 0 };
  const scores: number[] = [];
  const scoresByModel: Record<string, number[]> = {};
  const deltaLines: number[] = [];
  const timeToPr: number[] = [];
  const cycle: number[] = [];
  const reviewers: Record<string, ReviewerStats> = {};
  const verifiers: Record<string, VerifierStats> = {};
  const byRole: Record<string, UsageRow> = {};
  const byModel: Record<string, UsageRow> = {};
  let tokens = 0, cost = 0, agentRuns = 0, agentRunsWithUsage = 0, exactRuns = 0;
  const waitingOn: Record<string, number> = {};

  for (const src of sources) {
    const j = src.job;
    if (j.state === 'done') counts.done++;
    else if (j.state === 'cancelled') counts.cancelled++;
    else if (j.state === 'failed') counts.failed++;
    else counts.active++;
    if (j.state === 'waiting') {
      counts.waiting++;
      // setJob refuses state "waiting" without a waitingOn.
      waitingOn[j.waitingOn!] = (waitingOn[j.waitingOn!] ?? 0) + 1;
    }
    const rounds = Object.keys(j.verdicts ?? {}).map(Number).sort((a, b) => a - b);
    if (rounds.length) {
      reviewed++;
      roundsSum += rounds[rounds.length - 1];
      const first = j.verdicts[rounds[0]];
      if (first && Object.values(first).every((v) => v === 'PASS')) firstPass++;
      for (const r of rounds) {
        for (const [name, v] of Object.entries(j.verdicts[r] ?? {})) {
          // changeRate and disputeRate are filled in for every lens after the loop.
          const s = (reviewers[name] ??= { reviews: 0, changes: 0, blockers: 0, findings: 0, fixed: 0, disputes: 0, recurring: 0 } as ReviewerStats);
          s.reviews++;
          if (v === 'CHANGES') s.changes++;
        }
      }
      // Only lenses with verdicts in the window: an answer line naming `verify` or `pr` is no reviewer.
      const f = src.findings();
      recurringFindings += f.totals.recurring;
      for (const [lens, c] of Object.entries(f.byLens)) {
        const s = reviewers[lens];
        if (!s) continue;
        s.findings += c.raised;
        s.fixed += c.fixed;
        s.disputes += c.disputed;
        s.recurring += c.recurring;
      }
    }
    const firstVerify = firstVerifyRun(j);
    if (firstVerify !== null) {
      verified++;
      if (firstVerify) verifyFirstPass++;
    }
    if (j.pr?.state === 'MERGED') merged++;
    const delta = j.pr?.humanDelta;
    if (delta?.status === 'measured') {
      deltaMeasured++;
      // Empty "retrigger CI" commits touch no files, so they are not an escape.
      // A measured delta always has a fileCount.
      if (delta.fileCount! > 0) {
        deltaNonEmpty++;
        deltaLines.push(delta.lines ?? 0);
      }
    }
    if (j.decision) {
      decided++;
      if (j.decision === 'ESCALATE') escalated++;
    }
    const events = src.events();
    // createJob always sets createdAt.
    const created = Date.parse(j.createdAt!);
    const opened = events.find((e) => e.type === 'pr-opened');
    if (opened) {
      withPr++;
      timeToPr.push((Date.parse(opened.ts) - created) / 60000);
    }
    if (events.some((e) => e.type === 'pr-synced' && e.newFeedback)) prWithHumanFeedback++;
    const outcome = j.pr?.state === 'MERGED' ? j.outcome : null;
    if (outcome?.status === 'open') outcomesOpen++;
    const judged = outcome?.status === 'final' ? judgeAutonomy(j, events) : null;
    if (outcome && judged) {
      outcomesFinal++;
      if (judged.autonomous) autonomous++;
      if (judged.strict) autonomousStrict++;
      if (outcome.reverted !== null) {
        revertChecked++;
        if (outcome.reverted) reverted++;
      }
      if (typeof outcome.followUps === 'number') {
        followUpChecked++;
        if (outcome.followUps > 0) followedUp++;
      }
      if (outcome.churn) {
        churnChecked++;
        if (outcome.churn.commits > 0) churned++;
      }
    }
    const score = j.score;
    if (score) {
      scoreCoverage.sampled++;
      scoreCoverage[score.status]++;
      if (score.status === 'scored' && score.value !== null) {
        scores.push(score.value);
        (scoresByModel[score.builderModel ?? 'unknown'] ??= []).push(score.value);
      }
    }
    addVerifierStats(verifiers, events);
    for (const e of events) {
      if (e.type !== 'agent-end') continue;
      agentRuns++;
      if (e.usage && (e.usage.totalTokens || e.usage.input || e.usage.output)) agentRunsWithUsage++;
      if (e.usage?.exact) exactRuns++;
    }
    // An event without a foreman actor was a person's (v1 events without one read as `unknown`).
    const foreman = events.filter((e) => e.type === 'human' && isForemanActor(e));
    const human = events.filter((e) => e.type === 'human' && !isForemanActor(e));
    humanRework += human.filter((e) => e.action === 'rework').length;
    foremanDecisions += foreman.length;
    foremanRework += foreman.filter((e) => e.action === 'rework').length;
    // Spec approval counts whoever decided: it measures the spec, not the decider.
    const decisions = [...human, ...foreman];
    if (decisions.some((e) => e.action === 'approve-spec')) {
      specJobs++;
      if (!decisions.some((e) => e.action === 'revise-spec')) specFirstTry++;
    }
    if (j.state === 'done' && j.finishedAt) cycle.push((Date.parse(j.finishedAt) - created) / 60000);
    tokens += j.usage?.totalTokens ?? 0;
    cost += j.usage?.estCostUsd ?? 0;
    for (const [k, v] of Object.entries(j.usage?.byRole ?? {})) {
      const b = (byRole[k] ??= { tokens: 0, estCostUsd: 0, runs: 0 });
      b.tokens += v.tokens;
      b.estCostUsd = r2(b.estCostUsd + v.estCostUsd);
      b.runs += v.runs;
    }
    for (const [k, v] of Object.entries(j.usage?.byModel ?? {})) {
      const b = (byModel[k] ??= { tokens: 0, estCostUsd: 0, runs: 0 });
      b.tokens += v.tokens;
      b.estCostUsd = r2(b.estCostUsd + v.estCostUsd);
      b.runs += v.runs;
    }
  }
  // Disputes over answered findings, not raised ones: builders skip many nits and the last round's
  // findings are never answered, so a raised denominator would mostly measure whether a next round came.
  for (const s of Object.values(reviewers)) Object.assign(s, { changeRate: ratio(s.changes, s.reviews), disputeRate: ratio(s.disputes, s.fixed + s.disputes) });
  for (const s of Object.values(verifiers)) s.hitRate = ratio(s.fails, s.runs);
  return {
    generatedAt: new Date().toISOString(),
    since: opts.since ?? null,
    counts,
    waitingOn,
    quality: {
      firstPassReviewRate: ratio(firstPass, reviewed),
      avgRounds: reviewed ? r2(roundsSum / reviewed) : null,
      verifyFirstPassRate: ratio(verifyFirstPass, verified),
      escalationRate: ratio(escalated, decided),
      humanFeedbackOnPrRate: ratio(prWithHumanFeedback, withPr),
      humanDeltaRate: ratio(deltaNonEmpty, deltaMeasured),
      medianHumanDeltaLines: median(deltaLines),
      humanDeltaCoverage: { merged, measured: deltaMeasured },
      humanReworks: humanRework,
      foremanDecisions,
      foremanReworks: foremanRework,
      specFirstApprovalRate: ratio(specFirstTry, specJobs),
      recurringFindings,
      autonomyRate: ratio(autonomous, outcomesFinal),
      autonomyRateStrict: ratio(autonomousStrict, outcomesFinal),
      revertRate: ratio(reverted, revertChecked),
      followUpRate: ratio(followedUp, followUpChecked),
      churnRate: ratio(churned, churnChecked),
      outcomeCoverage: { merged, final: outcomesFinal, open: outcomesOpen },
      medianScore: median(scores) === null ? null : r2(median(scores) as number),
      scoreCoverage: { ...scoreCoverage, merged },
      scoreByBuilderModel: Object.fromEntries(Object.entries(scoresByModel).map(([m, v]) => [m, { scored: v.length, medianScore: r2(median(v) as number) }])),
    },
    speed: {
      medianMinutesToPr: median(timeToPr) === null ? null : r2(median(timeToPr) as number),
      medianMinutesToDone: median(cycle) === null ? null : r2(median(cycle) as number),
    },
    cost: {
      totalTokens: tokens,
      estCostUsd: r2(cost),
      avgTokensPerJob: jobs.length ? Math.round(tokens / jobs.length) : null,
      avgCostPerJobUsd: jobs.length ? r2(cost / jobs.length) : null,
      reportingCoverage: { agentRuns, withUsage: agentRunsWithUsage, exact: exactRuns },
      byRole,
      byModel,
    },
    reviewers,
    verifiers,
  };
}

const CSV_TOTALS = ['runs', 'tokens', 'input', 'output', 'cache_read', 'cache_write', 'usd'] as const;

/**
 * `forge stats --csv`: the spend ledger (lib/spend.ts) by job, role, model or day, for finance. Every
 * job counts, evals and retros included, so the totals match `forge budget`.
 */
export function statsCsv(root: string, config: Config, flags: Record<string, unknown>): string {
  const usage = (why: string) => new ForgeError(`${why}; usage: forge stats --csv [--since DATE] [--by job|role|model|day]`, 'usage', 'forge help stats');
  if (!flags.csv) throw usage('--by needs --csv');
  if (flags.json) throw usage('--csv and --json are exclusive');
  const raw = flags.by === undefined ? 'job' : flags.by;
  if (typeof raw !== 'string' || !(LEDGER_BY as readonly string[]).includes(raw)) throw usage(`--by must be one of ${LEDGER_BY.join(', ')} (got ${JSON.stringify(String(raw)).slice(0, 40)})`);
  const by = raw as LedgerBy;
  const since = flags.since === undefined ? null : parseAuditDate(flags.since, '--since');
  const rows = ledgerRows(spendLedger(root, config, { since }), { by });
  const lines = [[...(by === 'job' ? ['job', 'kind', 'title'] : [by]), ...CSV_TOTALS].join(',')];
  for (const r of rows) {
    const t = r.totals;
    lines.push([...r.key, t.runs, t.tokens, t.input, t.output, t.cacheRead, t.cacheWrite, t.usd.toFixed(4)].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
