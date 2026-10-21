// PR: verify, open or update the PR, follow interim deferrals and releases, merge or wait on review.
import { autoMerge } from '../../config.ts';
import { deferralStatus, readDeferrals, releaseGates, releaseIndex, resolveInterim } from '../../interim.ts';
import { memberRepos } from '../../job-repos.ts';
import type { JobEvent, StepAction, StepInput } from '../../types.ts';
import { SAFE_REF } from '../../util.ts';
import { SAFE_ELEMENT, park, run, safe, set, toStage } from '../actions.ts';
import { after, human, lastEvent } from '../facts.ts';

const MERGE_EVENTS = ['pr-merged', 'pr-auto-merge', 'pr-merge-deferred', 'pr-merge-refused', 'pr-merge-failed'];
const SAFE_VERSION = /^[0-9A-Za-z.+-]{1,120}$/;
const REPO_WORD = /^[A-Za-z0-9._-]+$/;
const repoWord = (k: string | null): string => (k === null ? 'the root repo' : `repo ${safe(k, REPO_WORD, 'a member')}`);

export function pr(x: StepInput): StepAction {
  const j = x.job;
  if (!x.config.pr.enabled) return toStage(x, 'PR1', 'done', 'PRs are off: the branch is the result', { tell: `${j.id} finished on branch ${safe(j.branch, SAFE_REF, 'its branch')}` });
  const res = resolveInterim(x.config, j);
  const edges = res.edges;
  const gates = releaseGates(edges, x.events, j);
  const bump = releaseBump(x, gates);
  if (bump) return bump;
  const last = j.verifyRuns.at(-1);
  if (!last?.ok) return run(x, 'PR2', ['verify', j.id], 'pr open needs a verified HEAD');
  // pr open pulled a PR branch that moved on the remote: a merged HEAD is not the one verified, and a
  // conflicting one needs a person (integrate merges the base, not the PR's remote branch).
  const pulled = lastEvent(x, (e) => e.type === 'pr-head-pulled');
  if (after(pulled?.ts, last.at)) {
    if (pulled!.pulled === 'conflicts')
      return park(x, 'PR11', 'human', `the PR branch moved on the remote and conflicts with the job HEAD: a human merges it in the worktree, then runs forge verify ${j.id}`);
    return run(x, 'PR2', ['verify', j.id], 'the PR branch moved on the remote and was merged in: verify the merged HEAD');
  }
  // The last open attempt: a deferral counts, so PR3 doesn't run pr open again on the same verify.
  const opened = lastEvent(x, (e) => e.type === 'pr-opened' || e.type === 'pr-updated' || e.type === 'pr-deferred');
  if (!after(opened?.ts, last.at)) return run(x, 'PR3', ['pr', 'open', j.id], 'push and open or update the PR');
  if (opened!.type === 'pr-deferred') return deferredPr(x, opened!);
  // The first draft consumer in merge order whose every gate is released leaves draft.
  for (const k of res.order) {
    const p = k === null ? j.pr : memberRepos(j).find((m) => m.repo === k)?.pr;
    const mine = gates.filter((g) => g.consumer === k);
    if (p?.state !== 'OPEN' || p.isDraft !== true || !mine.length || !mine.every((g) => g.gate === 'released')) continue;
    if (k !== null && !REPO_WORD.test(k)) continue;
    return run(x, 'PR10', ['pr', 'ready', j.id, ...(k === null ? ['--root'] : ['--repo', k])], 'release recorded and consumers bumped: mark the consumer ready for review');
  }
  // A local edge holds a consumer PR as a draft that nothing CI can build until its release is
  // recorded and bumped, a held or bump-due gate keeps it a draft, and a draft PR in a job with
  // interim edges is never merged: none of them merges unattended. A job without edges keeps its old
  // behaviour, so a single-repo `pr.draft: true` job still auto-merges (gh un-drafts it).
  const local = edges.some((e, i) => e.strategy === 'local' && gates[i].gate !== 'released');
  const held = gates.find((g) => g.gate === 'held' || g.gate === 'bump-due');
  const draft = edges.length > 0 && (j.pr?.isDraft === true || memberRepos(j).some((m) => m.pr?.isDraft === true));
  if (!local && !held && !draft && x.decision.autoMerge && autoMerge(x.config) && !j.protectedPaths?.hits?.length && !lastEvent(x, (e) => MERGE_EVENTS.includes(e.type) && after(e.ts, opened!.ts)))
    return run(x, 'PR4', ['pr', 'merge', j.id], 'the approver marked it auto-merge eligible');
  // Plain words only: the reason goes through shellLine, which allows no quote, pipe or angle bracket.
  const reason =
    held?.gate === 'held'
      ? `${repoWord(held.consumer)} PR stays a draft until the release of ${repoWord(held.dependency)} is recorded [interim: ${held.strategy}]: a human runs forge job interim release ${j.id} ${held.dependency === null ? '--root' : safe(held.dependency, REPO_WORD, '<repo>')} VERSION`
      : held
        ? `${repoWord(held.consumer)} PR waits on its release bump: forge verify ${j.id}`
        : undefined;
  return set(x, 'PR5', { stage: 'pr', state: 'waiting', waitingOn: 'pr-review', ...(reason ? { reason } : {}) }, 'the PR waits on human review');
}

/**
 * PR9: a release is recorded and some consumer is not bumped to it yet (a bump-due gate). Verify
 * bumps it, unless a verify newer than the record failed (park, until a human approves after it) or
 * passed without bumping (park).
 */
function releaseBump(x: StepInput, gates: ReturnType<typeof releaseGates>): StepAction | null {
  const due = gates.filter((g) => g.gate === 'bump-due');
  if (!due.length) return null;
  const j = x.job;
  let since: string | null = null;
  let first = due[0];
  for (const g of due) {
    const at = x.events[releaseIndex(x.events, g.dependency)]?.ts ?? null;
    if (at && (!since || at > since)) {
      since = at;
      first = g;
    }
  }
  const what = `${repoWord(first.dependency)} ${safe(first.version, SAFE_VERSION, 'version')}`;
  const runs = j.verifyRuns.filter((r) => after(r.at, since));
  if (!runs.length) return run(x, 'PR9', ['verify', j.id], `release of ${what} recorded: bump its consumers and verify`);
  const latest = runs.at(-1)!;
  if (!latest.ok) {
    if (after(human(x, 'approve')?.ts, latest.at)) return null;
    return park(x, 'PR9', 'escalation', `release bump: verify failed after the release of ${what}`);
  }
  return park(x, 'PR9', 'escalation', `release bump: verify passed without bumping ${repoWord(first.consumer)}`);
}

/** PR6–PR8: the last pr open deferred some PRs; recorded PR states and canary events say what happens next. */
function deferredPr(x: StepInput, deferral: JobEvent): StepAction {
  const j = x.job;
  const deferred = readDeferrals(deferral.deferred);
  const state = (k: string | null) => (k === null ? j.pr?.state : memberRepos(j).find((m) => m.repo === k)?.pr?.state);
  const s = deferralStatus(deferred, state, x.events);
  if (s.canary) {
    const dep = s.canary.waitingOn[0];
    const pkg = safe(`${s.canary.name}@${s.canary.version}`, SAFE_ELEMENT, 'its package');
    const cmd = `forge job interim publish ${j.id} ${dep === null ? '--root' : safe(dep, REPO_WORD, '<repo>')} --confirm`;
    return park(x, 'PR6', 'human', `${repoWord(s.canary.repo)} waits on a canary of ${repoWord(dep)} [${pkg}]: a human runs ${cmd}`);
  }
  if (s.openable) return run(x, 'PR7', ['pr', 'open', j.id], 'every deferred PR can open now: its dependencies merged or the canary is published');
  const wait = s.sequential ?? deferred[0];
  const reason = wait ? `${repoWord(wait.repo)} PR opens after ${wait.waitingOn.map(repoWord).join(', ')} merges [interim: sequential]` : 'a deferred PR waits on its dependencies';
  return set(x, 'PR8', { stage: 'pr', state: 'waiting', waitingOn: 'pr-review', reason }, 'a deferred PR opens once its dependencies merge');
}
