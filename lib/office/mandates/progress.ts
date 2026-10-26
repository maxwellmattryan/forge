// A mandate's progress, which the Office pass enforces and `forge office survey|start` and `forge
// mandate show` read: its jobs and how each stands against its `until`, its spend and starts, the scope
// items the tracker lists for it, the candidates and the window the Foreman may start from, why it is
// blocked, and its stalls. It reads only the CLI's records: listJobs and readEvents (the CLI copy), the
// archive and the spend ledger, never a job folder's session-writable job.json or events.jsonl.
// docs/architecture/foreman.md › Director loop.
import { checkIssueRef, sameIssue } from '#core/job/issue-ref.ts';
import { listArchived } from '#core/job/archive.ts';
import { listRequests } from '#core/job/requests.ts';
import { isActive, isForemanActor, leaseStatus, listJobs, readEvents } from '#core/job/store.ts';
import { oneLineTitle } from '#core/text.ts';
import { localRepoSlug } from '#integrations/git/repo-slug.ts';
import { checkRepoBudget, repoBudgetStatus } from '#engine/metrics/repo-budget.ts';
import { spendLedger } from '#engine/metrics/spend.ts';
import { foremanEnabled } from '#engine/pipeline/moves/foreman-gates.ts';
import { cadenceMinutes } from '../cadence.ts';
import { effectiveContract, mandateState } from './contract.ts';
import { readDirectives } from './directives.ts';
import type { ArchivedJob, Config, ForgeRequest, Job, JobEvent, LoadedJob, MandateUntil, Tracker, TrackerItem, TransitionSide } from '#core/types.ts';
import type { SpendJob } from '#engine/metrics/spend.ts';
import type { Directive } from './directives.ts';
import type { Mandate, MandateState, ReadMandate } from './types.ts';

/** How one mandate job stands against the mandate's until. */
export type JobClass = 'reached' | 'handled' | 'unfinishable' | 'inFlight';

/** One of the mandate's jobs: a live job (its CLI record) or an archived one, with its events. */
export interface MandateJob {
  id: string;
  issue: string | null;
  class: JobClass;
  live: boolean;
  job: Job;
  events: JobEvent[];
}

/** A scope item in its stored form, with the milestone it was listed under (null for labels or issues). */
export interface ScopeItem {
  ref: string;
  title: string;
  milestone: string | null;
  needsInfo: boolean;
  priority: string | null;
}

/** What a progress read is given: the records it reads once per pass, and when it is. */
export interface ProgressCtx {
  jobs: LoadedJob[];
  archived: ArchivedJob[];
  ledger: Record<string, SpendJob>;
  tracker: Tracker | null;
  trackerError: string | null;
  requests: ForgeRequest[];
  directives: Directive[];
  repoBudget: { held: boolean; reason: string | null };
  at: number;
  /** Scope items already listed for this mandate in this pass: no second tracker call. */
  scope?: ScopeResult;
}

/** The scope items, one group per milestone (one group for labels or issues), or why they can't be listed. */
export interface ScopeResult {
  groups: { milestone: string | null; items: ScopeItem[] }[];
  error: string | null;
}

/** The figures that need no tracker call. */
export interface JobFigures {
  until: MandateUntil;
  jobs: MandateJob[];
  counts: { reached: number; inFlight: number; handled: number; unfinishable: number };
  inFlight: number;
  started: number;
  spentUsd: number;
  lastActivity: string;
}

export interface MandateProgress extends JobFigures {
  state: MandateState;
  free: number;
  candidates: ScopeItem[];
  window: ScopeItem[];
  resumable: string[];
  needsInfo: string[];
  elsewhere: string[];
  skipped: { issue: string; why: string }[];
  trackerError: string | null;
  blocked: string | null;
}

/**
 * The records a progress read takes, read once: the live jobs, the archive, the spend ledger (never
 * written here), the requests, the directives and the repo budget (`check`: checkRepoBudget, which may
 * release holds, as every place a job starts runs it; else the read-only status).
 */
export function readProgressCtx(root: string, config: Config, o: { tracker: Tracker | null; trackerError: string | null; at?: number; check?: boolean }): ProgressCtx {
  const status = o.check ? checkRepoBudget(root, config) : repoBudgetStatus(root, config, { write: false });
  return {
    jobs: listJobs(root),
    archived: listArchived(root),
    ledger: spendLedger(root, config, { write: false }),
    tracker: o.tracker,
    trackerError: o.trackerError,
    requests: listRequests(root),
    directives: readDirectives(root),
    repoBudget: { held: status.held, reason: status.reason },
    at: o.at ?? Date.now(),
  };
}

/** At most this many items per scope call. */
const SCOPE_LIMIT = 200;
/** The window under graph and priority: at most this many candidates. */
const WINDOW_MAX = 10;
/** Waits that are a normal part of the work, never a bounce. */
const UNCOUNTED = new Set(['pr-review', 'external']);

const side = (s: unknown): Partial<TransitionSide> => (s && typeof s === 'object' ? (s as TransitionSide) : {});
const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const latestTransition = (events: JobEvent[]): number => events.findLastIndex((e) => e.type === 'transition');

/** The job's primary issue ref, as stored. */
const issueOf = (job: Pick<Job, 'issues'>): string | null => job.issues.find((i) => typeof i.ref === 'string' && i.ref)?.ref ?? null;

/**
 * reached (at its until: merge-ready is done, or a `pr` stage waiting on pr-review with a PR; merged is
 * done), handled (cancelled, or failed with a `mandate-unfinishable` event after its latest transition),
 * unfinishable (failed and not handled), else in flight.
 */
export function classifyJob(job: Pick<Job, 'state' | 'stage' | 'waitingOn' | 'pr'>, events: JobEvent[], until: MandateUntil): JobClass {
  if (job.state === 'done') return 'reached';
  if (until === 'merge-ready' && job.stage === 'pr' && job.state === 'waiting' && job.waitingOn === 'pr-review' && typeof job.pr?.number === 'number') return 'reached';
  if (job.state === 'cancelled') return 'handled';
  if (job.state === 'failed') {
    const t = latestTransition(events);
    return events.some((e, i) => i > t && e.type === 'mandate-unfinishable') ? 'handled' : 'unfinishable';
  }
  return 'inFlight';
}

/** The mandate's jobs: live ones from their CLI records (events from the CLI copy), then archived ones. */
function jobsOf(root: string, m: Mandate, until: MandateUntil, ctx: Pick<ProgressCtx, 'jobs' | 'archived'>): MandateJob[] {
  const out: MandateJob[] = [];
  for (const job of ctx.jobs) {
    if (job.mandate !== m.id) continue;
    const events = readEvents(root, job.id);
    out.push({ id: job.id, issue: issueOf(job), class: classifyJob(job, events, until), live: true, job, events });
  }
  for (const a of ctx.archived) {
    if (a.job.mandate !== m.id || out.some((j) => j.id === a.id)) continue;
    out.push({ id: a.id, issue: issueOf(a.job), class: classifyJob(a.job, a.events, until), live: false, job: a.job, events: a.events });
  }
  return out;
}

/** Every bucket's usd, reported and metered, of the given jobs' ledger entries, to 4 decimals. */
export function mandateSpend(ids: readonly string[], ledger: Record<string, SpendJob>): number {
  let usd = 0;
  for (const id of ids) {
    const e = Object.hasOwn(ledger, id) ? ledger[id] : undefined;
    if (!e) continue;
    for (const b of [...Object.values(e.buckets ?? {}), ...Object.values(e.metered ?? {})]) if (Number.isFinite(b?.usd)) usd += b.usd;
  }
  return round4(usd);
}

/** The latest of the mandate's edit, its `after`'s close, and each live job's creation and latest transition; now while an agent runs. */
function lastActivityOf(m: Mandate, all: ReadMandate[], jobs: MandateJob[], at: number): string {
  if (jobs.some((j) => j.live && Object.values(j.job.agents ?? {}).some((a) => a?.status === 'running'))) return new Date(at).toISOString();
  const times = [m.updatedAt];
  const before = m.after === null ? undefined : all.find((x) => x.id === m.after);
  if (before && !('problem' in before) && before.status === 'closed' && before.closedAt) times.push(before.closedAt);
  for (const j of jobs) {
    if (!j.live) continue;
    if (j.job.createdAt) times.push(j.job.createdAt);
    const t = latestTransition(j.events);
    if (t >= 0) times.push(j.events[t].ts);
  }
  let best = Date.parse(m.updatedAt);
  for (const t of times) {
    const ms = Date.parse(t);
    if (Number.isFinite(ms) && ms > best) best = ms;
  }
  return new Date(best).toISOString();
}

/** The figures `forge mandate show` prints and the pass starts from: no tracker call. */
export function jobFigures(root: string, config: Config, m: Mandate, all: ReadMandate[], ctx: Pick<ProgressCtx, 'jobs' | 'archived' | 'ledger' | 'at'>): JobFigures {
  const until = effectiveContract(config, m).effective.until;
  const jobs = jobsOf(root, m, until, ctx);
  const ids = new Set(jobs.map((j) => j.id));
  const counts = { reached: 0, inFlight: 0, handled: 0, unfinishable: 0 };
  for (const j of jobs) counts[j.class]++;
  return {
    until,
    jobs,
    counts,
    inFlight: counts.inFlight,
    // Split children carry their parent's mandate: only the jobs the mandate itself started count.
    started: jobs.filter((j) => j.job.parent === null || !ids.has(j.job.parent)).length,
    spentUsd: mandateSpend([...ids], ctx.ledger),
    lastActivity: lastActivityOf(m, all, jobs, ctx.at),
  };
}

const errorText = (e: unknown): string => oneLineTitle((e as Error)?.message ?? String(e)).slice(0, 200) || 'failed';

/**
 * The mandate's scope items: `scope.issues` as written (no tracker call) under listed; otherwise one
 * tracker `scope` call per milestone, in order, or one with no milestone for labels alone. A tracker
 * without `scope`, or one that throws, is an error. Each ref is turned into its stored form.
 */
export function scopeItems(root: string, config: Config, m: Mandate, tracker: Tracker | null, trackerError: string | null): ScopeResult {
  const { milestones, labels, issues } = m.scope;
  if (m.order === 'listed' || (!milestones.length && !labels.length)) {
    return { groups: issues.length ? [{ milestone: null, items: issues.map((ref) => ({ ref, title: '', milestone: null, needsInfo: false, priority: null })) }] : [], error: null };
  }
  if (trackerError !== null) return { groups: [], error: trackerError };
  if (!tracker || typeof tracker.scope !== 'function') return { groups: [], error: `tracker ${oneLineTitle(config.tracker?.kind ?? 'none').slice(0, 60)} can't list a mandate's scope` };
  const kind = config.tracker.kind;
  const slug = kind === 'github' ? localRepoSlug(root, config) : null;
  const ctx = { root, config };
  const groups: ScopeResult['groups'] = [];
  try {
    for (const milestone of milestones.length ? milestones : [null]) {
      const listed: TrackerItem[] = tracker.scope(ctx, { milestone, labels: [...labels], limit: SCOPE_LIMIT });
      if (!Array.isArray(listed)) throw new Error('scope returned no list');
      const items: ScopeItem[] = [];
      for (const it of listed) {
        const r = checkIssueRef(it?.ref === undefined ? '' : String(it.ref), { tracker: kind, slug });
        if ('error' in r || items.some((x) => x.ref === r.ref)) continue;
        items.push({ ref: r.ref, title: oneLineTitle(it.title ?? ''), milestone, needsInfo: it.needsInfo === true, priority: typeof it.priority === 'string' && it.priority ? it.priority : null });
      }
      groups.push({ milestone, items });
    }
  } catch (e) {
    return { groups: [], error: errorText(e) };
  }
  return { groups, error: null };
}

/** The issue number a ref ends with, for ordering; null for a ref with none. */
const numberOf = (ref: string): number | null => {
  const n = /(\d+)$/.exec(ref);
  return n ? Number(n[1]) : null;
};

const byNumber = (a: ScopeItem, b: ScopeItem): number => {
  const x = numberOf(a.ref);
  const y = numberOf(b.ref);
  if (x !== null && y !== null && x !== y) return x - y;
  if (x === null && y !== null) return 1;
  if (y === null && x !== null) return -1;
  return a.ref.localeCompare(b.ref);
};

const byPriority = (a: ScopeItem, b: ScopeItem): number => {
  if (a.priority !== b.priority) {
    if (a.priority === null) return 1;
    if (b.priority === null) return -1;
    const c = a.priority.localeCompare(b.priority, undefined, { numeric: true });
    if (c) return c;
  }
  return byNumber(a, b);
};

/**
 * Everything the pass, the survey and `forge office start` read for one mandate: the job figures, the
 * candidates (scope items not needs-info, carried by no live job and not skipped, in the mandate's
 * order, from the first milestone with open work), the window, the resumable jobs and why it is blocked.
 */
export function mandateProgress(root: string, config: Config, m: Mandate, all: ReadMandate[], ctx: ProgressCtx): MandateProgress {
  const figures = jobFigures(root, config, m, all, ctx);
  const state = mandateState(m, all);
  const scope = ctx.scope ?? scopeItems(root, config, m, ctx.tracker, ctx.trackerError);
  const kind = config.tracker?.kind ?? 'local';
  const slug = kind === 'github' ? localRepoSlug(root, config) : null;
  const carries = (j: Pick<Job, 'issues'>, ref: string) => j.issues.some((i) => sameIssue(i, { tracker: kind, ref }, slug));
  const skips = new Map<string, string>();
  for (const d of ctx.directives) if (d.mandate === m.id && d.action === 'skip' && d.issue) skips.set(d.issue, d.reason);

  const needsInfo: string[] = [];
  const elsewhere: string[] = [];
  const skipped: { issue: string; why: string }[] = [];
  let candidates: ScopeItem[] = [];
  let chosen = false;
  const sort = m.order === 'listed' ? null : m.order === 'priority' ? byPriority : byNumber;
  for (const g of scope.groups) {
    const open: ScopeItem[] = [];
    let busy = false;
    for (const it of g.items) {
      if (it.needsInfo) {
        needsInfo.push(it.ref);
        continue;
      }
      // Any job of this mandate, archived ones too, still carries its issue: a cancelled one is never
      // restarted. Outside it, only an active job does, the match startFromRef's `existing` uses.
      const mine = figures.jobs.find((j) => carries(j.job, it.ref));
      const other = mine ? undefined : ctx.jobs.find((j) => isActive(j) && carries(j, it.ref));
      if (other) {
        elsewhere.push(it.ref);
        continue;
      }
      if (mine) {
        if (mine.class === 'inFlight' || mine.class === 'unfinishable') busy = true;
        continue;
      }
      const why = skips.get(it.ref);
      if (why !== undefined) {
        skipped.push({ issue: it.ref, why });
        continue;
      }
      open.push(it);
    }
    // One milestone at a time: the first with open work offers its candidates, and the rest wait.
    if (!chosen && (open.length || busy)) {
      chosen = true;
      candidates = sort ? [...open].sort(sort) : open;
    }
  }

  const trackerError = scope.error;
  const free = Math.max(0, m.maxJobs - figures.inFlight);
  const budget = m.budget;
  const blocked =
    state !== 'active'
      ? `mandate ${m.id} is ${state}`
      : figures.spentUsd >= budget.usd
        ? `budget: $${figures.spentUsd} of $${budget.usd} spent`
        : figures.started >= budget.jobs
          ? `budget: ${figures.started} of ${budget.jobs} jobs started`
          : ctx.repoBudget.held
            ? `repo budget: ${ctx.repoBudget.reason ?? 'held'}`
            : trackerError !== null
              ? `tracker: ${trackerError}`
              : !foremanEnabled(config)
                ? 'foreman.enabled is false'
                : null;
  const window = free === 0 || blocked !== null ? [] : candidates.slice(0, m.order === 'listed' ? free : Math.min(WINDOW_MAX, 3 * free));
  const open = new Set(ctx.requests.filter((r) => r.status === 'pending' || r.status === 'in-progress').map((r) => r.job));
  const resumable = figures.jobs.filter((j) => j.live && j.job.state === 'queued' && leaseStatus(j.job, ctx.at).status !== 'live' && !open.has(j.id)).map((j) => j.id);
  return { ...figures, state, free, candidates, window, resumable, needsInfo, elsewhere, skipped, trackerError, blocked };
}

/**
 * How many times the job entered the wait `waitingOn` since a person's latest decision: transitions into
 * it, except a reason change while already there. A foreman decision never resets the count.
 */
export function gateEntries(events: JobEvent[], waitingOn: string): number {
  const reset = events.findLastIndex((e) => e.type === 'human' && !isForemanActor(e));
  let n = 0;
  events.forEach((e, i) => {
    if (i <= reset || e.type !== 'transition') return;
    const to = side(e.to);
    const from = side(e.from);
    if (to.state === 'waiting' && to.waitingOn === waitingOn && !(from.state === 'waiting' && from.waitingOn === waitingOn)) n++;
  });
  return n;
}

/**
 * Why a mandate job's gate is left for a human because it keeps coming back: it waits on a counted gate
 * (not pr-review or external) it has entered at least `stall.bounces` times since a person decided.
 */
export function bounceHold(job: Pick<Job, 'state' | 'waitingOn'>, events: JobEvent[], m: Pick<Mandate, 'id' | 'stall'>): string | null {
  const w = job.waitingOn;
  if (job.state !== 'waiting' || !w || UNCOUNTED.has(w)) return null;
  const n = gateEntries(events, w);
  return n >= m.stall.bounces ? `mandate ${m.id}: back at ${w} ${n} times (stall.bounces ${m.stall.bounces}): left for a human` : null;
}

/** An active mandate with no progress for stall.cadences passes of foreman.cadence minutes: the minutes and passes, else null. */
export function cadenceStalled(m: Pick<Mandate, 'stall'>, lastActivity: string, config: Config, at: number): { minutes: number; passes: number } | null {
  const minutes = m.stall.cadences * cadenceMinutes(config);
  const last = Date.parse(lastActivity);
  return Number.isFinite(last) && at - last >= minutes * 60 * 1000 ? { minutes, passes: m.stall.cadences } : null;
}
