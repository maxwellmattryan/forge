// The Foreman's decisions at a job's gate, in-process: the read-only assist (what `forge job assist`
// returns), recording a foreman decision through the policy checks (./policy.ts), a Foreman hand-off,
// and the title-only override. The gate runner (./run.ts) is the one caller that passes the authority;
// the CLI passes none, so the same checks refuse it. docs/architecture/foreman.md.
import path from 'node:path';
import { assistantBrief } from '#engine/pipeline/brief.ts';
import { classReservation, gateClassFor, isGateClass, reservedFor, securityHold } from '#engine/pipeline/moves/foreman-gates.ts';
import { isForemanActor, jobDir, loadJob, logHumanEvent, readEvents, requestBody, setJob } from '#core/job/store.ts';
import { decideRepoProposals, pendingRepoProposals } from '#engine/project/repo-proposals.ts';
import { RELEASE_APPROVAL, checkReleaseDecision, pendingReleaseHash } from '#engine/release/approval.ts';
import { HANDOFF_CLASSES, OFFICE_GATES } from '#core/job/schema.ts';
import { resolveEffort, resolveModel } from '#core/config/load.ts';
import { writeTextAtomic } from '#core/os/fs.ts';
import { FOREMAN_ACTOR } from '#integrations/github/actor.ts';
import { ForgeError } from '#core/errors.ts';
import { jobMandateDecides } from '../mandates/store.ts';
import { bounceHold } from '../mandates/progress.ts';
import { mandateGuidance } from '../mandates/contract.ts';
import { checkForemanDecision, cleanHandoffReason, foremanAuthorityRefusal, foremanHandoffFor, releaseMandateRefusal } from './policy.ts';
import type { Config, ForemanHandoff, GateClass, HandoffClass, Job, JobEvent } from '#core/types.ts';

const REPO_ACTIONS: readonly string[] = ['approve-repos', 'reject-repos'];

/** What gateAssist returns: `forge job assist`'s JSON. */
export interface GateAssist {
  gate: GateClass;
  stale: boolean;
  reserved: string | null;
  model: string;
  effort: string | null;
  subagent: 'forge:assistant';
  brief: string;
  repos?: string[];
}

/**
 * One gate's assist: read-only. `stale` when the job no longer waits on that gate (someone acted meanwhile);
 * `reserved` is re-checked now, never taken from the request. Throws ForgeError (exit 1) for an unknown gate.
 */
export function gateAssist(root: string, config: Config, job: Job, rawGate: unknown): GateAssist {
  const gate = rawGate;
  if (!isGateClass(gate)) throw new ForgeError(`--gate must be one of ${OFFICE_GATES.join(', ')} (got ${JSON.stringify(String(gate ?? '').slice(0, 40))})`, 1);
  const events = readEvents(root, job.id);
  // A release is a plan awaiting approval, not a park: stale once release.json moves on or it is approved.
  const releaseHash = gate === 'release' ? pendingReleaseHash(root, job.id, events) : null;
  const stale = gate === 'release' ? releaseHash === null : gateClassFor(root, job) !== gate;
  // A job in a mandate: a class the mandate doesn't delegate, or a mandate that can't be read, is a
  // human's, and the reserved path hands it off.
  const m = stale ? null : jobMandateDecides(root, config, job);
  // A release under a paused or closed mandate too (releaseMandateRefusal), since publishing can't be undone.
  const halted = m !== null && !('problem' in m) && gate === 'release' && (m.mandate.status === 'paused' || m.mandate.status === 'closed') ? m.mandate.status : null;
  const delegated = m !== null && !('problem' in m) && m.decides.includes(gate) && !halted ? m : null;
  // A closed mandate delegates nothing (decides is empty); a delegated gate the job keeps coming back to is held too.
  const mandateHold =
    m === null
      ? null
      : delegated
        ? bounceHold(job, events, delegated.mandate)
        : 'problem' in m
          ? `mandate ${m.id}: can't be read`
          : halted
            ? `mandate ${m.id}: ${halted}, so release is not delegated`
            : `mandate ${m.id}: ${gate} is not delegated`;
  // A class reserved with gate:<class> is a human's even when a request for it exists.
  const reserved = stale ? null : (classReservation(config, gate) ?? mandateHold ?? reservedFor(root, config, job, gate));
  // One read of the events for both the brief and `repos`, so the decision's repos are exactly the set the assistant judged.
  const pending = gate === 'repo-proposal' && !stale ? pendingRepoProposals(job, events) : [];
  const mandate = delegated ? { id: delegated.id, decides: delegated.decides, guidance: mandateGuidance(delegated.mandate) } : null;
  return {
    gate,
    stale,
    reserved,
    model: resolveModel(config, job, 'assistant'),
    effort: resolveEffort(config, job, 'assistant').level,
    subagent: 'forge:assistant',
    brief: assistantBrief(root, config, job, gate, config.foreman?.reserved, events, pending, releaseHash, stale ? null : securityHold(job), mandate),
    // The brief's `Pending repos` names: a repo decision names exactly these, and `exact` refuses once they stop being the pending set.
    ...(gate === 'repo-proposal' && !stale ? { repos: pending.map((r) => r.repo) } : {}),
  };
}

/** What a recorded foreman decision returns. */
export type ForemanDecision = { ok: true; release?: { plan: string; actor: 'foreman' }; repos?: unknown };

/**
 * Records one foreman decision at `job`'s gate, as `FOREMAN_ACTOR`, after every policy check: approve-release
 * through checkReleaseDecision (one `release-approval` event, the job untouched), every other action through
 * checkForemanDecision, then a repo decision through decideRepoProposals (the whole pending list, `exact`) or a
 * `human` event (revise-split also sets splitMode never). `by` must hold the gate runner's authority; anything
 * else is refused before anything is read or written. Throws ForgeError (exit 1).
 */
export function recordForemanDecision(
  root: string,
  config: Config,
  job: Job,
  action: string,
  note: string | null | undefined,
  opts: { repos?: string[]; link?: unknown; reason?: unknown; repo?: unknown },
  by: unknown,
): ForemanDecision {
  if (action === 'approve-release') {
    // No job waits on a release: checkReleaseDecision re-plans and re-reads the policy, and takes the job's mandate from here.
    const planHash = checkReleaseDecision(root, config, job.id, note, { link: opts.link, reason: opts.reason, repo: opts.repo }, () => releaseMandateRefusal(root, config, job), by);
    logHumanEvent(root, job.id, RELEASE_APPROVAL, { planHash, note }, FOREMAN_ACTOR);
    return { ok: true, release: { plan: planHash.slice(0, 12), actor: 'foreman' } };
  }
  checkForemanDecision(root, config, job, action, note, { link: opts.link, reason: opts.reason }, by);
  if (opts.repo !== undefined && !REPO_ACTIONS.includes(action)) throw new ForgeError('--repo is only for approve-repos and reject-repos');
  if (REPO_ACTIONS.includes(action)) {
    // The foreman decides the whole list its assist returned: never "every pending repo", which could include one proposed since.
    const repos = opts.repos ?? [];
    if (!repos.length) throw new ForgeError(`a foreman ${action} names the pending repos it decides`, 1);
    const decided = decideRepoProposals(root, config, job.id, action === 'approve-repos' ? 'approve' : 'reject', { repos, exact: true, note: note ?? null, actor: FOREMAN_ACTOR });
    return { ok: true, repos: decided };
  }
  // A rejected split re-plans as one job; recorded before the event so step never sees one without the other.
  if (action === 'revise-split') setJob(root, job.id, { fields: { splitMode: 'never' } });
  logHumanEvent(root, job.id, 'human', { action, note: note ?? null }, FOREMAN_ACTOR);
  return { ok: true };
}

/**
 * Records a Foreman hand-off at the gate `job` waits on now (never passed in): `cls` and a cleaned reason, as
 * `FOREMAN_ACTOR`. Only a holder of the gate runner's authority may, so a session misled by request text can't hide
 * a gate behind a fake "left for a human". Every check runs before the one write. Throws ForgeError (exit 1).
 */
export function recordHandoff(root: string, job: Job, cls: HandoffClass, reason: unknown, by: unknown): ForemanHandoff | null {
  const authority = foremanAuthorityRefusal(by);
  if (authority) throw new ForgeError(`Foreman hand-off refused: ${authority}`, 1);
  const gate = gateClassFor(root, job);
  if (!gate) throw new ForgeError(`job ${job.id} is not waiting on a gate the Foreman decides`, 1);
  if (!(HANDOFF_CLASSES as readonly unknown[]).includes(cls)) throw new ForgeError(`a hand-off class must be one of ${HANDOFF_CLASSES.join(', ')}`, 1);
  const clean = cleanHandoffReason(reason);
  if (!clean) throw new ForgeError('a Foreman hand-off needs a reason', 1);
  logHumanEvent(root, job.id, 'foreman-handoff', { gate, class: cls, reason: clean }, FOREMAN_ACTOR);
  return foremanHandoffFor(root, loadJob(root, job.id));
}

/** The feedback.md a title-only request's revise-spec leaves the spec writer. Fixed text: nothing from the assistant reaches it. */
export const TITLE_ONLY_FEEDBACK =
  '- request.md has only a title. Write the spec from the title and the code it names: keep the scope to what the title asks, decide each judgement call in Approach, and put any question only a person can answer in questions.md.\n';

/**
 * Whether an escalate at `job`'s spec approval comes back as revise-spec instead: its request.md has only its
 * title, and no foreman `revise-spec` stands since the latest `human` event by anyone but the foreman (once per
 * person's decision, so it can't loop).
 */
export function titleOnlyRevise(root: string, job: Pick<Job, 'id'>, events: JobEvent[] = readEvents(root, job.id)): boolean {
  if (requestBody(root, job.id) !== '') return false;
  const person = events.findLastIndex((e) => e.type === 'human' && !isForemanActor(e));
  return !events.some((e, i) => i > person && e.type === 'human' && isForemanActor(e) && e.action === 'revise-spec');
}

/** Overwrites the job's feedback.md with TITLE_ONLY_FEEDBACK, reaching it only through real directories (never a planted link). */
export function writeTitleOnlyFeedback(root: string, id: string): void {
  writeTextAtomic(path.join(jobDir(root, id), 'feedback.md'), TITLE_ONLY_FEEDBACK, { root });
}
