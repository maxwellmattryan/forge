// The `release` gate class (#192): a job's release plan the Foreman may approve in place of
// `forge release run`'s publish prompt, and (through ./mandate.ts) an `until: released` mandate's. Publishing
// can't be undone, so the class is a human's unless a project lists it in foreman.decides and drops
// `gate:release` from foreman.reserved. Nothing here trusts release.json, the request inbox or
// events.jsonl alone: every check recomputes the plan (freshPlan) and re-reads the policy, at approval
// time and again at run time. docs/RELEASES.md "Releasing a project", docs/architecture/foreman.md.
import { isForemanActor, loadJob, logEvent, readEvents } from '#core/job/store.ts';
import { classReservation, foremanEnabled, reservedFor } from '../pipeline/moves/foreman-gates.ts';
import { freshPlan, type ReleasePlan } from './plan.ts';
import { assertNoSymlinks, readPlanFile, readState, releaseFiles } from './files.ts';
import { PLAN_HASH, foremanDecidesRelease, hashOf, mandateReleaseApproval, type ForemanApproval, type MandateReleaseNarrow, type ReleaseOwner } from './mandate.ts';
import { FOREMAN_AUTHORITY_REFUSAL, enqueue, holdsForemanAuthority, listRequests } from '#core/job/requests.ts';
import { ForgeError } from '#core/errors.ts';
import type { Config, ForgeRequest, Job, JobEvent } from '#core/types.ts';

export type { ForemanApproval, ReleaseOwner } from './mandate.ts';

/**
 * The job's mandate refusal for `release` (lib/office/foreman/policy.ts releaseMandateRefusal), or null. Passed in
 * because engine code can't import lib/office/.
 */
export type ReleaseNarrow = (job: Job) => string | null;

const RELEASE_PLANNED = 'release-planned';
export const RELEASE_APPROVAL = 'release-approval';

const GATE = 'release' as const;

/** A since plan the Office pass made for an `until: released` mandate: its approval is the mandate's (./mandate.ts). */
const mandateOf = (plan: Pick<ReleasePlan, 'selection'>): string | null => (plan.selection.kind === 'since' && plan.selection.mandate !== undefined ? plan.selection.mandate : null);

/** The hash of the job's latest `release-planned` event, or null. */
function latestPlannedHash(events: JobEvent[]): string | null {
  const e = [...events].reverse().find((x) => x.type === RELEASE_PLANNED);
  return e ? hashOf(e) : null;
}

/** A recorded `release-approval` for `hash`, by anyone (the caller decides whose counts). */
const approvalsFor = (events: JobEvent[], hash: string): JobEvent[] => events.filter((e) => e.type === RELEASE_APPROVAL && hashOf(e) === hash);

const isReleaseGate = (r: ForgeRequest, job: string) => r.type === 'gate' && r.job === job && r.args?.gate === GATE;

/** release.json, or null when it is missing or can't be read as Forge's own. */
function readFilePlan(root: string): ReleasePlan | null {
  try {
    const files = releaseFiles(root);
    assertNoSymlinks(files);
    return readPlanFile(files);
  } catch {
    return null;
  }
}

/**
 * Called by `forge release plan` after it wrote the plan: a `--job` plan logs `release-planned` (once
 * per hash in a row) and, when the Foreman decides `release`, queues one `release` gate request per
 * job and hash in any status, so a gate the Foreman left for a human is never re-armed for that plan.
 */
export function noteReleasePlanned(root: string, config: Config): { owner: ReleaseOwner; request: string | null } {
  const plan = readFilePlan(root);
  if (!plan || plan.selection.kind !== 'job' || !PLAN_HASH.test(plan.hash)) return { owner: 'human', request: null };
  const id = plan.selection.job;
  const job = loadJob(root, id);
  if (latestPlannedHash(readEvents(root, id)) !== plan.hash) logEvent(root, id, RELEASE_PLANNED, { planHash: plan.hash });
  if (!foremanDecidesRelease(config)) return { owner: 'human', request: null };
  const key = plan.hash;
  let req = listRequests(root).find((r) => isReleaseGate(r, id) && r.args?.key === key) ?? null;
  const reserved = reservedFor(root, config, job, GATE);
  if (!req) req = enqueue(root, config, { type: 'gate', job: id, args: { gate: GATE, key, reserved }, from: 'forge' });
  const owner: ReleaseOwner = reserved || req.status === 'rejected' ? 'human' : 'foreman';
  return { owner, request: req.id };
}

/**
 * The hash of the job's pending release plan, or null (the gate is stale): release.json selects this
 * job, the job's latest `release-planned` is that hash, and nobody has approved it yet.
 */
export function pendingReleaseHash(root: string, id: string, events: JobEvent[] = readEvents(root, id)): string | null {
  const plan = readFilePlan(root);
  if (!plan || plan.selection.kind !== 'job' || plan.selection.job !== id || !PLAN_HASH.test(plan.hash)) return null;
  if (latestPlannedHash(events) !== plan.hash) return null;
  return approvalsFor(events, plan.hash).length ? null : plan.hash;
}

/**
 * Every check on a foreman release approval, before anything is written, in the order
 * docs/architecture/foreman.md lists them, the first being that `by` holds the gate runner's authority.
 * Returns the plan hash to record. Throws ForgeError (exit 1). `narrow` is the job's mandate check, passed
 * in because engine code can't import lib/office/: the refusal it returns for `release` ends the
 * decision, after the policy checks.
 */
export function checkReleaseDecision(
  root: string,
  config: Config,
  id: string,
  note: string | null | undefined,
  flags: { link?: unknown; reason?: unknown; repo?: unknown },
  narrow: (gate: typeof GATE) => string | null,
  by: unknown = null,
): string {
  const refuse = (why: string): never => {
    throw new ForgeError(`--actor foreman refused: ${why}`, 1);
  };
  if (!holdsForemanAuthority(by)) refuse(FOREMAN_AUTHORITY_REFUSAL);
  if (typeof note !== 'string' || !note.trim()) refuse('a foreman decision needs --note with its reason');
  if (flags.link !== undefined || flags.reason !== undefined || flags.repo !== undefined) refuse('approve-release takes only --note (no --link, --reason or --repo)');
  if (!foremanEnabled(config)) refuse('foreman.enabled is false');
  if (!(Array.isArray(config.foreman?.decides) && config.foreman.decides.includes(GATE))) refuse('release is not in foreman.decides');
  const held = classReservation(config, GATE);
  if (held) refuse(`release is reserved (${held}): left for a human`);
  const narrowed = narrow(GATE);
  if (narrowed) refuse(narrowed);
  const files = releaseFiles(root);
  let file: ReleasePlan | null = null;
  let plan: ReleasePlan | null = null;
  try {
    assertNoSymlinks(files);
    file = readPlanFile(files);
    if (file && file.selection.kind === 'job' && file.selection.job === id) plan = freshPlan(root, config, file, readState(files));
  } catch (e) {
    refuse(file ? `the release plan is stale or edited: ${(e as Error).message}` : `no readable release plan: ${(e as Error).message}`);
  }
  if (!file) refuse('no release plan; a human runs forge release plan --job first');
  if (file!.selection.kind !== 'job' || file!.selection.job !== id) refuse(`the release plan is not ${id}'s`);
  const hash = plan!.hash;
  if (!PLAN_HASH.test(hash)) refuse('the release plan has no hash');
  const events = readEvents(root, id);
  if (latestPlannedHash(events) !== hash) refuse(`${id}'s latest planned release is not plan ${hash.slice(0, 12)}`);
  if (!listRequests(root).some((r) => isReleaseGate(r, id) && r.args?.key === hash && (r.status === 'pending' || r.status === 'in-progress')))
    refuse(`no queued release gate request for plan ${hash.slice(0, 12)}`);
  if (approvalsFor(events, hash).length) refuse(`plan ${hash.slice(0, 12)} is already approved`);
  const reserved = reservedFor(root, config, loadJob(root, id), GATE, [note]);
  if (reserved) refuse(`reserved (${reserved}): left for a human`);
  return hash;
}

/**
 * The Foreman's approval of `plan` (recomputed now, never release.json's word) that `forge release run`
 * may act on without a terminal, or null. It counts only while the policy and the job's mandate that
 * allowed it still hold: the Foreman decides `release`, `narrow` finds the job's mandate still delegating
 * it (not narrowed, paused, closed, deleted or unreadable), and nothing reserved shows in the job or the approval's note.
 * A mandate's since plan defers to mandateReleaseApproval under `mandateNarrow`; without it, nothing counts (fail closed).
 */
export function foremanReleaseApproval(
  root: string,
  config: Config,
  plan: Pick<ReleasePlan, 'selection' | 'hash'>,
  narrow: ReleaseNarrow,
  mandateNarrow?: MandateReleaseNarrow,
): ForemanApproval | null {
  if (mandateOf(plan) !== null) return mandateNarrow ? mandateReleaseApproval(root, config, plan, mandateNarrow) : null;
  if (plan.selection.kind !== 'job' || !PLAN_HASH.test(plan.hash) || !foremanDecidesRelease(config)) return null;
  const id = plan.selection.job;
  let job;
  try {
    job = loadJob(root, id);
  } catch {
    return null;
  }
  if (narrow(job) !== null) return null;
  const e = approvalsFor(readEvents(root, id), plan.hash)
    .filter((x) => isForemanActor(x))
    .at(-1);
  if (!e) return null;
  const note = typeof e.note === 'string' ? e.note : null;
  if (reservedFor(root, config, job, GATE, [note])) return null;
  return { actor: 'foreman', at: e.ts, note };
}

/** `forge release status`'s `approval` for release.json's plan, under the same conditions as a run. */
export function releaseApprovalStatus(
  root: string,
  config: Config,
  file: Pick<ReleasePlan, 'selection' | 'hash'>,
  narrow: ReleaseNarrow,
  mandateNarrow?: MandateReleaseNarrow,
): { owner: ReleaseOwner; status: 'pending' | 'approved'; actor?: 'foreman'; at?: string } {
  const a = foremanReleaseApproval(root, config, file, narrow, mandateNarrow);
  if (a) return { owner: 'foreman', status: 'approved', actor: 'foreman', at: a.at };
  let owner: ReleaseOwner = 'human';
  const mandate = mandateOf(file);
  if (mandate !== null) owner = mandateNarrow && foremanDecidesRelease(config) && mandateNarrow(mandate) === null ? 'foreman' : 'human';
  else if (file.selection.kind === 'job' && foremanDecidesRelease(config)) {
    try {
      const job = loadJob(root, file.selection.job);
      owner = reservedFor(root, config, job, GATE) || narrow(job) !== null ? 'human' : 'foreman';
    } catch {
      owner = 'human';
    }
  }
  return { owner, status: 'pending' };
}
