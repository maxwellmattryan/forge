// PR: verify, open or update the PR (unless the push is held), follow interim deferrals and releases,
// then hold the merge on an open merge gate (an escalation, a before-merge runbook, protected paths, a
// missing recall eval) until a person decides, merge, or wait on review.
import { autoMerge } from '#core/config/load.ts';
import { deferralStatus, readDeferrals, releaseGates, releaseIndex, resolveInterim } from '../../../release/interim.ts';
import { memberRepos } from '../../../project/job-repos.ts';
import { decisionEligible, lastDecision } from '../../../pr/eligible.ts';
import { protectedReason } from '../../../guard/protected.ts';
import { latestGate } from '../../moves/escalation.ts';
import { lastRun, runsSince } from '../../../verify/record.ts';
import type { JobEvent, VerifyRun, WaitingOn } from '#core/types.ts';
import type { StepInput } from '../../types.ts';
import { SAFE_REF } from '#core/text.ts';
import { SAFE_ELEMENT, park, run, safe, set, toStage } from '../actions.ts';
import { REVIEWED_HEAD_NOTE, after, afterIdx, agent, human, lastEvent, lastIdx, orNull } from '../facts.ts';
import { PP1b } from '../gates.ts';
import { recallReason, recallRecorded, recallWaived } from '../recall.ts';
import { inStage } from '../rules.ts';
import type { Ctx, Rule, Table } from '../rules.ts';

const MERGE_EVENTS = ['pr-merged', 'pr-auto-merge', 'pr-merge-deferred', 'pr-merge-refused', 'pr-merge-failed'];
const SAFE_VERSION = /^[0-9A-Za-z.+-]{1,120}$/;
const REPO_WORD = /^[A-Za-z0-9._-]+$/;
const repoWord = (k: string | null): string => (k === null ? 'the root repo' : `repo ${safe(k, REPO_WORD, 'a member')}`);

type Gate = ReturnType<typeof releaseGates>[number];

/**
 * A recorded release some consumer is not bumped to yet (a bump-due gate): the latest such release
 * by log position, what it names, and the verify runs since it (its timestamp only meets verify runs).
 */
interface Bump {
  first: Gate;
  what: string;
  runs: VerifyRun[];
}

function releaseBump(x: StepInput, gates: Gate[]): Bump | null {
  const due = gates.filter((g) => g.gate === 'bump-due');
  if (!due.length) return null;
  let latestAt = -1;
  let first = due[0];
  for (const g of due) {
    const at = releaseIndex(x.events, g.dependency);
    if (at > latestAt) {
      latestAt = at;
      first = g;
    }
  }
  const since = x.events[latestAt]?.ts ?? null;
  return { first, what: `${repoWord(first.dependency)} ${safe(first.version, SAFE_VERSION, 'version')}`, runs: runsSince(x.job, since) };
}

interface PrCtx extends Ctx {
  res: ReturnType<typeof resolveInterim>;
  gates: Gate[];
  bump: Bump | null;
  last: VerifyRun | undefined;
  /** pr open pulled the PR's remote branch after the last verify. */
  pulled: JobEvent | undefined;
  /** The last open attempt (a deferral counts, so PR3 doesn't run pr open again on the same verify) and its position. */
  openedAt: number;
  opened: JobEvent | undefined;
  /** The deferral the last open attempt recorded, when it was one. */
  deferral: ReturnType<typeof deferralStatus> | null;
  /** The first draft consumer in merge order whose every gate is released; undefined when none. */
  ready: string | null | undefined;
  /** The first open merge gate: mergeGate. */
  gate: MergeGate | null;
  /** pr open held the push after the last open and the last verify, and no human approved since. */
  pushHeld: JobEvent | undefined;
}

/** A gate that holds the merge of an open PR until a person decides: what mergeGate returns. */
export interface MergeGate {
  rule: 'PR15' | 'PR16' | 'PP1b' | 'PR17';
  waitingOn: WaitingOn;
  reason: string;
}

const ESCALATED = 'approver escalated: see decision.md';
const RUNBOOK = 'runbook: steps before merge';

/**
 * A person's approve at a park with this `waitingOn` and exactly this reason, in decide (before this
 * gate moved) or pr, given after the approver last ended. So an approve at another escalation (a
 * release bump's, say) never clears the approver's ESCALATE, and a new approver run needs a new one.
 */
function cleared({ x, f }: Ctx, waitingOn: WaitingOn, reason: string): boolean {
  const ended = agent(x, 'approver')?.endedAt;
  return f.approvals.some(
    (a) => a.park.state === 'waiting' && a.park.waitingOn === waitingOn && (a.park.stage === 'decide' || a.park.stage === 'pr') && x.events[a.parkAt]?.reason === reason && after(a.e.ts, ended),
  );
}

/**
 * The first open merge gate, in the order the pr table checks them: the approver's ESCALATE (PR15),
 * a runbook with steps before merge (PR16), escalate paths no human approved (PP1b), a missing recall
 * eval for the diff's reviewer prompts (PR17). Null when none is open. `forge pr gate` reads it too.
 */
export function mergeGate(c: Ctx): MergeGate | null {
  const { x } = c;
  if (x.decision.decision === 'ESCALATE' && !cleared(c, 'escalation', ESCALATED)) return { rule: 'PR15', waitingOn: 'escalation', reason: ESCALATED };
  if (x.runbookBeforeMerge && !cleared(c, 'infra', RUNBOOK)) return { rule: 'PR16', waitingOn: 'infra', reason: RUNBOOK };
  if (PP1b.when(c)) return { rule: 'PP1b', waitingOn: 'human', reason: protectedReason(x.job.protectedPaths!) };
  if (x.recall?.required && !recallRecorded(x) && !recallWaived(x)) return { rule: 'PR17', waitingOn: 'human', reason: recallReason(x.recall.pluginHash) };
  return null;
}

/** PR13's reason as pr open logged it: its own class, which sits inside shellLine's. */
const HELD_REASON = /^push held: [A-Za-z0-9 ._:/@=,+\-[\]"]{1,400}$/;

function context(c: Ctx): PrCtx {
  const { x } = c;
  const j = x.job;
  const res = resolveInterim(x.config, j);
  const gates = releaseGates(res.edges, x.events, j);
  const last = lastRun(j);
  const pulled = lastEvent(x, (e) => e.type === 'pr-head-pulled');
  const openedAt = lastIdx(x, (e) => e.type === 'pr-opened' || e.type === 'pr-updated' || e.type === 'pr-deferred');
  const opened = x.events[openedAt] as JobEvent | undefined;
  const state = (k: string | null) => (k === null ? j.pr?.state : memberRepos(j).find((m) => m.repo === k)?.pr?.state);
  const ready = res.order.find((k) => {
    const pr = k === null ? j.pr : memberRepos(j).find((m) => m.repo === k)?.pr;
    const mine = gates.filter((g) => g.consumer === k);
    return pr?.state === 'OPEN' && pr.isDraft === true && mine.length > 0 && mine.every((g) => g.gate === 'released') && (k === null || REPO_WORD.test(k));
  });
  const heldAt = lastIdx(x, (e) => e.type === 'push-held');
  const pushOpened = lastIdx(x, (e) => e.type === 'pr-opened' || e.type === 'pr-updated');
  const approvedAt = lastIdx(x, (e) => e.type === 'human' && e.action === 'approve');
  const pushHeld = afterIdx(heldAt, orNull(pushOpened)) && after(x.events[heldAt].ts, last?.at) && !afterIdx(approvedAt, heldAt) ? x.events[heldAt] : undefined;
  return {
    ...c,
    res,
    gates,
    bump: releaseBump(x, gates),
    last,
    pulled: pulled && after(pulled.ts, last?.at) ? pulled : undefined,
    openedAt,
    opened,
    deferral: opened?.type === 'pr-deferred' ? deferralStatus(readDeferrals(opened.deferred), state, x.events) : null,
    ready,
    gate: mergeGate(c),
    pushHeld,
  };
}

/** A merge gate's park, from the row that owns it. */
const gateRow = (rule: MergeGate['rule']): Rule<PrCtx> => ({
  id: rule,
  when: (c: PrCtx) => c.gate?.rule === rule,
  then: (c: PrCtx) => park(c.x, rule, c.gate!.waitingOn, c.gate!.reason),
});

/** The deferred PR the reason names: the sequential one, else the first deferred. */
const deferredWait = (c: PrCtx) => c.deferral!.sequential ?? readDeferrals(c.opened!.deferred)[0];

/**
 * A local edge holds a consumer PR as a draft that nothing CI can build until its release is
 * recorded and bumped, a held or bump-due gate keeps it a draft, and a draft PR in a job with
 * interim edges is never merged: none of them merges unattended. A job without edges keeps its old
 * behaviour, so a single-repo `pr.draft: true` job still auto-merges (gh un-drafts it).
 * Eligibility is the recorded decision event bound to the heads it covers (decisionCurrent), never
 * decision.md: an ESCALATE with `yes`, a `yes` written after the record, or a commit after the
 * decision all wait on a human. So does any gate reason since the review, even under a decision
 * recorded eligible before `forge job decision` knew of them: a person cleared it, and merges it.
 */
function mergeable({ x, f, res, gates, openedAt }: PrCtx): boolean {
  const j = x.job;
  const local = res.edges.some((e, i) => e.strategy === 'local' && gates[i].gate !== 'released');
  const held = gates.some((g) => g.gate === 'held' || g.gate === 'bump-due');
  const draft = res.edges.length > 0 && (j.pr?.isDraft === true || memberRepos(j).some((m) => m.pr?.isDraft === true));
  const eligible = decisionEligible(lastDecision(x.events)) && x.decisionCurrent === true;
  const gated = Boolean(latestGate(x.events, f.reviewedAt)?.reasons.length);
  return !local && !held && !draft && eligible && !gated && autoMerge(x.config) && !j.protectedPaths?.hits?.length && !x.events.some((e, i) => i > openedAt && MERGE_EVENTS.includes(e.type));
}

/** PR5's reason. Plain words only: it goes through shellLine, which allows no quote, pipe or angle bracket. */
function waitReason({ x, gates }: PrCtx): string | undefined {
  const held = gates.find((g) => g.gate === 'held' || g.gate === 'bump-due');
  if (!held) return undefined;
  if (held.gate === 'held')
    return `${repoWord(held.consumer)} PR stays a draft until the release of ${repoWord(held.dependency)} is recorded [interim: ${held.strategy}]: a human runs forge job interim release ${x.job.id} ${held.dependency === null ? '--root' : safe(held.dependency, REPO_WORD, '<repo>')} VERSION`;
  return `${repoWord(held.consumer)} PR waits on its release bump: forge verify ${x.job.id}`;
}

export const PR: Table<PrCtx> = {
  name: 'pr',
  applies: inStage('pr'),
  context,
  rules: [
    // A commit after the review panel is unreviewed: it is never verified, pushed or merged on the old verdict (reviewCurrent).
    { id: 'PR12', when: ({ x }) => x.reviewCurrent === false, then: ({ x }) => toStage(x, 'PR12', 'review', 'a commit after review is unreviewed: review the new head', { note: REVIEWED_HEAD_NOTE }) },
    {
      id: 'PR1',
      when: ({ x }) => !x.config.pr.enabled,
      then: ({ x }) => toStage(x, 'PR1', 'done', 'PRs are off: the branch is the result', { tell: `${x.job.id} finished on branch ${safe(x.job.branch, SAFE_REF, 'its branch')}` }),
    },
    // PR9–PR9c: verify bumps the consumers, unless a verify newer than the release failed (park, until
    // a human approves after it, then PR2 verifies again) or passed without bumping (park).
    { id: 'PR9', when: (c) => Boolean(c.bump && !c.bump.runs.length), then: (c) => run(c.x, 'PR9', ['verify', c.x.job.id], `release of ${c.bump!.what} recorded: bump its consumers and verify`) },
    {
      id: 'PR9b',
      when: ({ x, bump }) => Boolean(bump && !bump.runs.at(-1)!.ok && !after(human(x, 'approve')?.ts, bump.runs.at(-1)!.at)),
      then: (c) => park(c.x, 'PR9b', 'escalation', `release bump: verify failed after the release of ${c.bump!.what}`),
    },
    { id: 'PR9c', when: (c) => Boolean(c.bump?.runs.at(-1)?.ok), then: (c) => park(c.x, 'PR9c', 'escalation', `release bump: verify passed without bumping ${repoWord(c.bump!.first.consumer)}`) },
    { id: 'PR2', when: (c) => !c.last?.ok, then: ({ x }) => run(x, 'PR2', ['verify', x.job.id], 'pr open needs a verified HEAD') },
    // pr open pulled a PR branch that moved on the remote: a merged HEAD is not the one verified, and a
    // conflicting one needs a person (integrate merges the base, not the PR's remote branch).
    {
      id: 'PR11',
      when: (c) => c.pulled?.pulled === 'conflicts',
      then: ({ x }) => park(x, 'PR11', 'human', `the PR branch moved on the remote and conflicts with the job HEAD: a human merges it in the worktree, then runs forge verify ${x.job.id}`),
    },
    { id: 'PR2b', when: (c) => c.pulled !== undefined, then: ({ x }) => run(x, 'PR2b', ['verify', x.job.id], 'the PR branch moved on the remote and was merged in: verify the merged HEAD') },
    // pr open held the push (CI config, a security review that isn't PASS, reported secrets): a person
    // approves at exactly this reason, then PR3 opens again. pr open is the enforcer; this only parks.
    {
      id: 'PR13',
      when: (c) => c.pushHeld !== undefined,
      then: (c) => park(c.x, 'PR13', 'human', safe(typeof c.pushHeld!.reason === 'string' ? c.pushHeld!.reason : null, HELD_REASON, 'push held: see forge pr open')),
    },
    { id: 'PR3', when: (c) => !after(c.opened?.ts, c.last!.at), then: ({ x }) => run(x, 'PR3', ['pr', 'open', x.job.id], 'push and open or update the PR') },
    // PR6–PR8: the last pr open deferred some PRs; recorded PR states and canary events say what happens next.
    {
      id: 'PR6',
      when: (c) => Boolean(c.deferral?.canary),
      then: (c) => {
        const canary = c.deferral!.canary!;
        const dep = canary.waitingOn[0];
        const pkg = safe(`${canary.name}@${canary.version}`, SAFE_ELEMENT, 'its package');
        const cmd = `forge job interim publish ${c.x.job.id} ${dep === null ? '--root' : safe(dep, REPO_WORD, '<repo>')} --confirm`;
        return park(c.x, 'PR6', 'human', `${repoWord(canary.repo)} waits on a canary of ${repoWord(dep)} [${pkg}]: a human runs ${cmd}`);
      },
    },
    { id: 'PR7', when: (c) => Boolean(c.deferral?.openable), then: ({ x }) => run(x, 'PR7', ['pr', 'open', x.job.id], 'every deferred PR can open now: its dependencies merged or the canary is published') },
    {
      id: 'PR8',
      when: (c) => c.deferral !== null,
      then: (c) => {
        const w = deferredWait(c);
        const reason = w ? `${repoWord(w.repo)} PR opens after ${w.waitingOn.map(repoWord).join(', ')} merges [interim: sequential]` : 'a deferred PR waits on its dependencies';
        return set(c.x, 'PR8', { stage: 'pr', state: 'waiting', waitingOn: 'pr-review', reason }, 'a deferred PR opens once its dependencies merge');
      },
    },
    {
      id: 'PR10',
      when: (c) => c.ready !== undefined,
      then: ({ x, ready }) => run(x, 'PR10', ['pr', 'ready', x.job.id, ...(ready === null ? ['--root'] : ['--repo', ready!])], 'release recorded and consumers bumped: mark the consumer ready for review'),
    },
    // PR14: an open merge gate the PR doesn't say yet (no sync of this gate since the last push): the
    // gate section and label first, so the person reads why on the PR.
    {
      id: 'PR14',
      when: (c) => {
        if (!c.gate || c.x.job.pr?.state !== 'OPEN') return false;
        const at = lastIdx(c.x, (e) => e.type === 'pr-gate');
        const e = c.x.events[at];
        return !(e && e.action === 'set' && e.rule === c.gate.rule && e.reason === c.gate.reason && afterIdx(at, orNull(c.openedAt)));
      },
      then: ({ x }) => run(x, 'PR14', ['pr', 'gate', x.job.id], 'say on the PR why it waits on a decision before merge'),
    },
    // PR15–PR17, PP1b: the merge gates, after the push, in mergeGate's order. The first open one parks
    // the job, so an open merge gate always comes before PR4.
    gateRow('PR15'),
    gateRow('PR16'),
    PP1b,
    gateRow('PR17'),
    // PR18: no merge gate is open, and the PR still says one is: clear the label and the section.
    {
      id: 'PR18',
      when: (c) => !c.gate && c.x.job.pr?.state === 'OPEN' && lastEvent(c.x, (e) => e.type === 'pr-gate')?.action === 'set',
      then: ({ x }) => run(x, 'PR18', ['pr', 'gate', x.job.id], 'the merge no longer waits on a decision: say so on the PR'),
    },
    { id: 'PR4', when: mergeable, then: ({ x }) => run(x, 'PR4', ['pr', 'merge', x.job.id], 'the approver marked it auto-merge eligible') },
    {
      id: 'PR5',
      when: () => true,
      then: (c) => {
        const reason = waitReason(c);
        return set(c.x, 'PR5', { stage: 'pr', state: 'waiting', waitingOn: 'pr-review', ...(reason ? { reason } : {}) }, 'the PR waits on human review');
      },
    },
  ],
};
