// PR: verify, open or update the PR, follow interim deferrals and releases, merge or wait on review.
import { autoMerge } from '../../core/config/load.ts';
import { deferralStatus, readDeferrals, releaseGates, releaseIndex, resolveInterim } from '../../interim.ts';
import { memberRepos } from '../../job-repos.ts';
import type { JobEvent, StepInput, VerifyRun } from '../../core/types.ts';
import { SAFE_REF } from '../../core/text.ts';
import { SAFE_ELEMENT, park, run, safe, set, toStage } from '../actions.ts';
import { after, human, lastEvent, lastIdx } from '../facts.ts';
import { inStage } from '../rules.ts';
import type { Ctx, Table } from '../rules.ts';

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
  return { first, what: `${repoWord(first.dependency)} ${safe(first.version, SAFE_VERSION, 'version')}`, runs: x.job.verifyRuns.filter((r) => after(r.at, since)) };
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
}

function context(c: Ctx): PrCtx {
  const { x } = c;
  const j = x.job;
  const res = resolveInterim(x.config, j);
  const gates = releaseGates(res.edges, x.events, j);
  const last = j.verifyRuns.at(-1);
  const pulled = lastEvent(x, (e) => e.type === 'pr-head-pulled');
  const openedAt = lastIdx(x, (e) => e.type === 'pr-opened' || e.type === 'pr-updated' || e.type === 'pr-deferred');
  const opened = x.events[openedAt] as JobEvent | undefined;
  const state = (k: string | null) => (k === null ? j.pr?.state : memberRepos(j).find((m) => m.repo === k)?.pr?.state);
  const ready = res.order.find((k) => {
    const pr = k === null ? j.pr : memberRepos(j).find((m) => m.repo === k)?.pr;
    const mine = gates.filter((g) => g.consumer === k);
    return pr?.state === 'OPEN' && pr.isDraft === true && mine.length > 0 && mine.every((g) => g.gate === 'released') && (k === null || REPO_WORD.test(k));
  });
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
  };
}

/** The deferred PR the reason names: the sequential one, else the first deferred. */
const deferredWait = (c: PrCtx) => c.deferral!.sequential ?? readDeferrals(c.opened!.deferred)[0];

/**
 * A local edge holds a consumer PR as a draft that nothing CI can build until its release is
 * recorded and bumped, a held or bump-due gate keeps it a draft, and a draft PR in a job with
 * interim edges is never merged: none of them merges unattended. A job without edges keeps its old
 * behaviour, so a single-repo `pr.draft: true` job still auto-merges (gh un-drafts it).
 */
function mergeable({ x, res, gates, openedAt }: PrCtx): boolean {
  const j = x.job;
  const local = res.edges.some((e, i) => e.strategy === 'local' && gates[i].gate !== 'released');
  const held = gates.some((g) => g.gate === 'held' || g.gate === 'bump-due');
  const draft = res.edges.length > 0 && (j.pr?.isDraft === true || memberRepos(j).some((m) => m.pr?.isDraft === true));
  return !local && !held && !draft && x.decision.autoMerge && autoMerge(x.config) && !j.protectedPaths?.hits?.length && !x.events.some((e, i) => i > openedAt && MERGE_EVENTS.includes(e.type));
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
