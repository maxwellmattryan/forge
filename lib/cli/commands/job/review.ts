// `forge job round|verdicts|gate|decision|score`: review rounds, the reviewers' verdicts, the gate reasons, the approver's
// decision (or Forge's own APPROVE on a clean pass), and the post-merge score.
import path from 'node:path';
import { enforceBudget } from '#engine/metrics/budget.ts';
import { recordGate, summaryEscalates } from '#engine/pipeline/moves/gate-reasons.ts';
import { ensureReviewDir, jobDir, loadJob, logEvent, parseDecision, readEvents, roundVerdicts, setJob, updateJob } from '#core/job/store.ts';
import { exists } from '#core/paths.ts';
import { AGENT_TEXT_MAX, readRegularText, writeTextAtomic } from '#core/os/fs.ts';
import { loadStepInput } from '#engine/pipeline/step/input.ts';
import { cleanDecidedSince, cleanPass, renderCleanDecision, renderCleanPr } from '#engine/pipeline/moves/clean-pass.ts';
import { isMap } from '#core/shape.ts';
import { memberRepos, trustedMemberWorktree } from '#engine/project/job-repos.ts';
import { isLens, lensRepoAllowed, reviewedRepoNames } from '#core/job/lens.ts';
import { recordScore } from '#engine/evals/scoring.ts';
import { git, historyEnv } from '#integrations/git/runner.ts';
import { pullPrHead } from '#engine/pr/branch.ts';
import { FULL_SHA, lastDecision } from '#engine/pr/eligible.ts';
import { after, afterIdx, computeFacts, lastIdx, orNull } from '#engine/pipeline/step/facts.ts';
import { gateSince } from '#engine/pipeline/moves/escalation.ts';
import { ForgeError } from '#core/errors.ts';
import type { Config, Job, JobEvent } from '#core/types.ts';
import { list, req, requireJob, usageError } from '../args.ts';
import { JOB } from './help.ts';

export function round(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  // Checked before incrementing, so after approval re-running `forge job round` starts the round.
  const budget = enforceBudget(root, config, req(id, 'job id'), 'round');
  if (budget) {
    const j = loadJob(root, String(id));
    return { round: j.round, maxRounds: j.maxRounds, exhausted: j.round > j.maxRounds, budget };
  }
  const job = updateJob(root, String(id), (j) => {
    j.round += 1;
  });
  ensureReviewDir(root, job.id, job.round);
  logEvent(root, job.id, 'round', { round: job.round });
  // A rework round on an open PR starts from the PR's head, whoever moved it.
  const pull = job.round > 1 ? pullPrHead(root, config, job) : null;
  return { round: job.round, maxRounds: job.maxRounds, exhausted: job.round > job.maxRounds, ...(pull && pull.pulled !== 'none' ? { pulled: pull.pulled } : {}) };
}

export function verdicts(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  const job = loadJob(root, req(id, 'job id'));
  // The integration review is a mini round after conflict resolution; it is logged as an
  // event only, because stats, retro and the dashboard read job.verdicts keys as numbers.
  const integration = flags.round === 'integration';
  if (flags.round !== undefined && !integration && !/^[1-9]\d*$/.test(String(flags.round))) throw new ForgeError('--round must be a positive integer or "integration"', 'usage');
  const round: number | 'integration' = integration ? 'integration' : Number(flags.round ?? job.round);
  // Only the review in progress is recorded: an earlier round's record is what the gate reasons read, so it is never written again.
  if (!integration && round !== job.round) throw new ForgeError(`--round ${round} is not the job's current round (${job.round}): forge job verdicts records the current round or integration`);
  // job.reviewers is settable with --field: a qualified lens counts only for a reviewed member of the job.
  const reviewers = list(flags.reviewers).length ? list(flags.reviewers) : integration ? ['code'] : job.reviewers.filter((l) => isLens(l) && lensRepoAllowed(job, l));
  if (!reviewers.length) throw new ForgeError(`job ${id} has no reviewers selected; set them with: forge job set ${id} --field reviewers='["code","tests"]'`);
  if (flags.malformed !== undefined && flags.malformed !== 'changes') throw new ForgeError('--malformed accepts only "changes"', 'usage');
  const v = roundVerdicts(root, job.id, round, reviewers, config.review.blockOn, { malformedAs: flags.malformed });
  // The sha reviewers saw is evidence; it tells a later reader whether the review is still current.
  const sha = job.worktree && exists(job.worktree) ? git(job.worktree, ['rev-parse', 'HEAD'], { allowFail: true }).stdout.trim() || null : null;
  // Each reviewed member's HEAD beside the root's sha; only Forge's own worktree path is trusted.
  const memberHeads = Object.fromEntries(
    reviewedRepoNames(job).map((name) => {
      const wt = trustedMemberWorktree(root, config, job, name);
      return [name, wt ? git(wt, ['rev-parse', 'HEAD'], { allowFail: true }).stdout.trim() || null : null];
    }),
  );
  const heads = Object.keys(memberHeads).length ? { heads: memberHeads } : {};
  if (v.complete) {
    const verdicts = Object.fromEntries(Object.entries(v.reviewers).map(([k, r]) => [k, r.verdict]));
    const coerced = Object.entries(v.reviewers).filter(([, r]) => r.coerced).map(([k]) => k);
    if (integration) logEvent(root, job.id, 'integration-review', { outcome: v.outcome, sha, ...heads, reviewers: verdicts, coerced: coerced.length ? coerced : undefined });
    else {
      setJob(root, job.id, { fields: { [`verdicts.${round}`]: verdicts } });
      // Whether each reviewer's Summary says ESCALATE right now: gate reasons read this record, never a review file edited later.
      // Only a lens whose reviewer ran in this round (job.agents is written by forge job agent alone; a record without a round
      // is from before it was kept) is a record of it: a file planted for a lens that did not review can't become its latest.
      const reviewed = ([lens]: [string, unknown]): boolean => {
        const a = Object.hasOwn(job.agents, `reviewer:${lens}`) ? job.agents[`reviewer:${lens}`] : undefined;
        return a !== undefined && (a.round === undefined || a.round === round);
      };
      const escalate = Object.fromEntries(
        Object.entries(v.reviewers)
          .filter(reviewed)
          .map(([lens, r]) => [lens, summaryEscalates(readRegularText(path.join(jobDir(root, job.id), r.file), AGENT_TEXT_MAX))]),
      );
      logEvent(root, job.id, 'verdicts', { round, outcome: v.outcome, sha, ...heads, coerced: coerced.length ? coerced : undefined, escalate });
    }
    if (coerced.length) logEvent(root, job.id, 'note', { text: `${integration ? 'integration review' : `round ${round}`}: malformed review(s) from ${coerced.join(', ')} counted as CHANGES` });
  }
  if (flags.compact) {
    // Absolute paths, so the orchestrator can hand a re-spawned reviewer its output verbatim.
    const missing = Object.fromEntries(Object.entries(v.reviewers).filter(([, r]) => r.verdict === 'MISSING').map(([k, r]) => [k, r.path]));
    const reviewers = Object.fromEntries(Object.entries(v.reviewers).map(([k, r]) => [k, r.verdict === 'CHANGES' ? `CHANGES(${r.blocking})` : r.verdict]));
    return { round, complete: v.complete, outcome: v.outcome, sha, ...heads, reviewers, ...(Object.keys(missing).length ? { missing } : {}) };
  }
  return { ...v, sha, ...heads };
}

/** What `forge job decision` prints: the record, whether this call logged it, and the marks a gate reason or a clean pass left on it. */
type DecisionRecord = {
  decision: string | null;
  reason: string | null;
  autoMerge: boolean;
  head: string | null;
  heads?: Record<string, string | null>;
  gated?: boolean;
  clean?: boolean;
  recorded: boolean;
};

/**
 * Records the approver's decision bound to the commits it saw: the worktree HEAD and each PR
 * member's. Once per approver run: a decision.md edited after the record changes nothing until the
 * approver runs again.
 */
export function decision(root: string, config: Config, rest: string[], flags: Record<string, any>): DecisionRecord {
  const id = rest[0];
  const job = requireJob(root, id);
  if (flags.clean !== undefined) {
    if (flags.clean !== true) throw new ForgeError('--clean takes no value', 'usage');
    return cleanDecision(root, config, job);
  }
  const jobId = job.id;
  const events = readEvents(root, jobId);
  const last = events.findLast((e) => e.type === 'decision');
  if (last && after(last.ts, job.agents.approver?.endedAt)) return recordedDecision(events);
  const d = parseDecision(root, jobId);
  // A gate reason of this round holds the merge for a person whatever decision.md says: never auto-merge eligible.
  const gated = Boolean(gateSince(events, orNull(events.findLastIndex((e) => e.type === 'round')))?.reasons.length);
  const record = { decision: d.decision, reason: d.reason, autoMerge: d.autoMerge && !gated, ...decidedHeads(root, config, job), ...(gated ? { gated: true } : {}) };
  if (!d.decision) return { ...record, recorded: false };
  setJob(root, jobId, { fields: { decision: d.decision } });
  logEvent(root, jobId, 'decision', record);
  return { ...record, recorded: true };
}

/** The last `decision` event as `forge job decision` printed it, with `recorded: false`. */
function recordedDecision(events: JobEvent[]): DecisionRecord {
  const last = events.findLast((e) => e.type === 'decision')!;
  const r = lastDecision(events)!;
  return {
    decision: r.decision,
    reason: typeof last.reason === 'string' ? last.reason : null,
    autoMerge: r.autoMerge,
    head: r.head,
    ...(isMap(last.heads) ? { heads: r.heads } : {}),
    ...(last.gated === true ? { gated: true } : {}),
    ...(last.clean === true ? { clean: true } : {}),
    recorded: false,
  };
}

/** The commits a decision covers: the job worktree's HEAD, and each PR member's (`heads`) when the job has members. */
function decidedHeads(root: string, config: Config, job: Job): { head: string | null; heads?: Record<string, string | null> } {
  const headOf = (wt: string | null | undefined): string | null => {
    if (!wt || !exists(wt)) return null;
    const out = git(wt, ['rev-parse', '--verify', 'HEAD^{commit}'], { env: historyEnv(), allowFail: true }).stdout.trim();
    return FULL_SHA.test(out) ? out : null;
  };
  const members = memberRepos(job).filter((m) => !m.verifyOnly);
  return { head: headOf(job.worktree), ...(members.length ? { heads: Object.fromEntries(members.map((m) => [m.repo, headOf(trustedMemberWorktree(root, config, job, m.repo))])) } : {}) };
}

/**
 * `--clean`: Forge's own APPROVE on a clean pass (approver.skipWhenClean, step rule DC13). Re-checks the clean pass on a
 * fresh read, so a session running it by hand on any other job is refused with nothing written; once per review.
 */
function cleanDecision(root: string, config: Config, job: Job): DecisionRecord {
  const x = loadStepInput(root, config, job.id);
  const f = computeFacts(x);
  if (cleanDecidedSince(x, f)) return recordedDecision(x.events);
  const refuse = (why: string) => new ForgeError(`job ${job.id} is not a clean pass: ${why}`);
  // Any other decision since the review stands: an approver's ESCALATE is never overwritten.
  if (afterIdx(lastIdx(x, (e) => e.type === 'decision'), f.reviewedAt)) throw refuse('a decision since the review');
  const c = cleanPass(x, f);
  if ('why' in c) throw refuse(c.why);
  const dir = jobDir(root, job.id);
  const read = (name: string) => readRegularText(path.join(dir, name), AGENT_TEXT_MAX) ?? '';
  const prText = renderCleanPr({ specText: read('spec.md'), buildText: read('build.md'), jobTitle: job.title, lenses: c.lenses });
  // Atomic writes in the job dir's real path: a link planted at either name is replaced, never followed.
  writeTextAtomic(path.join(dir, 'decision.md'), renderCleanDecision(c.lenses, job.round), { root: dir });
  writeTextAtomic(path.join(dir, 'pr.md'), prText, { root: dir });
  const record = { decision: 'APPROVE', reason: null, autoMerge: false, ...decidedHeads(root, config, job), clean: true };
  setJob(root, job.id, { fields: { decision: 'APPROVE' } });
  logEvent(root, job.id, 'decision', record);
  return { ...record, recorded: true };
}

/** `forge job gate <id>`: the job's gate reasons, recorded as a `gate` event on every call. */
export function gate(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  return recordGate(root, config, requireJob(root, rest[0]).id);
}

export function score(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  if (rest[0] !== 'record' || rest.length !== 2) throw usageError(JOB, 'score');
  return recordScore(root, rest[1]);
}
