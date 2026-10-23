// `forge job human|handoff|assist`: recording a human's or the foreman's decision at a gate, a Foreman hand-off, and the office's assistant spawn.
import { assistantBrief } from '#engine/pipeline/brief.ts';
import { checkForemanDecision, classReservation, cleanHandoffReason, foremanHandoffFor, gateClassFor, inOffice, isGateClass, reservedFor, securityHold } from '#office/foreman.ts';
import { loadJob, logHumanEvent, readEvents, setJob } from '#core/job/store.ts';
import { checkIssueRef } from '#core/job/issue-ref.ts';
import { localRepoSlug } from '#integrations/git/repo-slug.ts';
import { decideRepoProposals, pendingRepoProposals } from '#engine/project/repo-proposals.ts';
import { RELEASE_APPROVAL, checkReleaseDecision, pendingReleaseHash } from '#engine/release/approval.ts';
import { HANDOFF_CLASSES, OFFICE_GATES } from '#core/job/schema.ts';
import { daemonScope } from '#core/job/requests.ts';
import { createAndLink, linkJob, markNoIssue } from '#engine/trackers/link.ts';
import { loadTracker } from '#engine/trackers/load.ts';
import { modelFor, resolveEffort } from '#core/config/load.ts';
import { FOREMAN_ACTOR, currentActor } from '#integrations/github/actor.ts';
import { ForgeError } from '#core/errors.ts';
import type { Config, Job } from '#core/types.ts';
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
  // The office session records only foreman decisions, and only it may: provenance is the
  // daemon scope, so a job session misled by request text can't pass off a decision as the foreman's.
  if (inOffice() && who !== 'foreman') throw new ForgeError('the office session records decisions only with --actor foreman', 1);
  // No job waits on a release, so it skips checkForemanDecision; checkReleaseDecision re-plans and
  // re-reads the policy before the one event it writes. The job's state never changes.
  if (action === 'approve-release') {
    if (who !== 'foreman') throw new ForgeError("approve-release is the foreman's (--actor foreman); a person approves a release by answering forge release run's publish prompt in a terminal", 1);
    const planHash = checkReleaseDecision(root, config, jobId, note, { link: flags.link, reason: flags.reason, repo: flags.repo });
    logHumanEvent(root, jobId, RELEASE_APPROVAL, { planHash, note }, FOREMAN_ACTOR);
    return { ok: true, release: { plan: planHash.slice(0, 12), actor: 'foreman' } };
  }
  if (who === 'foreman') checkForemanDecision(root, config, job, action, note, { link: flags.link, reason: flags.reason });
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
    if (s.daemon && !inOffice()) throw new ForgeError(`forge job human ${action} decides which repos a job pushes to, which a daemon session may not do; decide in the dashboard or your own terminal`, 1);
    const actor = who === 'foreman' ? FOREMAN_ACTOR : currentActor(root);
    // The decider names what it saw: never "every pending repo", which could include one proposed since.
    const repos = flags.repo === undefined ? [] : list(flags.repo);
    if (!repos.length) throw new ForgeError(`forge job human ${action} needs --repo A[,B]: the pending repos you decide (see repo-proposals.md)`, 1);
    // The foreman decides the whole list its assist call returned; a person may name a subset.
    const decided = decideRepoProposals(root, config, jobId, action === 'approve-repos' ? 'approve' : 'reject', { repos, exact: who === 'foreman', note: note ?? (rest.slice(2).join(' ') || null), actor });
    return { ok: true, ...decided };
  }
  // A rejected split re-plans as one job; recorded before the event so step never sees one without the other.
  if (action === 'revise-split') setJob(root, jobId, { fields: { splitMode: 'never' } });
  // The link goes first: if it throws, no approval is recorded and the job keeps waiting.
  let linked: unknown;
  // Resolved after every check, so a refused call never spawns gh to find out who asked.
  const actor = who === 'foreman' ? FOREMAN_ACTOR : currentActor(root);
  if (link === 'none') linked = markNoIssue(root, jobId, reason ?? null, actor);
  else if (link === 'new') linked = createAndLink(root, config, await loadTracker(root, config), jobId, actor);
  else if (typeof link === 'string') linked = linkJob(root, config, await loadTracker(root, config), jobId, [link], actor);
  logHumanEvent(root, jobId, 'human', { action, note: note ?? (rest.slice(2).join(' ') || null) }, actor);
  return { ok: true, ...(link !== undefined ? { link: linked } : {}) };
}

export function handoff(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  // Office-only, like a foreman decision: a job session misled by request text can't hide a gate
  // behind a fake "left for a human". Every check runs before the one write.
  if (!inOffice()) throw new ForgeError('only the office daemon session records a Foreman hand-off', 1);
  const job = requireJob(root, id);
  // The gate is the one the job waits at now, never passed in.
  const gate = gateClassFor(root, job);
  if (!gate) throw new ForgeError(`job ${job.id} is not waiting on a gate the Foreman decides`, 1);
  const cls = flags.class;
  if (!(HANDOFF_CLASSES as readonly unknown[]).includes(cls)) throw new ForgeError(`--class must be one of ${HANDOFF_CLASSES.join(', ')}`, 1);
  const reason = cleanHandoffReason(flags.reason);
  if (!reason) throw new ForgeError('forge job handoff needs --reason "<why it is left for a human>"', 1);
  logHumanEvent(root, job.id, 'foreman-handoff', { gate, class: cls, reason }, FOREMAN_ACTOR);
  return { ok: true, foremanHandoff: foremanHandoffFor(root, loadJob(root, job.id)) };
}

export function assistCmd(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  return assist(root, config, requireJob(root, id), flags.gate);
}

/**
 * `forge job assist`: what the office session spawns for one gate. Read-only. `stale` when the job no longer
 * waits on that gate (someone acted meanwhile); `reserved` is re-checked now, not taken from the request.
 */
function assist(root: string, config: Config, job: Job, rawGate: unknown) {
  const s = daemonScope();
  if ('problem' in s) throw new ForgeError(s.problem);
  if (s.daemon && !inOffice()) throw new ForgeError('forge job assist is for the office session (or a human outside the daemon)', 1);
  const gate = str(rawGate, '--gate');
  if (!isGateClass(gate)) throw new ForgeError(`--gate must be one of ${OFFICE_GATES.join(', ')} (got ${JSON.stringify(String(gate ?? '').slice(0, 40))})`, 1);
  const events = readEvents(root, job.id);
  // A release is a plan awaiting approval, not a park: stale once release.json moves on or it is approved.
  const releaseHash = gate === 'release' ? pendingReleaseHash(root, job.id, events) : null;
  const stale = gate === 'release' ? releaseHash === null : gateClassFor(root, job) !== gate;
  // A class reserved with gate:<class> is a human's even when a request for it exists.
  const reserved = stale ? null : (classReservation(config, gate) ?? reservedFor(root, config, job, gate));
  // One read of the events for both the brief and `repos`, so the foreman's --repo is exactly the set the assistant judged.
  const pending = gate === 'repo-proposal' && !stale ? pendingRepoProposals(job, events) : [];
  return {
    gate,
    stale,
    reserved,
    model: modelFor(config, 'assistant'),
    effort: resolveEffort(config, job, 'assistant').level,
    subagent: 'forge:assistant',
    brief: assistantBrief(root, config, job, gate, config.foreman?.reserved, events, pending, releaseHash, stale ? null : securityHold(job)),
    // The brief's `Pending repos` names: the foreman passes exactly these as --repo, and `exact` refuses once they stop being the pending set.
    ...(gate === 'repo-proposal' && !stale ? { repos: pending.map((r) => r.repo) } : {}),
  };
}
