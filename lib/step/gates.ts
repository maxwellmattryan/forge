// The gates that run before the stage rules (secret scan, protected paths, repo proposals,
// downstream verification) and what step tells a human at a gate.
import path from 'node:path';
import { downstreamRepos } from '../downstream.ts';
import { pastTotalCeiling, totalRoundCeiling } from '../foreman.ts';
import { issueLinkStatus, prLinkNote } from '../issue-link.ts';
import { protectedApproved, protectedReason } from '../protected.ts';
import { pendingRepoProposals } from '../repo-proposals.ts';
import type { RuleId } from './rules.ts';
import type { StepAction, StepInput, WaitingOn } from '../types.ts';
import { SAFE_REF } from '../util.ts';
import { SAFE_URL, park, run, safe, set, toStage } from './actions.ts';
import { after, agent, human, lastEvent, p } from './facts.ts';

const CI_CAP_REASON = /^CI rework cap: [A-Za-z0-9 ._/,:#?-]{1,600}$/;

export function escalationFile(x: StepInput): string {
  switch (x.job.stage) {
    case 'plan':
      return p(x, 'plan');
    case 'spec':
    case 'design':
      return p(x, 'spec');
    case 'build':
    case 'verify':
      return p(x, 'verify');
    case 'review':
      return p(x, 'reviewDir');
    case 'integrate':
      return x.present.includes(p(x, 'integrationReview')) ? p(x, 'integrationReview') : p(x, 'build');
    default:
      return p(x, 'decision');
  }
}

/** What to tell the human at a gate: fixed text around ids, absolute paths, numbers and config names. */
export function gateTell(x: StepInput, waitingOn: WaitingOn): string {
  const j = x.job;
  const id = j.id;
  const reason = j.reason ?? 'no reason recorded';
  switch (waitingOn) {
    case 'spec-approval': {
      const line = `${id} spec ready: ${p(x, 'spec')}${x.files.mockup ? ` · mockup ${p(x, 'mockup')}` : ''}. /forge approve ${id} or /forge revise ${id} <note>`;
      // Computed live, so a job linked while it waits drops back to the one line.
      return issueLinkStatus(j, x.config) === 'missing' ? `${line}\n${gateTell(x, 'issue-link')}` : line;
    }
    case 'split-approval':
      return `${id} planner proposes ${x.plan.jobs} jobs: ${p(x, 'plan')}. /forge approve ${id} to create them, or /forge revise ${id} [note] to keep one job`;
    case 'issue-link':
      return `${id} needs an issue: candidates in ${path.join(x.jobDir, 'issue-candidates.md')} (untrusted). /forge approve ${id} <ref> | new | none [reason]`;
    case 'input':
      return `${id} has questions: ${p(x, 'questions')}. /forge answer ${id} <text>`;
    case 'escalation':
      return `${id} escalated (${reason}): see ${escalationFile(x)}. /forge approve ${id} or /forge rework ${id} <note>`;
    case 'rounds-exhausted':
      if (pastTotalCeiling(x.config, j))
        return `${id} reached the total-round ceiling (${totalRoundCeiling(x.config, j)} rounds): only a human may clear it. /forge approve ${id} to ship, or /forge rework ${id} <note>`;
      return `${id} used all ${j.maxRounds} rounds. /forge approve ${id} to ship, or /forge rework ${id} <note>`;
    case 'infra':
      return `${id} waits on runbook steps before merge: ${p(x, 'runbook')}. /forge continue ${id} when done`;
    case 'conflicts':
      return `${id} conflicts with ${safe(j.base, SAFE_REF, 'its base branch')}. /forge approve ${id} to have the integrator fix them`;
    case 'budget': {
      if (!reason.startsWith('repo budget:'))
        return `${id} over budget: ${reason}. /forge approve ${id} to acknowledge, or raise it: forge job budget ${id} --set usd=…`;
      // The repo cap is lifted by a human's ack of the period, never by approving or a per-job budget.
      const at = x.now;
      const month = reason.includes('this month');
      return `${id} held by the repo budget (${reason}). A human runs forge budget ack --period ${month ? at.slice(0, 7) : at.slice(0, 10)}, or raises budget.${month ? 'usdPerMonth' : 'usdPerDay'} in .forge/config.yml; the job resumes once the repo is under its cap`;
    }
    case 'pr-review':
      return prReviewTell(x);
    case 'human':
      if (reason.startsWith('repo proposal:'))
        return `${id} proposes repos (${reason}): ${path.join(x.jobDir, 'repo-proposals.md')}. Approve or reject in the dashboard, or in your own terminal: forge job human ${id} approve-repos|reject-repos --repo <names> --note …`;
      if (reason.startsWith('protected paths'))
        return `${id} changed protected paths (${reason}). Diff: ${path.join(x.jobDir, 'protected.diff')}. /forge approve ${id} once a human has reviewed them, or /forge rework ${id} <note>`;
      if (reason.startsWith('secret scan'))
        return `${id} stopped on a possible secret (${reason}). Masked findings and fingerprints: forge secrets scan ${id}. Remove the value (rewrite the branch if it was committed) or add its fingerprint to .forge/secrets-allow.txt in the main checkout, then /forge approve ${id} to scan again, or /forge rework ${id} <note>`;
      return `${id} needs a human: ${reason}. /forge approve ${id} once it is resolved, or /forge rework ${id} <note>`;
    default:
      return `${id} waits: ${reason}`;
  }
}

export function prReviewTell(x: StepInput): string {
  const j = x.job;
  const lines = [`${j.id} PR ${safe(j.pr?.url, SAFE_URL, `#${Number(j.pr?.number) || '?'}`)} waits on review`];
  if (prLinkNote(j, x.config).unlinked) lines.push(`${j.id} has no linked issue: \`forge job link ${j.id} <ref>\` or \`--none\``);
  // The reason's check names passed lib/pr.ts CHECK_NAME; this pattern holds it to that class again.
  if (j.reason?.startsWith('CI rework cap:'))
    lines.push(`${j.id}: ${safe(j.reason, CI_CAP_REASON, 'CI rework cap reached')}. /forge rework ${j.id} <note> once a human has looked`);
  return lines.join('\n');
}

/**
 * SC1–SC3: a likely credential stopped verify or `pr open`. No agent retry gets past it: the job
 * parks on `human` until a human removes or allowlists the value and approves, and then the scan
 * runs again (SC2, or PR3 after SC3), which parks it again if the value is still there. A builder or
 * integrator that ran since the failing verify (a rework) hands the decision back to V1/IG7.
 */
export function secretGate(x: StepInput): StepAction | null {
  const j = x.job;
  if (j.stage !== 'verify' && j.stage !== 'integrate' && j.stage !== 'pr') return null;
  const stop = (rule: RuleId, reason: string) =>
    j.kind === 'eval' ? set(x, rule, { state: 'failed', reason: `eval: ${reason}` }, 'an eval job has no human to clear a secret') : park(x, rule, 'human', reason);
  const last = j.verifyRuns.at(-1);
  if (last && !last.ok && last.failure === 'secrets' && !['builder', 'integrator'].some((r) => after(agent(x, r)?.endedAt, last.at))) {
    if (after(human(x, 'approve')?.ts, last.at)) return run(x, 'SC2', ['verify', j.id], 'a human cleared the secret scan: scan again');
    return stop('SC1', `secret scan blocked verify round ${Number(last.round) || 0}`);
  }
  if (j.stage === 'pr') {
    const refused = lastEvent(x, (e) => e.type === 'secret-found' && e.gate === 'pr' && e.blocked === true);
    const opened = lastEvent(x, (e) => e.type === 'pr-opened' || e.type === 'pr-updated');
    if (refused && after(refused.ts, opened?.ts) && after(refused.ts, last?.at) && !after(human(x, 'approve')?.ts, refused.ts)) return stop('SC3', 'secret scan blocked pr open');
  }
  return null;
}

/** PP1: the job changes escalate paths no human approved since their current content was recorded. */
export function protectedPark(x: StepInput): StepAction | null {
  const flag = x.job.protectedPaths;
  if (!flag?.hits?.length || x.job.kind === 'eval' || protectedApproved(flag, x.events)) return null;
  return park(x, 'PP1', 'human', protectedReason(flag));
}

/**
 * PP2 then PP1 in the pr stage. A path the policy refuses is on the branch (verify failed on it, or
 * pr open refused it since the last open and verify): back to build, so PR2 and PR3 can't loop on
 * it. Then a flag raised after decide (by pr open, say) parks the job like PP1 in decide.
 */
export function protectedGate(x: StepInput): StepAction | null {
  const j = x.job;
  if (j.stage !== 'pr') return null;
  const last = j.verifyRuns.at(-1);
  const back = () => toStage(x, 'PP2', 'build', 'a path the protected-paths policy refuses is on the branch');
  if (last && !last.ok && last.failure === 'protected' && !after(agent(x, 'builder')?.endedAt, last.at)) return back();
  const refused = lastEvent(x, (e) => e.type === 'protected-path' && e.gate === 'pr' && e.action === 'refuse');
  const opened = lastEvent(x, (e) => e.type === 'pr-opened' || e.type === 'pr-updated');
  if (refused && after(refused.ts, opened?.ts) && after(refused.ts, last?.at)) return back();
  return protectedPark(x);
}

/** At most this many repo names in RP1's reason; the rest are counted. */
const RP1_NAMES = 5;

/**
 * RP1: an agent proposed a member repo and no decision covers it yet, so the job waits on a human
 * (or the foreman, when allowed) before anything else in the stage runs. RP2: an approved repo, or
 * one a human added mid-job, has no worktree yet. Names come from events but pass REPO_NAME, which
 * sits inside shellLine's safe class.
 */
export function repoProposalGate(x: StepInput): StepAction | null {
  const j = x.job;
  if (j.stage === 'backlog' || j.stage === 'pr' || j.stage === 'done') return null;
  const names = pendingRepoProposals(j, x.events).map((r) => r.repo);
  if (names.length) {
    const shown = names.slice(0, RP1_NAMES).join(', ') + (names.length > RP1_NAMES ? ` +${names.length - RP1_NAMES} more` : '');
    return park(x, 'RP1', 'human', `repo proposal: ${shown}`);
  }
  if (x.memberWorktreesMissing) return run(x, 'RP2', ['worktree', 'create', j.id], 'an approved repo needs its worktree');
  return null;
}

/**
 * DS1: in build and verify, a changed repo has a linked consumer to add that the latest
 * `downstream-checked` event does not name, so `forge job repo downstream` runs (once per new
 * candidate: one it skipped, a failing clone included, waits for a human to run it again).
 */
export function downstreamGate(x: StepInput): StepAction | null {
  const j = x.job;
  if ((j.stage !== 'build' && j.stage !== 'verify') || j.kind === 'eval' || x.config.downstream?.enabled !== true) return null;
  const { add } = downstreamRepos(x.config, j, x.events, path.basename(x.root));
  if (!add.length) return null;
  const checked = lastEvent(x, (e) => e.type === 'downstream-checked');
  const named = new Set<unknown>([...(Array.isArray(checked?.added) ? checked.added : []), ...(Array.isArray(checked?.skipped) ? checked.skipped.map((s: any) => s?.repo) : [])]);
  if (add.every((name) => named.has(name))) return null;
  return run(x, 'DS1', ['job', 'repo', 'downstream', j.id], 'a changed library has consumers to verify');
}
