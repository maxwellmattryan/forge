// `forge job human|assist`: recording a person's decision at a gate, the refusal of a foreman one (only forge dash's
// gate runner records those, in-process), and the read-only assist for a person's own terminal.
import { gateAssist, recordForemanDecision } from '#office/foreman/decide.ts';
import { logHumanEvent, setJob } from '#core/job/store.ts';
import { checkIssueRef } from '#core/job/issue-ref.ts';
import { localRepoSlug } from '#integrations/git/repo-slug.ts';
import { decideRepoProposals } from '#engine/project/repo-proposals.ts';
import { approvalNotesPath, builderNoteRefusal, writeApprovalNotes } from '#engine/pipeline/moves/approval-notes.ts';
import { daemonScope, inChat, inOffice } from '#core/job/requests.ts';
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

/** What the office session gets for any `forge job human`: it decides no gate. */
export const OFFICE_HUMAN_REFUSAL = "the office session records no gate decisions: forge dash's gate runner decides gates";

export async function human(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  // Before anything is read: the office session reads tracker titles and mandate guidance, so it records no decision at all.
  if (inOffice()) throw new ForgeError(OFFICE_HUMAN_REFUSAL, 1);
  const id = rest[0];
  const job = requireJob(root, id);
  const jobId = job.id;
  const action = oneOf(rest[1], HUMAN_ACTIONS, 'action');
  const note = str(flags.note, '--note');
  // --note, else the words after the action: what the human event records.
  const noted = note ?? (rest.slice(2).join(' ') || null);
  const who = flags.actor === undefined ? 'human' : oneOf(str(flags.actor, '--actor'), ['human', 'foreman'] as const, 'actor');
  // A chat acts for the owner, but a reserved gate stays the owner's own to decide: refused before anything is written.
  const chatRefusal = inChat() ? chatGateRefusal(root, config, job, action, noted) : null;
  if (chatRefusal) throw new ForgeError(chatRefusal, 1);
  if (action === 'approve-release' && who !== 'foreman') throw new ForgeError("approve-release is the foreman's (--actor foreman); a person approves a release by answering forge release run's publish prompt in a terminal", 1);
  // No authority reaches the CLI, so the shared checks refuse every foreman decision here, in every scope, before any write:
  // a session misled by request or PR text can't pass off a decision as the foreman's.
  if (who === 'foreman') return recordForemanDecision(root, config, job, action, note, { link: flags.link, reason: flags.reason, repo: flags.repo }, null);
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
    // Widening the repos a job pushes to: never from a daemon session, which could be misled by request text.
    const s = daemonScope();
    if ('problem' in s) throw new ForgeError(s.problem);
    if (s.daemon) throw new ForgeError(`forge job human ${action} decides which repos a job pushes to, which a daemon session may not do; decide in the dashboard or your own terminal`, 1);
    // The decider names what it saw: never "every pending repo", which could include one proposed since.
    const repos = flags.repo === undefined ? [] : list(flags.repo);
    if (!repos.length) throw new ForgeError(`forge job human ${action} needs --repo A[,B]: the pending repos you decide (see repo-proposals.md)`, 1);
    // A person may name a subset.
    const decided = decideRepoProposals(root, config, jobId, action === 'approve-repos' ? 'approve' : 'reject', { repos, note: noted, actor: currentActor(root) });
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
  logHumanEvent(root, jobId, 'human', { action, note: noted }, actor);
  // A person's note reaches the builder: approval-notes.md, which the builder brief lists. Only for a job that waited on
  // spec-approval when this call began, and from a session that may add a builder hint for it: approve-spec is no way into
  // another job's brief. A skipped or failed write never undoes the decision; the result says why no file was written.
  let approvalNotes: { path: string; written: boolean; error?: string } | null = null;
  if (action === 'approve-spec' && noted?.trim()) {
    const skip = job.waitingOn === 'spec-approval' ? builderNoteRefusal(jobId, 'forge job human approve-spec') : `job ${jobId} is not waiting on spec-approval`;
    approvalNotes = skip === null ? writeApprovalNotes(root, jobId) : { path: approvalNotesPath(root, jobId), written: false, error: skip };
  }
  return { ok: true, ...(link !== undefined ? { link: linked } : {}), ...(approvalNotes ? { approvalNotes } : {}) };
}

/**
 * `forge job assist`: what a gate run's forge:assistant would be briefed with, read-only, for a person's own terminal;
 * refused in every daemon session. `stale` when the job no longer waits on that gate; `reserved` is re-checked now.
 */
export function assistCmd(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const s = daemonScope();
  if ('problem' in s) throw new ForgeError(s.problem);
  if (s.daemon) throw new ForgeError("forge job assist is for a person's own terminal: forge dash's gate runner assists each gate in-process", 1);
  return gateAssist(root, config, requireJob(root, rest[0]), str(flags.gate, '--gate'));
}
