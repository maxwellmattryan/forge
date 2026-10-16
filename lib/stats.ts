// Forge metrics. They describe Forge's behaviour, not the codebase's quality, which is
// what makes them comparable across every repo Forge runs in and gives the retro loop
// something stable to improve against.
import { jobFindings } from './findings.ts';
import { listJobs, readEvents } from './jobs.ts';
import type { Job, JobEvent, ReviewerStats, Stats, UsageRow, VerifierStats } from './types.ts';

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
  const jobs = (opts.jobs ?? listJobs(root)).filter((j) => (opts.includeEvals || j.kind !== 'eval') && Date.parse((j.createdAt ?? 0) as string) >= since);
  const counts = { total: jobs.length, active: 0, done: 0, cancelled: 0, failed: 0, waiting: 0 };
  let reviewed = 0, firstPass = 0, roundsSum = 0, decided = 0, escalated = 0, verified = 0, verifyFirstPass = 0;
  let withPr = 0, prWithHumanFeedback = 0, humanRework = 0, foremanDecisions = 0, foremanRework = 0, specJobs = 0, specFirstTry = 0;
  let merged = 0, deltaMeasured = 0, deltaNonEmpty = 0, recurringFindings = 0;
  const deltaLines: number[] = [];
  const timeToPr: number[] = [];
  const cycle: number[] = [];
  const reviewers: Record<string, ReviewerStats> = {};
  const verifiers: Record<string, VerifierStats> = {};
  const byRole: Record<string, UsageRow> = {};
  const byModel: Record<string, UsageRow> = {};
  let tokens = 0, cost = 0, agentRuns = 0, agentRunsWithUsage = 0, exactRuns = 0;
  const waitingOn: Record<string, number> = {};

  for (const j of jobs) {
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
      const f = jobFindings(root, j.id);
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
    const events = readEvents(root, j.id);
    // createJob always sets createdAt.
    const created = Date.parse(j.createdAt!);
    const opened = events.find((e) => e.type === 'pr-opened');
    if (opened) {
      withPr++;
      timeToPr.push((Date.parse(opened.ts) - created) / 60000);
    }
    if (events.some((e) => e.type === 'pr-synced' && e.newFeedback)) prWithHumanFeedback++;
    addVerifierStats(verifiers, events);
    for (const e of events) {
      if (e.type !== 'agent-end') continue;
      agentRuns++;
      if (e.usage && (e.usage.totalTokens || e.usage.input || e.usage.output)) agentRunsWithUsage++;
      if (e.usage?.exact) exactRuns++;
    }
    // An event without `actor` predates the field and was a person's.
    const foreman = events.filter((e) => e.type === 'human' && e.actor === 'foreman');
    const human = events.filter((e) => e.type === 'human' && e.actor !== 'foreman');
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
