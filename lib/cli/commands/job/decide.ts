// `forge job human|handoff|assist`: recording a person's decision at a gate, the refusals of a foreman one, and the read-only assist.
import { gateAssist, recordForemanDecision, recordHandoff } from '#office/foreman/decide.ts';
import { logHumanEvent, setJob } from '#core/job/store.ts';
import { checkIssueRef } from '#core/job/issue-ref.ts';
import { localRepoSlug } from '#integrations/git/repo-slug.ts';
import { decideRepoProposals } from '#engine/project/repo-proposals.ts';
import { daemonScope, inAssistant, inChat, inOffice } from '#core/job/requests.ts';
import { chatGateRefusal } from '#office/chat/authority.ts';
import { createAndLink, linkJob, markNoIssue } from '#engine/trackers/link.ts';
import { loadTracker } from '#engine/trackers/load.ts';
import { currentActor } from '#integrations/github/actor.ts';
import { ForgeError } from '#core/errors.ts';
import type { Config } from '#core/types.ts';
import { list, oneOf, requireJob, str } from '../args.ts';

// `forge stats` and `forge job step` read these from `human` events, so an invented action is refused.
const HUMAN_ACTIONS = ['approve-spec', 'revise-spec', 'approve-split', 'revise-split', 'approve', 'rework', 'answer', 'approve-repos', 'reject-repos', 'approve-release'] as const;
const REPO_ACTIONS: readonly string[] = ['approve-repos', 'reject-repos'];

export async function human(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  const job = requireJob(root, id);
  const jobId = job.id;
  const action = oneOf(rest[1], HUMAN_ACTIONS, 'action');
  const note = str(flags.note, '--note');
  const who = flags.actor === undefined ? 'human' : oneOf(str(flags.actor, '--actor'), ['human', 'foreman'] as const, 'actor');
  // An assistant foreman session records only foreman decisions, and only it may (checkForemanDecision): provenance is
  // the daemon scope, so a job session misled by request text can't pass off a decision as the foreman's.
  if ((inOffice() || inAssistant()) && who !== 'foreman') throw new ForgeError('a foreman session records decisions only with --actor foreman', 1);
  // A chat acts for the owner, but a reserved gate stays the owner's own to decide: refused before anything is written.
  const chatRefusal = inChat() ? chatGateRefusal(root, config, job, action, note) : null;
  if (chatRefusal) throw new ForgeError(chatRefusal, 1);
  if (action === 'approve-release' && who !== 'foreman') throw new ForgeError("approve-release is the foreman's (--actor foreman); a person approves a release by answering forge release run's publish prompt in a terminal", 1);
  // TODO(phase 2): no authority from the CLI at all; an assistant foreman's env stands in while its sessions run.
  if (who === 'foreman') {
    const repos = flags.repo === undefined ? undefined : list(flags.repo);
    return recordForemanDecision(root, config, job, action, note, { link: flags.link, reason: flags.reason, repo: flags.repo, ...(repos ? { repos } : {}) }, process.env);
  }
  // Every check runs before any write, so a refused --link leaves job.json and events untouched.
  const link = flags.link;
  if (link !== undefined && (typeof link !== 'string' || !link.trim())) throw new ForgeError('--link needs <ref>, new or none');
  if (link !== undefined && action !== 'approve-spec' && action !== 'approve') throw new ForgeError('--link is only for approve and approve-spec');
  // Re-validated here, not only in the orchestrator: the value can come from request or dashboard text.
  if (typeof link === 'string' && link !== 'new' && link !== 'none') {
    const checked = checkIssueRef(link, { tracker: config.tracker.kind, slug: localRepoSlug(root, config) });
    if ('error' in checked) throw new ForgeError(checked.error);
  }
  const reason = str(flags.reason, '--reason');
  if (reason !== undefined && link !== 'none') throw new ForgeError('--reason is only for --link none');
  if (flags.repo !== undefined && !REPO_ACTIONS.includes(action)) throw new ForgeError('--repo is only for approve-repos and reject-repos');
  if (REPO_ACTIONS.includes(action)) {
    // Widening the repos a job pushes to: never from a job session or the inbox, which could be misled by request text.
    const s = daemonScope();
    if ('problem' in s) throw new ForgeError(s.problem);
    if (s.daemon) throw new ForgeError(`forge job human ${action} decides which repos a job pushes to, which a daemon session may not do; decide in the dashboard or your own terminal`, 1);
    // The decider names what it saw: never "every pending repo", which could include one proposed since.
    const repos = flags.repo === undefined ? [] : list(flags.repo);
    if (!repos.length) throw new ForgeError(`forge job human ${action} needs --repo A[,B]: the pending repos you decide (see repo-proposals.md)`, 1);
    // A person may name a subset.
    const decided = decideRepoProposals(root, config, jobId, action === 'approve-repos' ? 'approve' : 'reject', { repos, note: note ?? (rest.slice(2).join(' ') || null), actor: currentActor(root) });
    return { ok: true, ...decided };
  }
  // A rejected split re-plans as one job; recorded before the event so step never sees one without the other.
  if (action === 'revise-split') setJob(root, jobId, { fields: { splitMode: 'never' } });
  // The link goes first: if it throws, no approval is recorded and the job keeps waiting.
  let linked: unknown;
  // Resolved after every check, so a refused call never spawns gh to find out who asked.
  const actor = currentActor(root);
  if (link === 'none') linked = markNoIssue(root, jobId, reason ?? null, actor);
  else if (link === 'new') linked = createAndLink(root, config, await loadTracker(root, config), jobId, actor);
  else if (typeof link === 'string') linked = linkJob(root, config, await loadTracker(root, config), jobId, [link], actor);
  logHumanEvent(root, jobId, 'human', { action, note: note ?? (rest.slice(2).join(' ') || null) }, actor);
  return { ok: true, ...(link !== undefined ? { link: linked } : {}) };
}

export function handoff(root: string, _config: Config, rest: string[], flags: Record<string, any>) {
  // TODO(phase 2): removed; recordHandoff takes only the gate runner's authority.
  const job = requireJob(root, rest[0]);
  return { ok: true, foremanHandoff: recordHandoff(root, job, flags.class, flags.reason, process.env) };
}

/**
 * `forge job assist`: read-only, for a person's own terminal. TODO(phase 2): refused in every daemon session.
 * `stale` when the job no longer waits on that gate; `reserved` is re-checked now, not taken from the request.
 */
export function assistCmd(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const s = daemonScope();
  if ('problem' in s) throw new ForgeError(s.problem);
  if (s.daemon && !inAssistant()) throw new ForgeError('forge job assist is for an assistant foreman session (or a human outside the daemon)', 1);
  return gateAssist(root, config, requireJob(root, rest[0]), str(flags.gate, '--gate'));
}
