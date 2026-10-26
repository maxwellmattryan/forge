// An `until: released` mandate's release (docs/CONFIG.md "Mandates", docs/RELEASES.md "Releasing a
// project"): the since-plan the Office pass makes once the mandate's jobs have merged, its state, and the
// foreman's approval of it in place of `forge release run`'s publish prompt. The approval's subject is the
// mandate, not a job, so its records live in the repo audit log, outside every session's write roots:
// `mandate-release-planned`, `mandate-release-approved` and `mandate-release-finished`, each naming the
// mandate and the full plan hash. Nothing here runs a step or writes state.json. Engine code can't import
// lib/office/, so the mandate's own policy (lib/office/foreman.ts mandateReleaseRefusal) comes in as `narrow`;
// approval.ts and run.ts import this file, never the other way round.
import { listArchived } from '#core/job/archive.ts';
import { enqueue, inAssistant, listRequests } from '#core/job/requests.ts';
import { isForemanActor, listJobs, logRepoEvent, parseEventLines, readEvents, repoAuditFile } from '#core/job/store.ts';
import { readRegularText } from '#core/os/fs.ts';
import { assertSafeRef, oneLineTitle } from '#core/text.ts';
import { ForgeError } from '#core/errors.ts';
import { MANDATE_ID_SOURCE } from '#api/constants.ts';
import { FOREMAN_ACTOR, currentActor } from '#integrations/github/actor.ts';
import { classReservation, decides, foremanEnabled, reservedMatch } from '../pipeline/moves/foreman-gates.ts';
import { memberRepos } from '../project/job-repos.ts';
import { type GitReader, type PlanOptions, type ReleasePlan, type ReleaseState, cloneGit, freshPlan, keptHeads, planHash, planRelease } from './plan.ts';
import { assertNoSymlinks, doneCount, finished, planSteps, readPlanFile, readState, releaseFiles, writeReleasePlan } from './files.ts';
import type { Config, EventActor, ForgeRequest, Job, JobEvent } from '#core/types.ts';

/** Why mandate `id` keeps its release with a human, or null when it delegates it (lib/office/foreman.ts mandateReleaseRefusal). */
export type MandateReleaseNarrow = (mandate: string) => string | null;

export type ReleaseOwner = 'human' | 'foreman';

export interface ForemanApproval {
  actor: 'foreman';
  at: string;
  note: string | null;
}

export type MandateReleaseStatus = 'unplanned' | 'done' | 'replaced' | 'failed' | 'stale' | 'started' | 'approved' | 'pending';

/** Where an `until: released` mandate's release stands: the pass, `forge mandate show` and the assist call read it. */
export interface MandateReleaseView {
  status: MandateReleaseStatus;
  /** The latest planned hash's first 12 characters, or null before any plan. */
  plan: string | null;
  tag: string | null;
  done: number;
  total: number;
  next: string | null;
  /** Null while unplanned or done. */
  owner: ReleaseOwner | null;
  /** One line, at most 200 characters. */
  detail: string;
}

const PLANNED = 'mandate-release-planned';
const APPROVED = 'mandate-release-approved';
const FINISHED = 'mandate-release-finished';
const GATE = 'release' as const;
/** A full sha256 plan hash; an event carrying anything else is ignored. */
export const PLAN_HASH = /^[0-9a-f]{64}$/;
const MANDATE_ID = new RegExp(MANDATE_ID_SOURCE);
/** The audit log is append-only and never rotated here: past this it is read no further, rather than whole. */
const AUDIT_MAX_BYTES = 32 * 1024 * 1024;
const DETAIL_MAX = 200;

const isMandateId = (v: unknown): v is string => typeof v === 'string' && MANDATE_ID.test(v) && v !== 'none';
const h12 = (hash: string): string => hash.slice(0, 12);
const line = (s: string): string => oneLineTitle(s).slice(0, DETAIL_MAX);

/** The Foreman decides `release`: it is on, the class is in foreman.decides, and no `gate:release` (decides() drops it). */
export const foremanDecidesRelease = (config: Config): boolean => foremanEnabled(config) && decides(config).includes(GATE);

const hashOf = (e: JobEvent): string | null => (typeof e.planHash === 'string' && PLAN_HASH.test(e.planHash) ? e.planHash : null);

/** A job-less `release` gate request for mandate `id`, in any status. */
export const isMandateReleaseGate = (r: ForgeRequest, id: string): boolean => r.type === 'gate' && !r.job && r.args?.gate === GATE && r.args?.mandate === id;

/** The mandate's well-formed release events in the repo audit log, oldest first. */
function releaseEvents(root: string, id: string): JobEvent[] {
  if (!isMandateId(id)) return [];
  const text = readRegularText(repoAuditFile(root), AUDIT_MAX_BYTES);
  if (text === null) return [];
  return parseEventLines(text).filter((e) => (e.type === PLANNED || e.type === APPROVED || e.type === FINISHED) && e.mandate === id && hashOf(e) !== null);
}

/** The mandate's latest planned release: its full hash, the tag it was planned since and when, or null. */
export function latestMandatePlan(root: string, id: string, events: JobEvent[] = releaseEvents(root, id)): { hash: string; tag: string | null; at: string } | null {
  const e = events.findLast((x) => x.type === PLANNED);
  if (!e) return null;
  let tag: string | null = null;
  try {
    tag = assertSafeRef(e.tag, 'tag');
  } catch {
    tag = null;
  }
  return { hash: hashOf(e)!, tag, at: e.ts };
}

/** When a done job merged (ms): its PRs' latest `mergedAt`, else its latest transition to done; NaN when neither shows. */
function mergedAtOf(job: Job, events: JobEvent[]): number {
  const times = [job.pr, ...memberRepos(job).map((m) => m.pr)].map((pr) => Date.parse(String(pr?.mergedAt ?? ''))).filter(Number.isFinite);
  if (times.length) return Math.max(...times);
  const t = events.findLast((e) => e.type === 'transition' && (e.to as { state?: unknown } | undefined)?.state === 'done');
  return t ? Date.parse(t.ts) : NaN;
}

/** The first of mandate `id`'s done jobs, live or archived, that merged after `at`, or null. */
function mergedAfter(root: string, id: string, at: string): string | null {
  const since = Date.parse(at);
  if (!Number.isFinite(since)) return null;
  for (const job of listJobs(root)) if (job.mandate === id && job.state === 'done' && mergedAtOf(job, readEvents(root, job.id)) > since) return job.id;
  for (const a of listArchived(root)) if (a.job.mandate === id && a.job.state === 'done' && mergedAtOf(a.job, a.events) > since) return a.id;
  return null;
}

/** release.json and its state.json, or null when either can't be read as Forge's own (or a link sits there). */
function readFiles(root: string): { plan: ReleasePlan | null; state: ReleaseState | null } | null {
  try {
    const files = releaseFiles(root);
    assertNoSymlinks(files);
    const plan = readPlanFile(files);
    return { plan, state: plan ? readState(files) : null };
  } catch {
    return null;
  }
}

/** The root repo's latest tag reachable from HEAD, or null when it has none or the tag isn't a safe ref (it reaches git argv). */
export function lastReleaseTag(root: string, git: GitReader = cloneGit): string | null {
  const r = git(root, ['describe', '--tags', '--abbrev=0', 'HEAD']);
  if (!r.ok) return null;
  try {
    return assertSafeRef(r.stdout.trim(), 'tag');
  } catch {
    return null;
  }
}

/** Who owns the mandate's pending release decision: the foreman while it decides `release`, the mandate delegates it, and the request for `hash` was not rejected. */
function ownerOf(root: string, config: Config, id: string, hash: string, narrow: MandateReleaseNarrow, requests: ForgeRequest[] = listRequests(root)): ReleaseOwner {
  if (!foremanDecidesRelease(config) || narrow(id) !== null) return 'human';
  const latest = requests.filter((r) => isMandateReleaseGate(r, id) && r.args?.key === hash).at(-1);
  return latest?.status === 'rejected' ? 'human' : 'foreman';
}

/**
 * Whether release.json holds a plan the Office pass leaves alone: one that isn't mandate `id`'s own since
 * plan and whose run hasn't started, or one it can't read. A started run of it is writeReleasePlan's
 * refusal, a link is assertNoSymlinks', and a finished one may be replaced.
 */
function holdsOtherPlan(root: string, id: string): boolean {
  const files = releaseFiles(root);
  let plan: ReleasePlan | null;
  try {
    assertNoSymlinks(files);
  } catch {
    return false;
  }
  try {
    plan = readPlanFile(files);
  } catch {
    return true;
  }
  if (!plan || (plan.selection.kind === 'since' && plan.selection.mandate === id)) return false;
  let state: ReleaseState | null;
  try {
    state = readState(files);
  } catch {
    return false;
  }
  return !(state && state.planHash === plan.hash && Object.keys(state.steps).length > 0);
}

/**
 * Plans mandate `id`'s release since the root's latest tag, through writeReleasePlan (so an unfinished run
 * of another plan is refused), logs `mandate-release-planned`, and queues one job-less `release` gate
 * request when the Foreman decides the class and the mandate delegates it: at most one per mandate and
 * hash, in any status, so a gate left for a human is never re-armed for that plan. Throws a ForgeError
 * for no tag, nothing to release, and every planner refusal, and, for the Office pass (`byPass`), when
 * release.json holds another plan that hasn't started; writes nothing then.
 */
export function planMandateRelease(
  root: string,
  config: Config,
  id: string,
  opts: PlanOptions & { narrow: MandateReleaseNarrow; actor: EventActor; force?: boolean; byPass?: boolean },
) {
  if (!isMandateId(id)) throw new ForgeError(`${JSON.stringify(String(id).slice(0, 60))} is not a mandate id`);
  const tag = lastReleaseTag(root, opts.git ?? cloneGit);
  if (tag === null) throw new ForgeError("the root repo has no tag to release since; tag its last release, or edit the mandate's until");
  const selection = { kind: 'since' as const, tag, mandate: id };
  const plan = planRelease(root, config, selection, { git: opts.git, clone: opts.clone });
  if (!planSteps(plan).length) throw new ForgeError(line(`nothing to release since ${tag} (${plan.skipped.map((s) => `${s.label}: ${s.reason}`).join('; ')})`));
  if (opts.byPass && holdsOtherPlan(root, id)) throw new ForgeError(`blocked by another plan, plan it with forge release plan --mandate ${id}`);
  const written = writeReleasePlan(root, config, selection, { git: opts.git, clone: opts.clone, force: opts.force });
  const file = readFiles(root)?.plan;
  if (!file || file.selection.kind !== 'since' || file.selection.mandate !== id || !PLAN_HASH.test(file.hash)) throw new ForgeError('release.json changed while it was written; plan again');
  const hash = file.hash;
  logRepoEvent(root, PLANNED, { mandate: id, planHash: hash, tag, actor: opts.actor });
  let request: ForgeRequest | null = null;
  if (foremanDecidesRelease(config) && opts.narrow(id) === null) {
    request = listRequests(root).find((r) => isMandateReleaseGate(r, id) && r.args?.key === hash) ?? null;
    request ??= enqueue(root, config, { type: 'gate', job: null, args: { gate: GATE, mandate: id, key: hash, reserved: null }, from: 'forge' });
  }
  const owner: ReleaseOwner = request && request.status !== 'rejected' ? 'foreman' : 'human';
  return { ...written, tag, approval: { owner, request: request?.id ?? null } };
}

/**
 * The foreman's approval of `plan` (a since plan naming a mandate, recomputed by the caller) that
 * `forge release run` may act on without a terminal, or null. It counts only while the Foreman decides
 * `release`, `narrow` finds the mandate still delegating it (not narrowed, paused, closed, deleted,
 * unreadable, capped or reserved), and no reserved pattern shows in the approval's note.
 */
export function mandateReleaseApproval(root: string, config: Config, plan: Pick<ReleasePlan, 'selection' | 'hash'>, narrow: MandateReleaseNarrow): ForemanApproval | null {
  const sel = plan.selection;
  if (sel.kind !== 'since' || !isMandateId(sel.mandate) || !PLAN_HASH.test(plan.hash) || !foremanDecidesRelease(config)) return null;
  if (narrow(sel.mandate) !== null) return null;
  const e = releaseEvents(root, sel.mandate)
    .filter((x) => x.type === APPROVED && hashOf(x) === plan.hash && isForemanActor(x))
    .at(-1);
  if (!e) return null;
  const note = typeof e.note === 'string' ? e.note : null;
  if (reservedMatch(config, [note])) return null;
  return { actor: 'foreman', at: e.ts, note };
}

/** The view of a mandate whose release has been planned, from the files and the planner now. */
function plannedState(root: string, config: Config, id: string, latest: { hash: string; tag: string | null }, narrow: MandateReleaseNarrow, opts: PlanOptions): MandateReleaseView {
  const { hash, tag } = latest;
  const base = { plan: h12(hash), tag, done: 0, total: 0, next: null };
  const owner = () => ownerOf(root, config, id, hash, narrow);
  const files = readFiles(root);
  const file = files?.plan;
  const own = files?.state && files.state.planHash === hash ? files.state : null;
  if (file && file.hash === hash && own?.finishedAt && finished(file, own)) return { ...base, status: 'done', owner: null, detail: `released plan ${h12(hash)}` };
  if (!file || file.hash !== hash || file.selection.kind !== 'since' || file.selection.mandate !== id)
    return { ...base, status: 'replaced', owner: owner(), detail: line(`release.json no longer holds plan ${h12(hash)}; run forge release plan --mandate ${id}`) };
  const steps = planSteps(file);
  const done = doneCount(file, own);
  const next = steps.find((s) => own?.steps[s.id]?.status !== 'done')?.id ?? null;
  const counts = { done, total: steps.length, next };
  const failed = steps.find((s) => own?.steps[s.id]?.status === 'failed');
  if (failed) return { ...base, ...counts, status: 'failed', owner: owner(), detail: line(`step ${failed.id} failed: ${own!.steps[failed.id].detail ?? 'failed'}`) };
  let stale: string | null = null;
  try {
    const now = planRelease(root, config, file.selection, { ...opts, heads: keptHeads(file, own) });
    if (now.hash !== hash || planHash(file) !== hash) stale = `plan ${h12(hash)}, now ${h12(now.hash)}`;
  } catch (e) {
    stale = (e as Error).message;
  }
  if (stale !== null) return { ...base, ...counts, status: 'stale', owner: owner(), detail: line(`the plan went stale (${stale})`) };
  if (done > 0) return { ...base, ...counts, status: 'started', owner: owner(), detail: line(`${done}/${steps.length} steps done, next ${next}`) };
  if (mandateReleaseApproval(root, config, file, narrow))
    return { ...base, ...counts, status: 'approved', owner: owner(), detail: `plan ${h12(hash)} approved by the foreman; a human or CI runs forge release run` };
  const who = owner();
  return { ...base, ...counts, status: 'pending', owner: who, detail: `plan ${h12(hash)} waits for release approval (${who})` };
}

/**
 * Where mandate `id`'s release stands, the first that applies: unplanned (no planned event), done (a
 * finished event for the latest planned hash, or its run finished in state.json, and no mandate job merged
 * after that plan's planned event; otherwise stale, so the pass plans again), replaced (release.json no
 * longer holds that plan), failed (a step failed), stale (the plan recomputes to another hash, a planned
 * repo's HEAD moved included, or the planner refuses), started, approved (a foreman approval counts), else pending.
 */
export function mandateReleaseState(root: string, config: Config, id: string, narrow: MandateReleaseNarrow, opts: PlanOptions = {}): MandateReleaseView {
  const events = releaseEvents(root, id);
  const latest = latestMandatePlan(root, id, events);
  if (!latest) return { status: 'unplanned', plan: null, tag: null, done: 0, total: 0, next: null, owner: null, detail: "the Office pass plans it once the mandate's jobs have merged" };
  const view: MandateReleaseView = events.some((e) => e.type === FINISHED && hashOf(e) === latest.hash)
    ? { status: 'done', plan: h12(latest.hash), tag: latest.tag, done: 0, total: 0, next: null, owner: null, detail: `released plan ${h12(latest.hash)}` }
    : plannedState(root, config, id, latest, narrow, opts);
  if (view.status !== 'done') return view;
  const later = mergedAfter(root, id, latest.at);
  if (later === null) return view;
  return { ...view, status: 'stale', owner: ownerOf(root, config, id, latest.hash, narrow), detail: line(`the plan went stale (job ${later} merged after plan ${h12(latest.hash)} was planned)`) };
}

/** Whether a run of mandate `id`'s latest plan has started and not finished (state.json records a step of it): then the pass never re-plans it. */
export function mandateReleaseStarted(root: string, id: string): boolean {
  const latest = latestMandatePlan(root, id);
  const state = readFiles(root)?.state;
  return !!latest && !!state && state.planHash === latest.hash && !state.finishedAt && Object.keys(state.steps ?? {}).length > 0;
}

/**
 * Every check on `forge mandate release approve <id> --actor foreman`, in order, before the one write
 * (`mandate-release-approved` in the repo audit log). Returns the plan hash it recorded. Throws ForgeError
 * (exit 1) with `--actor foreman refused: …`.
 */
export function approveMandateRelease(root: string, config: Config, id: string, note: string | null | undefined, narrow: MandateReleaseNarrow, env: NodeJS.ProcessEnv = process.env): string {
  const refuse = (why: string): never => {
    throw new ForgeError(`--actor foreman refused: ${why}`, 1);
  };
  if (!inAssistant(env)) refuse('only an assistant foreman session records foreman decisions');
  if (typeof note !== 'string' || !note.trim()) refuse('a foreman decision needs --note with its reason');
  if (!foremanEnabled(config)) refuse('foreman.enabled is false');
  if (!(Array.isArray(config.foreman?.decides) && config.foreman.decides.includes(GATE))) refuse('release is not in foreman.decides');
  const held = classReservation(config, GATE);
  if (held) refuse(`release is reserved (${held}): left for a human`);
  const narrowed = narrow(id);
  if (narrowed) refuse(narrowed);
  const files = releaseFiles(root);
  let file: ReleasePlan | null = null;
  try {
    assertNoSymlinks(files);
    file = readPlanFile(files);
  } catch (e) {
    refuse(`no readable release plan: ${(e as Error).message}`);
  }
  if (!file) refuse(`no release plan; the Office pass plans mandate ${id}'s release`);
  if (file!.selection.kind !== 'since' || file!.selection.mandate !== id) refuse(`the release plan is not mandate ${id}'s`);
  let hash = '';
  try {
    hash = freshPlan(root, config, file!, readState(files)).hash;
  } catch (e) {
    refuse(`the release plan is stale or edited: ${(e as Error).message}`);
  }
  if (!PLAN_HASH.test(hash)) refuse('the release plan has no hash');
  const events = releaseEvents(root, id);
  if (latestMandatePlan(root, id, events)?.hash !== hash) refuse(`mandate ${id}'s latest planned release is not plan ${h12(hash)}`);
  if (!listRequests(root).some((r) => isMandateReleaseGate(r, id) && r.args?.key === hash && (r.status === 'pending' || r.status === 'in-progress')))
    refuse(`no queued release gate request for plan ${h12(hash)}`);
  if (events.some((e) => e.type === APPROVED && hashOf(e) === hash)) refuse(`plan ${h12(hash)} is already approved`);
  const reserved = reservedMatch(config, [note]);
  if (reserved) refuse(`reserved (${reserved}): left for a human`);
  logRepoEvent(root, APPROVED, { mandate: id, planHash: hash, note, actor: FOREMAN_ACTOR });
  return hash;
}

/** Called by `forge release run` once it finished a plan: a mandate's since plan logs `mandate-release-finished`. */
export function noteMandateReleaseFinished(root: string, plan: Pick<ReleasePlan, 'selection' | 'hash'>): void {
  const sel = plan.selection;
  if (sel.kind !== 'since' || !isMandateId(sel.mandate) || !PLAN_HASH.test(plan.hash)) return;
  logRepoEvent(root, FINISHED, { mandate: sel.mandate, planHash: plan.hash, actor: currentActor(root) });
}
