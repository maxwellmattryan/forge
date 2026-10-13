// Forge metrics. They describe Forge's behaviour, not the codebase's quality, which is
// what makes them comparable across every repo Forge runs in and gives the retro loop
// something stable to improve against.
import { listJobs, readEvents } from './jobs.ts';

/** @param {number[]} xs */
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** @param {number} n @param {number} d */
const ratio = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);
/** @param {number} n */
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Whether the very first verify attempt of round 1 passed, or null when the job never got there.
 * Later attempts in the same round are retries and must not count as a first pass.
 * @param {any} job
 */
export function firstVerifyRun(job) {
  const first = (job.verifyRuns ?? []).find((/** @type {any} */ r) => r.round === 1 && r.attempt === 1);
  if (first) return Boolean(first.ok);
  return job.verify?.[1] ? job.verify[1] === 'PASS' : null;
}

/**
 * @param {string} root
 * @param {{since?:string, includeEvals?:boolean, jobs?:any[]}} [opts]
 */
export function computeStats(root, opts = {}) {
  const since = opts.since ? Date.parse(opts.since) : 0;
  const jobs = (opts.jobs ?? listJobs(root)).filter((j) => (opts.includeEvals || j.kind !== 'eval') && Date.parse(j.createdAt ?? 0) >= since);
  const counts = { total: jobs.length, active: 0, done: 0, cancelled: 0, failed: 0, waiting: 0 };
  let reviewed = 0, firstPass = 0, roundsSum = 0, decided = 0, escalated = 0, verified = 0, verifyFirstPass = 0;
  let withPr = 0, prWithHumanFeedback = 0, humanRework = 0, specJobs = 0, specFirstTry = 0;
  let merged = 0, deltaMeasured = 0, deltaNonEmpty = 0;
  /** @type {number[]} */ const deltaLines = [];
  /** @type {number[]} */ const timeToPr = [];
  /** @type {number[]} */ const cycle = [];
  /** @type {Record<string, {reviews:number, changes:number, blockers:number}>} */
  const reviewers = {};
  /** @type {Record<string, {tokens:number, estCostUsd:number, runs:number}>} */
  const byRole = {};
  /** @type {Record<string, {tokens:number, estCostUsd:number, runs:number}>} */
  const byModel = {};
  let tokens = 0, cost = 0, agentRuns = 0, agentRunsWithUsage = 0, exactRuns = 0;
  /** @type {Record<string, number>} */
  const waitingOn = {};

  for (const j of jobs) {
    if (j.state === 'done') counts.done++;
    else if (j.state === 'cancelled') counts.cancelled++;
    else if (j.state === 'failed') counts.failed++;
    else counts.active++;
    if (j.state === 'waiting') {
      counts.waiting++;
      waitingOn[j.waitingOn] = (waitingOn[j.waitingOn] ?? 0) + 1;
    }
    const rounds = Object.keys(j.verdicts ?? {}).map(Number).sort((a, b) => a - b);
    if (rounds.length) {
      reviewed++;
      roundsSum += rounds[rounds.length - 1];
      const first = j.verdicts[rounds[0]];
      if (first && Object.values(first).every((v) => v === 'PASS')) firstPass++;
      for (const r of rounds) {
        for (const [name, v] of Object.entries(j.verdicts[r] ?? {})) {
          const s = (reviewers[name] ??= { reviews: 0, changes: 0, blockers: 0 });
          s.reviews++;
          if (v === 'CHANGES') s.changes++;
        }
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
      if (delta.fileCount > 0) {
        deltaNonEmpty++;
        deltaLines.push(delta.lines ?? 0);
      }
    }
    if (j.decision) {
      decided++;
      if (j.decision === 'ESCALATE') escalated++;
    }
    const events = readEvents(root, j.id);
    const created = Date.parse(j.createdAt);
    const opened = events.find((e) => e.type === 'pr-opened');
    if (opened) {
      withPr++;
      timeToPr.push((Date.parse(opened.ts) - created) / 60000);
    }
    if (events.some((e) => e.type === 'pr-synced' && e.newFeedback)) prWithHumanFeedback++;
    for (const e of events) {
      if (e.type !== 'agent-end') continue;
      agentRuns++;
      if (e.usage && (e.usage.totalTokens || e.usage.input || e.usage.output)) agentRunsWithUsage++;
      if (e.usage?.exact) exactRuns++;
    }
    const human = events.filter((e) => e.type === 'human');
    humanRework += human.filter((e) => e.action === 'rework').length;
    if (human.some((e) => e.action === 'approve-spec')) {
      specJobs++;
      if (!human.some((e) => e.action === 'revise-spec')) specFirstTry++;
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
  for (const s of Object.values(reviewers)) Object.assign(s, { changeRate: ratio(s.changes, s.reviews) });
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
      specFirstApprovalRate: ratio(specFirstTry, specJobs),
    },
    speed: {
      medianMinutesToPr: median(timeToPr) === null ? null : r2(/** @type {number} */ (median(timeToPr))),
      medianMinutesToDone: median(cycle) === null ? null : r2(/** @type {number} */ (median(cycle))),
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
  };
}
