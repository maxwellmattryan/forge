// The gates that run before the stage rules (secret scan, protected paths, repo proposals,
// downstream verification) and what step tells a human at a gate.
import path from 'node:path';
import { downstreamRepos } from '../../project/downstream.ts';
import { pastTotalCeiling, totalRoundCeiling } from '#office/foreman.ts';
import { issueLinkStatus, prLinkNote } from '#core/job/issue-link.ts';
import { protectedApproved, protectedReason } from '../../guard/protected.ts';
import { pendingRepoProposals } from '../../project/repo-proposals.ts';
import type { VerifyRun, WaitingOn } from '#core/types.ts';
import type { StepInput } from '../types.ts';
import { SAFE_REF } from '#core/text.ts';
import { SAFE_URL, park, run, safe, set, toStage } from './actions.ts';
import { after, afterIdx, agent, human, lastEvent, lastIdx, orNull, p, ref } from './facts.ts';
import type { Ctx, Rule, RuleId, Table } from './rules.ts';

const CI_CAP_REASON = /^CI rework cap: [A-Za-z0-9 ._/,:#?-]{1,600}$/;

function escalationFile(x: StepInput): string {
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
      if (reason.startsWith('recall eval') && x.recall?.invalidFixtures)
        return `${id} changes reviewer prompts, but the main checkout's recall fixtures do not load (${reason}). Fix them on the base branch (forge eval recall list names each problem) and run the recall eval (${ref(x, 'recall.md')}), /forge approve ${id} to waive it, or /forge rework ${id} <note>`;
      if (reason.startsWith('recall eval'))
        return `${id} changes reviewer prompts and has no recorded recall eval for them (${reason}). Run the recall eval (${ref(x, 'recall.md')}) once more, /forge approve ${id} to waive it, or /forge rework ${id} <note>`;
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
  // The reason's check names passed lib/engine/pr/lifecycle.ts CHECK_NAME; this pattern holds it to that class again.
  if (j.reason?.startsWith('CI rework cap:'))
    lines.push(`${j.id}: ${safe(j.reason, CI_CAP_REASON, 'CI rework cap reached')}. /forge rework ${j.id} <note> once a human has looked`);
  return lines.join('\n');
}

// ---------- SC: secret scan ----------

interface SecretCtx extends Ctx {
  last: VerifyRun | undefined;
  /** The last verify failed on the secret scan and no builder or integrator ran since (a rework hands back to V1/IG7). */
  blocked: boolean;
  /** pr open's scan refused since the last open and the last verify, and no human approved since. */
  refused: boolean;
}

function secretContext(c: Ctx): SecretCtx {
  const { x } = c;
  const last = x.job.verifyRuns.at(-1);
  const blocked = Boolean(last && !last.ok && last.failure === 'secrets' && !['builder', 'integrator'].some((r) => after(agent(x, r)?.endedAt, last.at)));
  let refused = false;
  if (x.job.stage === 'pr') {
    const at = lastIdx(x, (e) => e.type === 'secret-found' && e.gate === 'pr' && e.blocked === true);
    const opened = lastIdx(x, (e) => e.type === 'pr-opened' || e.type === 'pr-updated');
    const approved = lastIdx(x, (e) => e.type === 'human' && e.action === 'approve');
    refused = afterIdx(at, orNull(opened)) && after(x.events[at].ts, last?.at) && !afterIdx(approved, at);
  }
  return { ...c, last, blocked, refused };
}

const failEval = (x: StepInput, rule: RuleId, reason: string) => set(x, rule, { state: 'failed', reason: `eval: ${reason}` }, 'an eval job has no human to clear a secret');
const blockedReason = (c: SecretCtx) => `secret scan blocked verify round ${Number(c.last?.round) || 0}`;
const PR_REASON = 'secret scan blocked pr open';

/**
 * SC1–SC3b: a likely credential stopped verify or `pr open`. No agent retry gets past it: the job
 * parks on `human` until a human removes or allowlists the value and approves, and then the scan
 * runs again (SC2, or PR3 after SC3b), which parks it again if the value is still there. An eval job
 * fails instead (SC1, SC3): it has no human.
 */
export const SECRETS: Table<SecretCtx> = {
  name: 'secrets',
  applies: ({ x }) => ['verify', 'integrate', 'pr'].includes(x.job.stage),
  context: secretContext,
  rules: [
    { id: 'SC2', when: (c) => c.blocked && after(human(c.x, 'approve')?.ts, c.last?.at), then: ({ x }) => run(x, 'SC2', ['verify', x.job.id], 'a human cleared the secret scan: scan again') },
    { id: 'SC1', when: (c) => c.blocked && c.x.job.kind === 'eval', then: (c) => failEval(c.x, 'SC1', blockedReason(c)) },
    { id: 'SC1b', when: (c) => c.blocked, then: (c) => park(c.x, 'SC1b', 'human', blockedReason(c)) },
    { id: 'SC3', when: (c) => c.refused && c.x.job.kind === 'eval', then: (c) => failEval(c.x, 'SC3', PR_REASON) },
    { id: 'SC3b', when: (c) => c.refused, then: (c) => park(c.x, 'SC3b', 'human', PR_REASON) },
  ],
};

// ---------- PP: protected paths ----------

/** PP1: the job changes escalate paths no human approved since their current content was recorded. Shared by the pr gate and decide. */
export const PP1: Rule = {
  id: 'PP1',
  when: ({ x }) => {
    const flag = x.job.protectedPaths;
    return Boolean(flag?.hits?.length) && x.job.kind !== 'eval' && !protectedApproved(flag!, x.events);
  },
  then: ({ x }) => park(x, 'PP1', 'human', protectedReason(x.job.protectedPaths!)),
};

const BACK = 'a path the protected-paths policy refuses is on the branch';

/**
 * In the pr stage, a path the policy refuses is on the branch: back to build, so PR2 and PR3 can't
 * loop on it (PP2: verify failed on it; PP2b: pr open refused it since the last open and verify).
 * Then a flag raised after decide (by pr open, say) parks the job like PP1 in decide.
 */
export const PROTECTED: Table = {
  name: 'protected',
  applies: ({ x }) => x.job.stage === 'pr',
  rules: [
    {
      id: 'PP2',
      when: ({ x }) => {
        const last = x.job.verifyRuns.at(-1);
        return Boolean(last && !last.ok && last.failure === 'protected' && !after(agent(x, 'builder')?.endedAt, last.at));
      },
      then: ({ x }) => toStage(x, 'PP2', 'build', BACK),
    },
    {
      id: 'PP2b',
      when: ({ x }) => {
        const at = lastIdx(x, (e) => e.type === 'protected-path' && e.gate === 'pr' && e.action === 'refuse');
        const opened = lastIdx(x, (e) => e.type === 'pr-opened' || e.type === 'pr-updated');
        return afterIdx(at, orNull(opened)) && after(x.events[at].ts, x.job.verifyRuns.at(-1)?.at);
      },
      then: ({ x }) => toStage(x, 'PP2b', 'build', BACK),
    },
    PP1,
  ],
};

// ---------- RP: repo proposals ----------

/** At most this many repo names in RP1's reason; the rest are counted. */
const RP1_NAMES = 5;

/**
 * RP1: an agent proposed a member repo and no decision covers it yet, so the job waits on a human
 * (or the foreman, when allowed) before anything else in the stage runs. RP2: an approved repo, or
 * one a human added mid-job, has no worktree yet. Names come from events but pass REPO_NAME, which
 * sits inside shellLine's safe class.
 */
export const PROPOSALS: Table<Ctx & { names: string[] }> = {
  name: 'proposals',
  applies: ({ x }) => !['backlog', 'pr', 'done'].includes(x.job.stage),
  context: (c) => ({ ...c, names: pendingRepoProposals(c.x.job, c.x.events).map((r) => r.repo) }),
  rules: [
    {
      id: 'RP1',
      when: (c) => c.names.length > 0,
      then: ({ x, names }) => park(x, 'RP1', 'human', `repo proposal: ${names.slice(0, RP1_NAMES).join(', ')}${names.length > RP1_NAMES ? ` +${names.length - RP1_NAMES} more` : ''}`),
    },
    { id: 'RP2', when: ({ x }) => x.memberWorktreesMissing, then: ({ x }) => run(x, 'RP2', ['worktree', 'create', x.job.id], 'an approved repo needs its worktree') },
  ],
};

// ---------- DS: downstream verification ----------

/**
 * DS1: in build and verify, a changed repo has a linked consumer to add that the latest
 * `downstream-checked` event does not name, so `forge job repo downstream` runs (once per new
 * candidate: one it skipped, a failing clone included, waits for a human to run it again).
 */
export const DOWNSTREAM: Table = {
  name: 'downstream',
  applies: ({ x }) => (x.job.stage === 'build' || x.job.stage === 'verify') && x.job.kind !== 'eval' && x.config.downstream?.enabled === true,
  rules: [
    {
      id: 'DS1',
      when: ({ x }) => {
        const { add } = downstreamRepos(x.config, x.job, x.events, path.basename(x.root));
        const checked = lastEvent(x, (e) => e.type === 'downstream-checked');
        const named = new Set<unknown>([...(Array.isArray(checked?.added) ? checked.added : []), ...(Array.isArray(checked?.skipped) ? checked.skipped.map((s: any) => s?.repo) : [])]);
        return add.length > 0 && !add.every((name) => named.has(name));
      },
      then: ({ x }) => run(x, 'DS1', ['job', 'repo', 'downstream', x.job.id], 'a changed library has consumers to verify'),
    },
  ],
};
