// The shelf: a person setting a job aside (`forge job shelve`) and taking it off again (`forge job
// unshelve`, the dashboard's Shelved list). The gate runner shelves too, as the Foreman, when its senior
// pass can't settle a gate (lib/office/foreman/senior.ts recordForemanShelve). A shelved job waits on
// `shelved` at its stage, spends nothing, keeps its PR and answers no gate; checkShelfMove
// (lib/core/job/fields.ts) holds that only un-shelving, a finish or a cancel moves it.
import { loadJob, logHumanEvent, setJob } from '#core/job/store.ts';
import { cleanShelveReason, isHumanGrant, SHELVE_REASON_MAX } from '#core/job/schema.ts';
import { enqueue } from '#core/job/requests.ts';
import { ForgeError } from '#core/errors.ts';
import { now } from '#core/utils.ts';
import { hasEnvironment, stopEnvironment } from '../../environment/lifecycle.ts';
import { noteIssues } from '../../trackers/mirror.ts';
import { mirrorJob, moveJob } from './apply.ts';
import type { EnvironmentStopResult } from '../../environment/types.ts';
import type { Config, EventActor, GateClass, HumanGrant, Job, JobChange, JobShelf, LoadedJob, ShelfAction, ShelfResult, Tracker, WaitingOn } from '#core/types.ts';

export { cleanShelveReason, SHELVE_REASON_MAX };

/** The parks a batch Approve decides: the ones the gate's own Approve sends a plain `approve` request for. */
export const SHELF_APPROVE_PARKS: readonly WaitingOn[] = ['spec-approval', 'split-approval', 'escalation', 'rounds-exhausted', 'conflicts'];
/** The parks a batch Rework decides. Budget, human checks, input, issue links, infra and external waits are never batched. */
export const SHELF_REWORK_PARKS: readonly WaitingOn[] = ['escalation', 'rounds-exhausted', 'pr-review'];

/** `forge job shelve`'s output. */
export interface ShelveResult {
  ok: true;
  id: string;
  shelved: JobShelf;
  environment: EnvironmentStopResult | null;
  tracker: { posted: string[]; failed: boolean };
}

/** `forge job unshelve`'s output. */
export interface UnshelveResult {
  ok: true;
  id: string;
  stage: Job['stage'];
  state: Job['state'];
  waitingOn: Job['waitingOn'];
}

/** A refusal shelfAction reports as a skip with its short reason; the CLI prints the full message. */
class ShelfRefusal extends ForgeError {
  declare skip: string;
  constructor(message: string, skip: string) {
    super(message);
    this.skip = skip;
  }
}

export const isShelved = (j: Pick<Job, 'state' | 'waitingOn'>): boolean => j.state === 'waiting' && j.waitingOn === 'shelved';

/** Why shelve refuses the job as the lock read it, or null. */
function shelveRefusal(j: LoadedJob): string | null {
  if (j.kind === 'eval') return `job ${j.id} is an eval job, which has no person to take it off the shelf`;
  if (j.state === 'done' || j.state === 'cancelled') return `job ${j.id} is ${j.state}; only an active job is shelved`;
  if (isShelved(j)) return `job ${j.id} is already shelved`;
  if (j.state === 'running' || Object.values(j.agents).some((a) => a?.status === 'running'))
    return `job ${j.id} is running or has an agent running: shelve it once it waits at a gate, or cancel it`;
  return null;
}

/** What both tracker notes end with: how the job comes off the shelf, and that its PR is left alone. */
const shelfTail = (id: string): string =>
  `Nothing more runs on it until a person picks it up from the dashboard's Shelved list or runs \`forge job unshelve ${id}\`; its pull request, if it has one, stays open.`;

/** The tracker note: fixed text around the cleaned reason in a code span, so no mention or link in it renders. */
export const shelveNote = (id: string, reason: string): string => `Forge shelved this job: \`${reason}\`. ${shelfTail(id)}`;

/**
 * The tracker note for a Foreman shelve: fixed words and the gate's name, never its reason. That reason is model text
 * (the assistant's, the senior's or a failure message), and a tracker comment can be public; it stays on the job.
 */
export const foremanShelveNote = (id: string, gate: GateClass): string =>
  `Forge's Foreman shelved this job at its \`${gate}\` gate because it needs a person to decide; the reason is on the job in the dashboard. ${shelfTail(id)}`;

/**
 * Sets a waiting, queued, failed or blocked job aside in one locked write: it waits on `shelved` at
 * its stage, records where it was in `job.shelved`, and lets go of its lease. Then it logs `shelved`
 * with the actor, stops its environment (the worktree stays) and posts one note to its issues: `note`
 * when given (the caller's own fixed text), else shelveNote. It never calls `gh pr`. Not human-only:
 * shelving only stops spend and is undone by a person.
 */
export async function shelveJob(root: string, config: Config, id: string, opts: { reason: string; actor: EventActor; tracker?: Tracker; note?: string }): Promise<ShelveResult> {
  const reason = cleanShelveReason(opts.reason);
  if (!reason) throw new ForgeError(`forge job shelve needs --reason: some text, at most ${SHELVE_REASON_MAX} characters, without backticks`, 'usage');
  let shelf = null as JobShelf | null;
  const { job, before } = await moveJob(root, config, id, {
    state: 'waiting',
    waitingOn: 'shelved',
    reason: `shelved: ${reason}`,
    release: true,
    shelf: 'shelve',
    derive: (j) => {
      const refusal = shelveRefusal(j);
      if (refusal) throw new ForgeError(refusal);
      const s: JobShelf = { at: now(), reason, actor: opts.actor, from: { state: j.state as JobShelf['from']['state'], waitingOn: j.state === 'waiting' ? j.waitingOn : null, reason: j.reason } };
      shelf = s;
      return { owned: { shelved: s } };
    },
  });
  logHumanEvent(root, job.id, 'shelved', { reason, from: { stage: before.stage, state: before.state, waitingOn: before.waitingOn } }, opts.actor);
  const environment = hasEnvironment(root, job.id) ? stopEnvironment(root, config, job.id, 'park') : null;
  const tracker = await noteIssues(root, config, job, opts.note ?? shelveNote(job.id, reason), opts.tracker);
  return { ok: true, id: job.id, shelved: shelf!, environment, tracker };
}

/** Throws unless the job as the lock read it is shelved, and still the shelving the caller saw (`expectAt`). */
function assertShelved(j: LoadedJob, expectAt: string | undefined): void {
  if (!isShelved(j)) throw new ShelfRefusal(`job ${j.id} is not shelved`, 'not shelved');
  if (expectAt !== undefined && j.shelved?.at !== expectAt) throw new ShelfRefusal(`job ${j.id} was shelved again since the list loaded`, 'shelved again since the list loaded');
}

/** Where un-shelving puts the job: its `from`, or a person's wait when the record is missing or unreadable. */
function restore(j: LoadedJob): JobChange {
  const from = j.shelved?.from;
  if (!from) return { state: 'waiting', waitingOn: 'human', reason: 'un-shelved: its earlier park was unreadable' };
  return { state: from.state, waitingOn: from.waitingOn, reason: from.reason };
}

/**
 * Takes a shelved job off the shelf: a human-only operation, refused without a valid grant. One
 * locked write restores its state, waitingOn and reason, keeps its stage and clears `job.shelved`;
 * `expectAt` pins the shelving the caller saw and `check` refuses on the record as the lock read it.
 * It queues no gate request: the person is already acting, so the job comes back to their Needs you.
 */
export async function unshelveJob(
  root: string,
  config: Config,
  id: string,
  opts: { grant: HumanGrant; expectAt?: string; check?: (j: LoadedJob) => void },
): Promise<UnshelveResult> {
  if (!isHumanGrant(opts.grant))
    throw new ForgeError(`forge job unshelve is a human-only operation: a person runs it in their own terminal, or uses Un-shelve in the dashboard's Shelved list`, 'human_only');
  const job = setJob(root, id, {
    shelf: 'unshelve',
    derive: (j) => {
      assertShelved(j, opts.expectAt);
      opts.check?.(j);
      return restore(j);
    },
  });
  logHumanEvent(root, job.id, 'unshelved', { to: { state: job.state, waitingOn: job.waitingOn }, channel: opts.grant.channel }, opts.grant.actor);
  await mirrorJob(root, config, job);
  return { ok: true, id: job.id, stage: job.stage, state: job.state, waitingOn: job.waitingOn };
}

const ACTION_OUTCOME: Record<ShelfAction, ShelfResult['outcome']> = { approve: 'approved', rework: 'reworked', unshelve: 'unshelved', close: 'closed' };

/** Refuses an approve or rework whose earlier park doesn't take it: those are decided one at a time, at their gate. */
function parkTakes(action: 'approve' | 'rework'): (j: LoadedJob) => void {
  const parks = action === 'approve' ? SHELF_APPROVE_PARKS : SHELF_REWORK_PARKS;
  return (j) => {
    const from = j.shelved?.from;
    if (from?.waitingOn && parks.includes(from.waitingOn)) return;
    const where = from ? (from.waitingOn ?? from.state) : 'an unreadable park';
    const why = `waits on ${where}, where a batch ${action} doesn't apply; un-shelve it and decide it at its gate`;
    throw new ShelfRefusal(`job ${j.id} ${why}`, why);
  };
}

/**
 * The Shelved list's batch action (POST /api/shelf), job by job in order, each pinned to the
 * `shelvedAt` the list showed. Approve and rework un-shelve, then queue the request the gate's own
 * card sends; close cancels the job and leaves its PR as it is. A job that is refused is reported
 * as skipped with the reason, and never stops the rest.
 */
export async function shelfAction(
  root: string,
  config: Config,
  action: ShelfAction,
  entries: readonly { id: string; shelvedAt: string }[],
  opts: { note: string | null; grant: HumanGrant },
): Promise<ShelfResult[]> {
  if (!isHumanGrant(opts.grant)) throw new ForgeError('the Shelved list acts only for a person', 'human_only');
  const results: ShelfResult[] = [];
  for (const { id, shelvedAt } of entries) {
    try {
      // Unknown here, before any write: loadJob's message names a path, which the reply never shows.
      loadJob(root, id);
    } catch {
      results.push({ id, outcome: 'skipped', reason: 'no such job' });
      continue;
    }
    try {
      if (action === 'close') {
        await moveJob(root, config, id, { state: 'cancelled', reason: 'closed from the shelf', derive: (j) => (assertShelved(j, shelvedAt), null) });
        logHumanEvent(root, id, 'unshelved', { to: { state: 'cancelled', waitingOn: null }, channel: opts.grant.channel }, opts.grant.actor);
      } else {
        await unshelveJob(root, config, id, { grant: opts.grant, expectAt: shelvedAt, check: action === 'unshelve' ? undefined : parkTakes(action) });
        if (action !== 'unshelve') enqueue(root, config, { type: action, job: id, text: opts.note, from: 'dashboard' });
      }
      results.push({ id, outcome: ACTION_OUTCOME[action] });
    } catch (e) {
      if (!(e instanceof ForgeError)) throw e;
      results.push({ id, outcome: 'skipped', reason: e instanceof ShelfRefusal ? e.skip : e.message });
    }
  }
  return results;
}
