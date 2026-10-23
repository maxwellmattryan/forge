// The `release` gate class (#192): a job's release plan the Foreman may approve in place of
// `forge release run`'s publish prompt. Publishing can't be undone, so the class is a human's unless a
// project lists it in foreman.decides and drops `gate:release` from foreman.reserved. Nothing here
// trusts release.json, the request inbox or events.jsonl alone: every check recomputes the plan
// (freshPlan) and re-reads the policy, at approval time and again at run time.
// docs/RELEASES.md "Releasing a project", docs/ARCHITECTURE.md "Foreman".
import { isForemanActor, loadJob, logEvent, readEvents } from '#core/job/store.ts';
import { classReservation, decides, foremanEnabled, inOffice, reservedFor } from '#office/foreman.ts';
import { assertNoSymlinks, freshPlan, readPlanFile, readState, releaseFiles, type ReleasePlan } from './plan.ts';
import { enqueue, listRequests } from '#core/job/requests.ts';
import { ForgeError } from '#core/errors.ts';
import type { Config, ForgeRequest, JobEvent } from '#core/types.ts';

const RELEASE_PLANNED = 'release-planned';
export const RELEASE_APPROVAL = 'release-approval';
/** A full sha256 plan hash; an event carrying anything else is ignored. */
const PLAN_HASH = /^[0-9a-f]{64}$/;

const GATE = 'release' as const;

export type ReleaseOwner = 'human' | 'foreman';

/** The Foreman decides `release`: it is on, the class is in foreman.decides, and no `gate:release` (decides() drops it). */
const foremanDecidesRelease = (config: Config): boolean => foremanEnabled(config) && decides(config).includes(GATE);

const hashOf = (e: JobEvent): string | null => (typeof e.planHash === 'string' && PLAN_HASH.test(e.planHash) ? e.planHash : null);

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
 * Every check on `forge job human <job> approve-release --actor foreman`, before anything is written,
 * in the order docs/ARCHITECTURE.md "Foreman" lists them. Returns the plan hash to record. Throws
 * ForgeError (exit 1).
 */
export function checkReleaseDecision(
  root: string,
  config: Config,
  id: string,
  note: string | null | undefined,
  flags: { link?: unknown; reason?: unknown; repo?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const refuse = (why: string): never => {
    throw new ForgeError(`--actor foreman refused: ${why}`, 1);
  };
  if (!inOffice(env)) refuse('only the office daemon session records foreman decisions');
  if (typeof note !== 'string' || !note.trim()) refuse('a foreman decision needs --note with its reason');
  if (flags.link !== undefined || flags.reason !== undefined || flags.repo !== undefined) refuse('approve-release takes only --note (no --link, --reason or --repo)');
  if (!foremanEnabled(config)) refuse('foreman.enabled is false');
  if (!(Array.isArray(config.foreman?.decides) && config.foreman.decides.includes(GATE))) refuse('release is not in foreman.decides');
  const held = classReservation(config, GATE);
  if (held) refuse(`release is reserved (${held}): left for a human`);
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

export interface ForemanApproval {
  actor: 'foreman';
  at: string;
  note: string | null;
}

/**
 * The Foreman's approval of `plan` (recomputed now, never release.json's word) that `forge release run`
 * may act on without a terminal, or null. It counts only while the policy that allowed it still holds:
 * the Foreman decides `release`, and nothing reserved shows in the job or the approval's note.
 */
export function foremanReleaseApproval(root: string, config: Config, plan: Pick<ReleasePlan, 'selection' | 'hash'>): ForemanApproval | null {
  if (plan.selection.kind !== 'job' || !PLAN_HASH.test(plan.hash) || !foremanDecidesRelease(config)) return null;
  const id = plan.selection.job;
  let job;
  try {
    job = loadJob(root, id);
  } catch {
    return null;
  }
  const e = approvalsFor(readEvents(root, id), plan.hash)
    .filter((x) => isForemanActor(x))
    .at(-1);
  if (!e) return null;
  const note = typeof e.note === 'string' ? e.note : null;
  if (reservedFor(root, config, job, GATE, [note])) return null;
  return { actor: 'foreman', at: e.ts, note };
}

/** `forge release status`'s `approval` for release.json's plan, under the same conditions as a run. */
export function releaseApprovalStatus(root: string, config: Config, file: Pick<ReleasePlan, 'selection' | 'hash'>): { owner: ReleaseOwner; status: 'pending' | 'approved'; actor?: 'foreman'; at?: string } {
  const a = foremanReleaseApproval(root, config, file);
  if (a) return { owner: 'foreman', status: 'approved', actor: 'foreman', at: a.at };
  let owner: ReleaseOwner = 'human';
  if (file.selection.kind === 'job' && foremanDecidesRelease(config)) {
    try {
      owner = reservedFor(root, config, loadJob(root, file.selection.job), GATE) ? 'human' : 'foreman';
    } catch {
      owner = 'human';
    }
  }
  return { owner, status: 'pending' };
}
