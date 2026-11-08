// A mandate's progress, which the Office pass enforces and `forge office survey|start` and `forge
// mandate show` read: its jobs and how each stands against its `until`, its spend and starts, the scope
// items the tracker lists for it, the candidates and the window the Foreman may start from, why it is
// blocked, its quality floor, and its stalls. It reads only the CLI's records: listJobs and readEvents (the CLI copy), the
// archive and the spend ledger, never a job folder's session-writable job.json or events.jsonl. It also holds the
// stored scope read (`<id>/scope.json`, which the Office pass writes) and the mandate plan built from it, which
// makes no tracker call. docs/architecture/foreman/office.md › Director loop, foreman/mandates.md › Mandate plan.
import { checkIssueRef, isStoredRef, sameIssue } from '#core/job/issue-ref.ts';
import { listArchived } from '#core/job/archive.ts';
import { listRequests } from '#core/job/requests.ts';
import { isActive, isForemanActor, leaseStatus, listJobs, readEvents } from '#core/job/store.ts';
import { confinedDir, readRegular, writeJsonAtomic } from '#core/os/fs.ts';
import { isMap } from '#core/shape.ts';
import { oneLineTitle } from '#core/text.ts';
import { localRepoSlug } from '#integrations/git/repo-slug.ts';
import { checkRepoBudget, repoBudgetStatus } from '#engine/metrics/repo-budget.ts';
import { runningScore } from '#engine/metrics/report-card.ts';
import { spendLedger } from '#engine/metrics/spend.ts';
import { foremanEnabled } from '#engine/pipeline/moves/foreman-gates.ts';
import { DEPENDS_MAX, isDependsProblem, parseDependsOn, planGraph, waveOf } from '#engine/trackers/depends.ts';
import { cadenceMinutes } from './cadence.ts';
import { effectiveContract, mandateState } from './contract.ts';
import { readDirectives } from './directives.ts';
import { mandateDir, scopeFile } from './store.ts';
import type { ArchivedJob, Config, ForgeRequest, Job, JobEvent, LoadedJob, MandatePlanResponse, MandateUntil, Tracker, TrackerItem, TransitionSide } from '#core/types.ts';
import type { SpendJob } from '#engine/metrics/spend.ts';
import type { DependsOn } from '#engine/trackers/depends.ts';
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

/**
 * A scope item in its stored form, with the milestone it was listed under (null for labels or issues), its
 * `wave-<n>` label's n and its body's `Depends on:` line (both null for a listed scope).
 */
export interface ScopeItem {
  ref: string;
  title: string;
  milestone: string | null;
  needsInfo: boolean;
  priority: string | null;
  wave: number | null;
  depends: DependsOn | null;
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
/** Waits that are a normal part of the work, never a bounce: the merge queue's (overlap) included. */
const UNCOUNTED = new Set(['pr-review', 'external', 'overlap']);

const side = (s: unknown): Partial<TransitionSide> => (s && typeof s === 'object' ? (s as TransitionSide) : {});
const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const latestTransition = (events: JobEvent[]): number => events.findLastIndex((e) => e.type === 'transition');

/** The job's primary issue ref, as stored. */
const issueOf = (job: Pick<Job, 'issues'>): string | null => job.issues.find((i) => typeof i.ref === 'string' && i.ref)?.ref ?? null;

/**
 * reached (at its until: merge-ready is done, or a `pr` stage waiting on pr-review or overlap with a PR; merged is
 * done; released is done too, as merged: the release belongs to the mandate, not a job, and the Office
 * pass waits for it once every job has merged), handled (cancelled, or failed with a `mandate-unfinishable` event after its latest transition),
 * unfinishable (failed and not handled), else in flight.
 */
export function classifyJob(job: Pick<Job, 'state' | 'stage' | 'waitingOn' | 'pr'>, events: JobEvent[], until: MandateUntil): JobClass {
  if (job.state === 'done') return 'reached';
  if (until === 'merge-ready' && job.stage === 'pr' && job.state === 'waiting' && (job.waitingOn === 'pr-review' || job.waitingOn === 'overlap') && typeof job.pr?.number === 'number') return 'reached';
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

/** Whether the mandate's scope needs a tracker call: not under listed, and with a milestone or a label. */
export const scopeFromTracker = (m: Pick<Mandate, 'order' | 'scope'>): boolean => !(m.order === 'listed' || (!m.scope.milestones.length && !m.scope.labels.length));

/**
 * The mandate's scope items: `scope.issues` as written (no tracker call) under listed; otherwise one
 * tracker `scope` call per milestone, in order, or one with no milestone for labels alone. A tracker
 * without `scope`, or one that throws, is an error. Each ref is turned into its stored form.
 */
export function scopeItems(root: string, config: Config, m: Mandate, tracker: Tracker | null, trackerError: string | null): ScopeResult {
  const { milestones, labels, issues } = m.scope;
  if (!scopeFromTracker(m)) {
    return { groups: issues.length ? [{ milestone: null, items: issues.map((ref) => ({ ref, title: '', milestone: null, needsInfo: false, priority: null, wave: null, depends: null })) }] : [], error: null };
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
        items.push({
          ref: r.ref,
          title: oneLineTitle(it.title ?? ''),
          milestone,
          needsInfo: it.needsInfo === true,
          priority: typeof it.priority === 'string' && it.priority ? it.priority : null,
          wave: waveOf(it.labels),
          // Only the refs that pass the grammar are kept: the body itself is never stored or returned.
          depends: parseDependsOn(it.body, { tracker: kind, slug }),
        });
      }
      groups.push({ milestone, items });
    }
  } catch (e) {
    return { groups: [], error: errorText(e) };
  }
  return { groups, error: null };
}

const SCOPE_FILE_MAX = 1024 * 1024;
const NOT_READ = "the Office pass has not read this mandate's scope yet";
const BAD_SHAPE = 'the stored scope read has a bad shape';

/**
 * Writes the pass's error-free tracker scope read to `<id>/scope.json`, through real directories only:
 * titles and parsed refs, never a body. A cache with `v: 1`, which any other `v` reads as not read yet.
 */
export function storeScope(root: string, m: Mandate, scope: ScopeResult, at: string): void {
  const groups = scope.groups.map((g) => ({
    milestone: g.milestone,
    items: g.items.map((it) => ({ ref: it.ref, title: it.title, milestone: it.milestone, needsInfo: it.needsInfo, priority: it.priority, wave: it.wave, depends: it.depends })),
  }));
  confinedDir(root, mandateDir(root, m.id));
  writeJsonAtomic(scopeFile(root, m.id), { v: 1, mandate: m.id, readAt: at, milestones: m.scope.milestones, labels: m.scope.labels, groups }, { root });
}

const sameList = (a: unknown, b: readonly string[]): boolean => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

/** A stored `depends`: null, one of parseDependsOn's own problems, or 1 to 20 stored refs; undefined for any other shape. */
function storedDepends(v: unknown, kind: string): DependsOn | null | undefined {
  if (v === null) return null;
  if (!isMap(v) || Object.keys(v).length !== 1) return undefined;
  if (isDependsProblem(v.problem)) return { problem: v.problem };
  const refs = v.refs;
  if (Array.isArray(refs) && refs.length >= 1 && refs.length <= DEPENDS_MAX && refs.every((r) => isStoredRef(r, kind))) return { refs: [...refs] };
  return undefined;
}

/** A stored scope item listed under `milestone`, re-checked field by field; null for any other shape. */
function storedItem(v: unknown, milestone: string | null, kind: string): ScopeItem | null {
  if (!isMap(v)) return null;
  const { ref, title, needsInfo, priority, wave } = v;
  const depends = storedDepends(v.depends, kind);
  const waveOk = wave === null || (Number.isInteger(wave) && (wave as number) >= 1 && (wave as number) <= 999);
  const priorityOk = priority === null || (typeof priority === 'string' && priority.length > 0 && priority.length <= 200);
  if (!isStoredRef(ref, kind) || typeof title !== 'string' || typeof needsInfo !== 'boolean' || !priorityOk || !waveOk || depends === undefined || v.milestone !== milestone) return null;
  return { ref, title: oneLineTitle(title), milestone, needsInfo, priority: priority as string | null, wave: wave as number | null, depends };
}

/**
 * The Office pass's stored scope read for the mandate, or one fixed problem: a file that isn't a regular
 * one of at most 1 MiB, isn't JSON, has another `v` (not read yet), names another mandate, was read for
 * other scope lists than the mandate's now, or has a bad shape anywhere.
 */
export function readStoredScope(root: string, m: Mandate, kind: string): { scope: ScopeResult; readAt: string } | { problem: string } {
  const raw = readRegular(scopeFile(root, m.id), SCOPE_FILE_MAX);
  if (typeof raw === 'string') return { problem: raw === 'unreadable (ENOENT)' ? NOT_READ : `the stored scope read is ${raw}` };
  let data: unknown;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch {
    return { problem: 'the stored scope read is not JSON' };
  }
  if (!isMap(data) || data.v !== 1) return { problem: NOT_READ };
  if (data.mandate !== m.id) return { problem: 'the stored scope read is for another mandate' };
  if (!sameList(data.milestones, m.scope.milestones) || !sameList(data.labels, m.scope.labels)) return { problem: "the mandate's scope changed since the Office pass read it" };
  const readAt = typeof data.readAt === 'string' ? Date.parse(data.readAt) : NaN;
  const names = m.scope.milestones.length ? m.scope.milestones : [null];
  const stored = data.groups;
  if (!Number.isFinite(readAt) || !Array.isArray(stored) || stored.length !== names.length) return { problem: BAD_SHAPE };
  const groups: ScopeResult['groups'] = [];
  for (let i = 0; i < names.length; i++) {
    const g = stored[i];
    if (!isMap(g) || g.milestone !== names[i] || !Array.isArray(g.items) || g.items.length > SCOPE_LIMIT) return { problem: BAD_SHAPE };
    const items: ScopeItem[] = [];
    for (const v of g.items) {
      const it = storedItem(v, names[i], kind);
      if (!it) return { problem: BAD_SHAPE };
      items.push(it);
    }
    groups.push({ milestone: names[i], items });
  }
  return { scope: { groups, error: null }, readAt: new Date(readAt).toISOString() };
}

/**
 * The mandate plan (GET /api/mandates/:id/plan, `forge mandate plan`): its scope issues and their
 * dependencies, with the mandate's jobs on them. A scope that needs the tracker comes from the pass's
 * stored read (a `scope` problem when there is no usable one); any other is computed now. It takes no
 * tracker, so it can make no tracker call.
 */
export function mandatePlan(root: string, config: Config, m: Mandate, ctx: Pick<ProgressCtx, 'jobs' | 'archived' | 'at'>): MandatePlanResponse {
  const kind = config.tracker?.kind ?? 'local';
  const slug = kind === 'github' ? localRepoSlug(root, config) : null;
  let items: ScopeItem[] = [];
  let readAt: string | null = null;
  let problem: string | null = null;
  if (!scopeFromTracker(m)) {
    items = scopeItems(root, config, m, null, null).groups.flatMap((g) => g.items);
    readAt = new Date(ctx.at).toISOString();
  } else {
    const r = readStoredScope(root, m, kind);
    if ('problem' in r) problem = r.problem;
    else {
      items = r.scope.groups.flatMap((g) => g.items);
      readAt = r.readAt;
    }
  }
  const jobs = jobsOf(root, m, effectiveContract(config, m).effective.until, ctx).map(({ job }) => ({
    id: job.id,
    title: typeof job.title === 'string' ? job.title : '',
    issues: Array.isArray(job.issues) ? job.issues : [],
    state: job.state,
    dependsOn: Array.isArray(job.dependsOn) ? job.dependsOn : [],
    parent: job.parent ?? null,
    createdAt: job.createdAt ?? null,
  }));
  const g = planGraph({ issues: items, jobs, kind, slug });
  const problems = problem === null ? g.problems : [{ kind: 'scope' as const, ref: null, detail: problem, edges: [] }, ...g.problems];
  return { mandate: m.id, readAt, nodes: g.nodes, edges: g.edges, problems };
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
  const q = qualityFloor(m, figures.jobs);
  const blocked =
    state !== 'active'
      ? `mandate ${m.id} is ${state}`
      : figures.spentUsd >= budget.usd
        ? `budget: $${figures.spentUsd} of $${budget.usd} spent`
        : figures.started >= budget.jobs
          ? `budget: ${figures.started} of ${budget.jobs} jobs started`
          : q !== null
            ? qualityReason(q)
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
 * (not pr-review, external or overlap) it has entered at least `stall.bounces` times since a person decided.
 */
export function bounceHold(job: Pick<Job, 'state' | 'waitingOn'>, events: JobEvent[], m: Pick<Mandate, 'id' | 'stall'>): string | null {
  const w = job.waitingOn;
  if (job.state !== 'waiting' || !w || UNCOUNTED.has(w)) return null;
  const n = gateEntries(events, w);
  return n >= m.stall.bounces ? `mandate ${m.id}: back at ${w} ${n} times (stall.bounces ${m.stall.bounces}): left for a human` : null;
}

/** A quality floor that applies: the running median, the floor and how many scored jobs it is over. */
export interface QualityBreach {
  median: number;
  floor: number;
  scored: number;
}

/**
 * The mandate's quality floor when it applies: a floor is set, at least minScored merged jobs are scored
 * 0-5, and their running median is strictly below the floor; else null. It reads the jobs' CLI records
 * (jobsOf), so a score forged in a job folder's job.json never counts.
 */
export function qualityFloor(m: Pick<Mandate, 'quality'>, jobs: Pick<MandateJob, 'job'>[]): QualityBreach | null {
  const floor = m.quality.pauseBelow;
  if (floor === null) return null;
  const r = runningScore(jobs);
  return r.median !== null && r.scored >= m.quality.minScored && r.median < floor ? { median: r.median, floor, scored: r.scored } : null;
}

/** The pause reason and `blocked` text of a quality floor that applies. */
export const qualityReason = (q: QualityBreach): string => `quality: median ${q.median} below pauseBelow ${q.floor} over ${q.scored} scored jobs`;

/** An active mandate with no progress for stall.cadences passes of foreman.cadence minutes: the minutes and passes, else null. */
export function cadenceStalled(m: Pick<Mandate, 'stall'>, lastActivity: string, config: Config, at: number): { minutes: number; passes: number } | null {
  const minutes = m.stall.cadences * cadenceMinutes(config);
  const last = Date.parse(lastActivity);
  return Number.isFinite(last) && at - last >= minutes * 60 * 1000 ? { minutes, passes: m.stall.cadences } : null;
}
