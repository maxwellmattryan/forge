// `forge job human|apply|assist`: recording a person's decision at a gate, the refusal of a foreman one (only forge
// dash's gate runner records those, in-process), applying one job request by the human-command table, and the
// read-only assist for a person's own terminal.
import { gateAssist, recordForemanDecision } from '#office/foreman/decide.ts';
import { loadJob, logHumanEvent, setJob } from '#core/job/store.ts';
import { checkIssueRef } from '#core/job/issue-ref.ts';
import { localRepoSlug } from '#integrations/git/repo-slug.ts';
import { decideRepoProposals } from '#engine/project/repo-proposals.ts';
import { approvalNotesPath, builderNoteRefusal, writeApprovalNotes } from '#engine/pipeline/moves/approval-notes.ts';
import { appendRequestAnswer, requestPlan, writeRequestFeedback, type RequestStep } from '#engine/pipeline/moves/request-table.ts';
import { budgetCmd } from '#engine/metrics/budget.ts';
import { isRepoHold } from '#engine/metrics/repo-budget.ts';
import { JOB_REQUEST_TYPES, ackRequest, claimRequest, daemonScope, inChat, inOffice, readRequest, releaseClaim, validRequestId } from '#core/job/requests.ts';
import { chatGateRefusal } from '#office/chat/authority.ts';
import { createAndLink, linkJob, markNoIssue } from '#engine/trackers/link.ts';
import { loadTracker } from '#engine/trackers/load.ts';
import { currentActor } from '#integrations/github/actor.ts';
import { ForgeError } from '#core/errors.ts';
import type { Config, ForgeRequest, Job } from '#core/types.ts';
import { list, oneOf, req, requireJob, str } from '../args.ts';
import { set } from './state.ts';

// `forge stats` and `forge job step` read these from `human` events, so an invented action is refused.
const HUMAN_ACTIONS = ['approve-spec', 'revise-spec', 'approve-split', 'revise-split', 'approve', 'rework', 'answer', 'approve-repos', 'reject-repos', 'approve-release'] as const;
const REPO_ACTIONS: readonly string[] = ['approve-repos', 'reject-repos'];

/** What an office run's child (scope `_office`) gets for any `forge job human`: it decides no gate. */
export const OFFICE_HUMAN_REFUSAL = "the office records no gate decisions: forge dash's gate runner decides gates";

export async function human(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  // Before anything is read: the office's children read tracker titles and mandate guidance, so they record no decision at all.
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
  // A person's note reaches the builder (approval-notes.md, which the builder brief lists) only for a job that waited on
  // spec-approval when this call began and from a session that may add a builder hint for it: approve-spec is no way into
  // another job's brief. That is decided here, before the event is logged, and the event carries the answer
  // (`approvalNote: true`): approval-notes.md renders only marked notes, so a refused note never shows up in a later write.
  const noteGiven = action === 'approve-spec' && Boolean(noted?.trim());
  const skip = !noteGiven ? null : job.waitingOn === 'spec-approval' ? builderNoteRefusal(jobId, 'forge job human approve-spec') : `job ${jobId} is not waiting on spec-approval`;
  logHumanEvent(root, jobId, 'human', { action, note: noted, ...(noteGiven && skip === null ? { approvalNote: true } : {}) }, actor);
  // A skipped or failed write never undoes the decision; the result says why no file was written.
  let approvalNotes: { path: string; written: boolean; error?: string } | null = null;
  if (noteGiven) approvalNotes = skip === null ? writeApprovalNotes(root, jobId) : { path: approvalNotesPath(root, jobId), written: false, error: skip };
  return { ok: true, ...(link !== undefined ? { link: linked } : {}), ...(approvalNotes ? { approvalNotes } : {}) };
}

/** What `forge job apply` prints: the request, how it was closed (or left pending), and what was recorded. */
export interface ApplyResult {
  id: string;
  request: string;
  type: ForgeRequest['type'];
  from: string;
  createdAt: string;
  status: 'done' | 'rejected' | 'pending';
  result: string;
  recorded: string[];
}

const PENDING_RESULT = 'a plain resume: left pending for the step loop';

/** forge job budget's still-exceeded keys, read only at a job budget park (a repo hold never lifts on an approve). */
function stillExceeded(root: string, config: Config, job: Job): string[] | null {
  if (job.state !== 'waiting' || job.waitingOn !== 'budget' || isRepoHold(job)) return null;
  return budgetCmd(root, config, job.id, { set: [], ack: false }).stillExceeded;
}

/** One step of an apply, run through the handler its CLI command uses, in-process; returns what it recorded. */
async function applyStep(root: string, config: Config, id: string, rec: ForgeRequest, s: RequestStep): Promise<string> {
  if ('human' in s) {
    await human(root, config, [id, s.human], { ...(s.note !== null ? { note: s.note } : {}), ...(s.link !== undefined ? { link: s.link } : {}), ...(s.reason !== undefined ? { reason: s.reason } : {}) });
    return `human ${s.human}`;
  }
  if ('set' in s) {
    const { stage, state, note, reason } = s.set;
    await set(root, config, [id], { ...(stage ? { stage } : {}), state, ...(note ? { note } : {}), ...(reason ? { reason } : {}) });
    return `set ${stage ? `${stage}/` : ''}${state}`;
  }
  if ('feedback' in s) {
    writeRequestFeedback(root, id, rec);
    return 'feedback.md';
  }
  appendRequestAnswer(root, id, rec);
  return 'questions.md answer';
}

/**
 * `forge job apply`: one job request applied by the human-command table (lib/engine/pipeline/moves/request-table.ts),
 * recorded and acked. The pool's code driver calls it, and so does a session at a terminal: every step runs in-process
 * through `human` and `set`, so no request text ever reaches argv. Exit 0 for done, rejected and pending alike.
 */
export async function apply(root: string, config: Config, rest: string[], flags: Record<string, any>): Promise<ApplyResult> {
  // Every check runs before anything is read or written.
  const session = req(str(flags.session, '--session'), '--session');
  const rid = req(str(flags.request, '--request'), '--request');
  const id = req(rest[0], 'job id');
  if (!validRequestId(rid)) throw new ForgeError(`invalid request id ${JSON.stringify(String(rid).slice(0, 80))}`, 1);
  const scope = daemonScope();
  if ('problem' in scope) throw new ForgeError(scope.problem, 1);
  // A job session applies only its own job's requests: never another job's, the inbox's or a chat's.
  if (scope.daemon && scope.scope !== id) throw new ForgeError(`forge job apply in scope ${scope.scope} applies no request of job ${id}`, 1);
  const jobId = requireJob(root, id).id;
  const found = readRequest(root, rid);
  if (!found) throw new ForgeError(`no request ${rid}`, 'not_found');
  if (found.job !== jobId) throw new ForgeError(`request ${rid} is for job ${String(found.job ?? 'none').slice(0, 200)}`, 1);
  if (!(JOB_REQUEST_TYPES as readonly unknown[]).includes(found.type)) throw new ForgeError(`request ${rid} is a ${String(found.type).slice(0, 40)} request, not a job request`, 1);

  // Exit 3 for another live session's claim, exit 1 for a closed request: both before any write.
  const rec = claimRequest(root, rid, session);
  const job = loadJob(root, jobId);
  const plan = requestPlan(rec, job, { stillExceeded: stillExceeded(root, config, job), now: new Date() });
  const out = (status: ApplyResult['status'], result: string, recorded: string[]): ApplyResult => ({ id: jobId, request: rid, type: rec.type, from: rec.from, createdAt: rec.createdAt, status, result, recorded });
  if ('none' in plan) {
    releaseClaim(root, rid, session);
    return out('pending', PENDING_RESULT, []);
  }
  if ('refuse' in plan) {
    ackRequest(root, rid, { status: 'rejected', result: plan.refuse });
    return out('rejected', plan.refuse, []);
  }
  const recorded: string[] = [];
  for (const s of plan.steps) {
    try {
      recorded.push(await applyStep(root, config, jobId, rec, s));
    } catch (e) {
      // The steps before it stay done, and the result says which.
      const result = `error: ${String((e as Error)?.message ?? e).split('\n')[0].slice(0, 300)}${recorded.length ? ` (already recorded: ${recorded.join(', ')})` : ''}`;
      ackRequest(root, rid, { status: 'rejected', result });
      return out('rejected', result, recorded);
    }
  }
  const result = `recorded ${recorded.join(', ')}`;
  ackRequest(root, rid, { status: 'done', result });
  return out('done', result, recorded);
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
