// The Office pass (`forge office pass`, which `forge dash` runs every foreman.cadence minutes and on
// events): deterministic code, no model, that enforces each mandate's contract. Per mandate, in
// creation order: onUnfinishable on failed jobs, bounce stalls, the self-close with its closing
// summary (then the next link of a chain, in the same pass), the budget pause and the cadence stall.
// An `until: released` mandate whose work is done waits for its release instead of closing: the pass
// plans it (only when unplanned, or when its own plan went stale before any step ran, and never over
// another plan), never runs it, and closes the mandate once the release run finished and no mandate job
// merged after it was planned; while it waits, no budget pause or stall applies.
// When a mandate has director work it wakes the office session with one `direct` request. Every
// status write is guarded: it lands only while the mandate still has the status and updatedAt the
// pass read, so an owner's edit, pause or close wins. docs/architecture/foreman.md › Director loop.
import { ForgeError } from '#core/errors.ts';
import { listRequests, enqueue } from '#core/job/requests.ts';
import { isForemanActor, logEvent } from '#core/job/store.ts';
import { confinedDir, readRegular, writeJsonAtomic } from '#core/os/fs.ts';
import { isMap } from '#core/shape.ts';
import { oneLineTitle } from '#core/text.ts';
import { MANDATE_SUMMARY_SCHEMA_VERSION, MANDATE_SUMMARY_STEPS } from '#core/versions/mandate-summary.ts';
import { runSteps } from '#core/versions/steps.ts';
import { FOREMAN_ACTOR } from '#integrations/github/actor.ts';
import { foremanEnabled } from '#engine/pipeline/moves/foreman-gates.ts';
import { buildReportCard } from '#engine/metrics/report-card.ts';
import { moveJob } from '#engine/pipeline/moves/apply.ts';
import { loadTracker } from '#engine/trackers/load.ts';
import { mandateReleaseRun, mandateReleaseState, planMandateRelease } from '#engine/release/mandate.ts';
import type { MandateReleaseNarrow, MandateReleaseView } from '#engine/release/mandate.ts';
import { mandateReleaseRefusal } from '../foreman.ts';
import { queueNotify } from '../notify.ts';
import type { QueueNotify } from '../notify.ts';
import { cleanReason, isReadable } from './contract.ts';
import { logDirective, readDirectives } from './directives.ts';
import { bounceHold, cadenceStalled, gateEntries, mandateProgress, readProgressCtx, scopeItems } from './progress.ts';
import { listMandates, mandateDir, summaryFile, withOfficeLock, writeMandate } from './store.ts';
import type { Config, JobEvent, Tracker } from '#core/types.ts';
import type { DirectiveAction } from './directives.ts';
import type { MandateProgress, ProgressCtx, ScopeResult } from './progress.ts';
import type { Mandate, MandateReportCard, MandateState, ReadMandate } from './types.ts';

/** One mandate's line in the pass's output. */
export interface PassMandate {
  id: string;
  state: MandateState;
  actions: DirectiveAction[];
  inFlight: number;
  free: number;
  candidates: number;
  spentUsd: number;
  started: number;
  blocked: string | null;
  /** An effective `until: released` mandate's release state, else null. */
  release: MandateReleaseView | null;
}

export interface PassResult {
  ok: true;
  enabled: boolean;
  mandates: PassMandate[];
  direct: string | null;
  problems: { id: string; problem: string }[];
}

export interface PassOptions {
  /** The tracker, or null for none; loaded with loadTracker when undefined. */
  tracker?: Tracker | null;
  notify?: QueueNotify;
  /** The pass's clock (ms): stalls are judged and status times written against it. */
  at?: number;
}

/** `.forge/runtime/mandates/<id>/summary.json`: what a closed mandate did. */
export interface MandateClosing {
  schemaVersion: number;
  mandate: string;
  closedAt: string;
  until: string;
  jobs: { id: string; issue: string | null; outcome: 'reached' | 'cancelled' | 'parked'; pr: number | null }[];
  spend: { usd: number; started: number };
  humanInterventions: number;
  stalls: number;
  parked: { job: string; why: string }[];
  skipped: { issue: string; why: string }[];
  elsewhere: string[];
  needsInfo: string[];
  /** The report card at close (lib/engine/metrics/report-card.ts); null in a summary written before the card. */
  card: MandateReportCard | null;
}

const SUMMARY_MAX_BYTES = 64 * 1024;
const REASON_MAX = 200;

/** A goal mandate whose draft isn't filed yet: nothing to enforce until its scope is set. */
const drafting = (m: Mandate): boolean => m.goal !== null && !m.scope.milestones.length && !m.scope.labels.length && !m.scope.issues.length;

/** Every human decision by a person (not the foreman) on the mandate's jobs. */
const humanCount = (events: JobEvent[]): number => events.filter((e) => e.type === 'human' && !isForemanActor(e)).length;

/** Why a handled failed job was parked: its latest `mandate-unfinishable` event's why. */
function parkedWhy(events: JobEvent[]): string {
  const e = events.findLast((x) => x.type === 'mandate-unfinishable');
  return cleanReason(e?.why) ?? 'failed';
}

/** The closing summary of a mandate whose work is done, from its progress, with its report card built from the same progress. */
export function buildSummary(m: Mandate, p: MandateProgress, closedAt: string, directivePauses: number, card: MandateReportCard): MandateClosing {
  const jobs: MandateClosing['jobs'] = [];
  const parked: MandateClosing['parked'] = [];
  let humans = 0;
  let stalls = directivePauses;
  for (const j of p.jobs) {
    humans += humanCount(j.events);
    stalls += j.events.filter((e) => e.type === 'mandate-stalled').length;
    const outcome = j.class === 'reached' ? 'reached' : j.job.state === 'cancelled' ? 'cancelled' : 'parked';
    const pr = j.job.pr?.number;
    jobs.push({ id: j.id, issue: j.issue, outcome, pr: Number.isSafeInteger(pr) ? (pr as number) : null });
    if (outcome === 'parked') parked.push({ job: j.id, why: parkedWhy(j.events) });
  }
  return {
    schemaVersion: MANDATE_SUMMARY_SCHEMA_VERSION,
    mandate: m.id,
    closedAt,
    until: p.until,
    jobs,
    spend: { usd: p.spentUsd, started: p.started },
    humanInterventions: humans,
    stalls,
    parked,
    skipped: p.skipped.map((s) => ({ ...s })),
    elsewhere: [...p.elsewhere],
    needsInfo: [...p.needsInfo],
    card,
  };
}

/** Writes summary.json through real directories, never a planted link. */
export function writeSummary(root: string, s: MandateClosing): void {
  confinedDir(root, mandateDir(root, s.mandate));
  writeJsonAtomic(summaryFile(root, s.mandate), s, { root });
}

/**
 * A closed mandate's summary: null when there is none, or `{problem}` when it can't be read safely (a
 * link, not a regular file, over 64 KiB, not JSON, or a newer schemaVersion).
 */
export function readSummary(root: string, id: string): MandateClosing | { problem: string } | null {
  const bytes = readRegular(summaryFile(root, id), SUMMARY_MAX_BYTES);
  if (typeof bytes === 'string') return bytes === 'unreadable (ENOENT)' ? null : { problem: bytes };
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { problem: 'not JSON' };
  }
  if (!isMap(raw)) return { problem: 'not a JSON object' };
  const v = raw.schemaVersion;
  if (!Number.isInteger(v) || (v as number) < 1) return { problem: 'schemaVersion must be a positive integer' };
  if ((v as number) > MANDATE_SUMMARY_SCHEMA_VERSION) return { problem: `written by a newer Forge (schemaVersion ${v}); update the plugin` };
  const s = runSteps(MANDATE_SUMMARY_STEPS, raw, v as number);
  if (s.mandate !== id) return { problem: `its mandate differs from ${id}` };
  return { ...(s as MandateClosing), schemaVersion: MANDATE_SUMMARY_SCHEMA_VERSION };
}

/**
 * A status move by the pass: written only while the mandate still has the status and updatedAt the pass
 * read, with the foreman as the audit actor. `before` runs under the mandates lock just before the write
 * (the closing summary). Returns whether it was written.
 */
function guardedMove(root: string, read: Mandate, action: 'pause' | 'close', reason: string, at: string, before?: () => void): boolean {
  const out = writeMandate(root, (all) => {
    const cur = all.find((x) => x.id === read.id);
    if (!isReadable(cur) || cur.status !== read.status || cur.updatedAt !== read.updatedAt || cur.status === 'closed') return null;
    if (action === 'pause' && cur.status !== 'active') return null;
    before?.();
    const next: Mandate = action === 'close' ? { ...cur, status: 'closed', reason, closedAt: at, updatedAt: at } : { ...cur, status: 'paused', reason, updatedAt: at };
    return { mandate: next, action, reason, actor: FOREMAN_ACTOR };
  });
  return out !== null;
}

const money = (n: number): string => String(Math.round(n * 100) / 100);
const cut = (s: string): string => s.slice(0, REASON_MAX);

/**
 * An `until: released` mandate whose work is done: its release state, after planning it when it is
 * unplanned, or stale with no run of it in progress, and the mandate is active (a paused one is never
 * planned). A plan logs a `release` directive, and notifies `gate` when it is the mandate's first or
 * follows a release that ran: a re-plan of a plan that never ran asks nothing new of a person, so it
 * notifies no one again. A refusal (no tag, nothing to release, another plan in release.json that hasn't
 * started, another plan's unfinished run…) plans nothing and becomes the mandate's `blocked`.
 */
function awaitRelease(
  root: string,
  config: Config,
  m: Mandate,
  state: MandateState,
  narrow: MandateReleaseNarrow,
  directive: (action: DirectiveAction, reason: string) => void,
  notify: QueueNotify,
): { view: MandateReleaseView; blocked: string } {
  let view = mandateReleaseState(root, config, m.id, narrow);
  let refusal: string | null = null;
  const run = view.status === 'stale' ? mandateReleaseRun(root, m.id) : 'none';
  if (state === 'active' && (view.status === 'unplanned' || (view.status === 'stale' && run !== 'started'))) {
    try {
      const planned = planMandateRelease(root, config, m.id, { narrow, actor: FOREMAN_ACTOR, byPass: true });
      directive('release', `planned ${planned.hash} since ${planned.tag}`);
      if (view.status === 'unplanned' || run === 'finished') notify(root, ['gate'], { reason: 'mandate-release', mandate: m.id });
      view = mandateReleaseState(root, config, m.id, narrow);
    } catch (e) {
      if (!(e instanceof ForgeError)) throw e;
      refusal = oneLineTitle(e.message);
    }
  }
  return { view, blocked: cut(`release: ${refusal ?? view.detail}`) };
}

/**
 * One run of the Office pass. With foreman.enabled false it writes nothing. Otherwise, under the office
 * lock, it enforces every readable mandate that is not closed and not a goal mandate still drafting, and
 * enqueues one `direct` request when some mandate has director work and none is open.
 */
export async function runOfficePass(root: string, config: Config, opts: PassOptions = {}): Promise<PassResult> {
  if (!foremanEnabled(config)) return { ok: true, enabled: false, mandates: [], direct: null, problems: [] };
  return withOfficeLock(root, () => pass(root, config, opts));
}

async function pass(root: string, config: Config, opts: PassOptions): Promise<PassResult> {
  const at = opts.at ?? Date.now();
  const iso = new Date(at).toISOString();
  const notify = opts.notify ?? queueNotify;
  let tracker: Tracker | null = null;
  let trackerError: string | null = null;
  if (opts.tracker !== undefined) tracker = opts.tracker;
  else {
    try {
      tracker = await loadTracker(root, config);
    } catch (e) {
      trackerError = oneLineTitle((e as Error)?.message ?? String(e)).slice(0, REASON_MAX) || 'the tracker failed to load';
    }
  }
  // The ledger and the repo budget are read once; jobs, requests and directives again per mandate, as the pass changes them.
  const base = readProgressCtx(root, config, { tracker, trackerError, at, check: true });
  const fresh = (): ProgressCtx => ({ ...readProgressCtx(root, config, { tracker, trackerError, at }), ledger: base.ledger, repoBudget: base.repoBudget });
  const scopes = new Map<string, ScopeResult>();
  const results = new Map<string, PassMandate>();
  const problems: PassResult['problems'] = [];
  let direct = false;

  const initial = listMandates(root);
  for (const m of initial) if (!isReadable(m)) problems.push({ id: m.id, problem: m.problem });
  const queue = initial.filter(isReadable).map((m) => m.id);

  const progressOf = (m: Mandate, all: ReadMandate[]): MandateProgress => {
    const ctx = fresh();
    let scope = scopes.get(m.id);
    if (!scope) {
      scope = scopeItems(root, config, m, tracker, trackerError);
      scopes.set(m.id, scope);
    }
    return mandateProgress(root, config, m, all, { ...ctx, scope });
  };

  while (queue.length) {
    const id = queue.shift()!;
    let all = listMandates(root);
    let m = all.find((x) => x.id === id);
    if (!isReadable(m) || m.status === 'closed' || drafting(m)) continue;
    const actions: DirectiveAction[] = [];
    const directive = (action: DirectiveAction, reason: string, job?: { id: string; issue: string | null }) => {
      logDirective(root, { mandate: m!.id, action, issue: job?.issue ?? null, job: job?.id ?? null, reason, actor: FOREMAN_ACTOR });
      actions.push(action);
    };
    let p = progressOf(m, all);

    // 1. onUnfinishable, on every unfinishable job the CLI can still act on.
    for (const j of p.jobs.filter((x) => x.class === 'unfinishable' && x.live)) {
      const action = m.onUnfinishable;
      if (action === 'cancel') await moveJob(root, config, j.id, { state: 'cancelled', reason: `mandate ${m.id}: unfinishable (failed): cancelled` });
      logEvent(root, j.id, 'mandate-unfinishable', { mandate: m.id, action, why: 'failed' });
      directive(action === 'cancel' ? 'cancel' : 'park', `unfinishable (failed): ${action === 'cancel' ? 'cancelled' : 'parked'}`, j);
    }

    // 2. Bounce stalls: once per park.
    for (const j of p.jobs.filter((x) => x.class === 'inFlight' && x.live)) {
      const held = bounceHold(j.job, j.events, m);
      if (!held) continue;
      const t = j.events.findLastIndex((e) => e.type === 'transition');
      if (j.events.some((e, i) => i > t && e.type === 'mandate-stalled')) continue;
      const waitingOn = j.job.waitingOn as string;
      logEvent(root, j.id, 'mandate-stalled', { mandate: m.id, waitingOn, bounces: gateEntries(j.events, waitingOn) });
      directive('stall', held, j);
      notify(root, ['mandate-stalled'], { job: j.id, reason: 'mandate-stalled' });
    }

    if (actions.length) {
      all = listMandates(root);
      m = all.find((x) => x.id === id) as Mandate;
      p = progressOf(m, all);
    }

    // 3. Close: no tracker error, nothing left to start, nothing in flight or unfinishable. An until:
    // released mandate first waits for its release, and closes once the release run finished.
    let state = p.state;
    const narrow: MandateReleaseNarrow = (x) => mandateReleaseRefusal(root, config, x);
    const workDone = (state === 'active' || state === 'paused') && p.trackerError === null && !p.candidates.length && !p.counts.inFlight && !p.counts.unfinishable;
    let release: MandateReleaseView | null = null;
    let waiting: string | null = null;
    if (workDone && p.until === 'released') {
      const r = awaitRelease(root, config, m, state, narrow, directive, notify);
      release = r.view;
      if (r.view.status !== 'done') waiting = r.blocked;
    } else if (p.until === 'released') release = mandateReleaseState(root, config, id, narrow);
    if (workDone && waiting === null) {
      const parked = p.jobs.filter((j) => j.class === 'handled' && j.job.state === 'failed').length;
      const reason = cut(`done: ${p.counts.reached} jobs reached ${p.until}, ${parked} parked, $${money(p.spentUsd)}`);
      const pauses = readDirectives(root, { mandate: id }).filter((d) => d.action === 'pause' && d.reason.startsWith('stalled:')).length;
      const closing = buildSummary(m, p, iso, pauses, buildReportCard(m, p, config, at));
      if (guardedMove(root, m, 'close', reason, iso, () => writeSummary(root, closing))) {
        directive('close', reason);
        notify(root, ['mandate-closed'], { reason: 'mandate-closed', mandate: id });
        state = 'closed';
        // The next link of the chain starts in this same pass.
        for (const f of listMandates(root)) if (isReadable(f) && f.after === id && !queue.includes(f.id)) queue.push(f.id);
      }
    }

    // 4. Budget, then 5. the cadence stall: active mandates only, and never one waiting on a person for its release.
    if (state === 'active' && waiting === null) {
      let pause: { reason: string; event: 'mandate-budget' | 'mandate-stalled' } | null = null;
      if (p.spentUsd >= m.budget.usd) pause = { reason: `budget: $${money(p.spentUsd)} of $${money(m.budget.usd)} spent`, event: 'mandate-budget' };
      else if (p.started >= m.budget.jobs && p.candidates.length) pause = { reason: `budget: ${p.started} of ${m.budget.jobs} jobs started`, event: 'mandate-budget' };
      else {
        const stalled = cadenceStalled(m, p.lastActivity, config, at);
        if (stalled) pause = { reason: cut(`stalled: no progress for ${stalled.minutes} min (${stalled.passes} passes)${p.trackerError ? `; tracker: ${p.trackerError}` : ''}`), event: 'mandate-stalled' };
      }
      if (pause && guardedMove(root, m, 'pause', pause.reason, iso)) {
        directive('pause', pause.reason);
        notify(root, [pause.event], { reason: pause.event, mandate: id });
        state = 'paused';
      }
    }

    // 6. Director work: something to start or resume under an active mandate that is not blocked.
    const blocked = waiting ?? (state === 'active' ? p.blocked : `mandate ${id} is ${state}`);
    if (state === 'active' && blocked === null && (p.window.length || p.resumable.length)) direct = true;
    results.set(id, { id, state, actions, inFlight: p.inFlight, free: p.free, candidates: p.candidates.length, spentUsd: p.spentUsd, started: p.started, blocked, release });
  }

  let request: string | null = null;
  if (direct && !listRequests(root).some((r) => r.type === 'direct' && (r.status === 'pending' || r.status === 'in-progress'))) {
    request = enqueue(root, config, { type: 'direct', job: null, args: {}, from: 'forge' }).id;
  }
  return { ok: true, enabled: true, mandates: [...results.values()], direct: request, problems };
}
