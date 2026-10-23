// The live board's pure half: what each daemon session is doing, which jobs just changed, and the shared clock's
// visibility-aware interval. No DOM access (startTicker takes its document and timers), so node:test can drive it.
import { asking, obj } from './daemon.ts';
import type { PoolInput, SessionInput } from './daemon.ts';
import { INBOX_SCOPE, OFFICE_SCOPE } from './types.ts';

export type ActivityKind = 'working' | 'asking' | 'waiting' | 'idle' | 'off';
export interface Activity {
  kind: ActivityKind;
  /** When the shown state began, for the ticking "· 4s ago"; null when there is no time to show. */
  since: string | null;
}

/** A parseable ISO time's epoch ms, else NaN: session fields and event times are read, never trusted. */
const epoch = (iso: unknown): number => (typeof iso === 'string' ? Date.parse(iso) : NaN);

/** The latest (or, with `oldest`, the earliest) parseable time of `times`, as given; null when none parses. */
function pick(times: unknown[], oldest = false): string | null {
  let best: string | null = null;
  for (const t of times) {
    const n = epoch(t);
    if (Number.isNaN(n)) continue;
    if (best === null || (oldest ? n < epoch(best) : n > epoch(best))) best = t as string;
  }
  return best;
}

/**
 * One session's activity, first match wins: asking (running with a permission prompt), working (busy), waiting (no free
 * slot, or held on budget), idle (running) or off. `lastLineAt` is the caller's freshest sign of life (the job's last
 * event), so a busy session's "working · 4s ago" counts from its latest output rather than its last finished turn.
 */
export function sessionActivity(session: SessionInput, lastLineAt?: string | null): Activity {
  const s = obj(session);
  if (asking(s)) return { kind: 'asking', since: pick((s.permissions as unknown[]).map((p) => obj(p).at), true) };
  if (s.status === 'busy') return { kind: 'working', since: pick([s.lastTurnAt, lastLineAt]) };
  if (s.waiting === true || s.held) return { kind: 'waiting', since: null };
  if (s.running === true) return { kind: 'idle', since: pick([s.lastTurnAt, lastLineAt]) };
  return { kind: 'off', since: null };
}

/** A job's session in the pool, or undefined: own keys only, so a job id never reads Object.prototype. */
const jobSession = (pool: PoolInput, id: string): SessionInput => {
  const jobs = obj(obj(pool).jobs);
  return Object.hasOwn(jobs, id) ? jobs[id] : undefined;
};

const active = (s: SessionInput): boolean => {
  const k = sessionActivity(s).kind;
  return k === 'working' || k === 'asking';
};

/** The sidebar's heartbeat: sessions working or asking, the inbox first, then the office, then job ids sorted. */
export function activeSessions(pool: PoolInput): { count: number; ids: string[] } {
  const p = obj(pool);
  const ids = [...(p.inbox && active(p.inbox) ? [INBOX_SCOPE] : []), ...(p.office && active(p.office) ? [OFFICE_SCOPE] : []), ...Object.keys(obj(p.jobs)).filter((id) => active(jobSession(pool, id))).sort()];
  return { count: ids.length, ids };
}

/** A column header's "N working": the given jobs whose session is busy. */
export const workingCount = (jobs: { id: string }[], pool: PoolInput): number => jobs.filter((j) => sessionActivity(jobSession(pool, j.id)).kind === 'working').length;

/** What a poll must change for a card to flash. */
export const jobSig = (j: { eventCount?: number; state?: string; stage?: string }): string => `${j.eventCount}|${j.state}|${j.stage}`;

/**
 * The ids whose signature differs from the last poll's, and this poll's signatures. With no previous poll (the first
 * load) nothing has changed; against one, a job it lacked is new and counts as changed.
 */
export function changedJobs(
  prev: Record<string, string> | null,
  jobs: { id: string; eventCount?: number; state?: string; stage?: string }[],
  sigOf: (j: { eventCount?: number; state?: string; stage?: string }) => string = jobSig,
): { sigs: Record<string, string>; changed: string[] } {
  const sigs: Record<string, string> = {};
  const changed: string[] = [];
  for (const j of jobs) {
    const sig = sigOf(j);
    sigs[j.id] = sig;
    if (prev && (!Object.hasOwn(prev, j.id) || prev[j.id] !== sig)) changed.push(j.id);
  }
  return { sigs, changed };
}

/** What a poll must change for a card to cool from a stage change. */
export const stageSig = (j: { stage?: string }): string => String(j.stage);

/** The last poll's signatures, for flashes (any change) and cooling (a stage change). */
export interface PollMemo {
  sigs: Record<string, string>;
  stages: Record<string, string>;
}

/**
 * This poll's changed ids (eventCount, state or stage), staged ids (stage only) and the new memo. Nothing is reported on
 * the first load (no memo) or on the first poll after a failed one (`resumed`): what changed while the page was away is
 * not news. A job new to the memo is changed but never staged.
 */
export function pollChanges(memo: PollMemo | null, jobs: { id: string; eventCount?: number; state?: string; stage?: string }[], resumed: boolean): { memo: PollMemo; changed: string[]; staged: string[] } {
  const base = resumed ? null : memo;
  const all = changedJobs(base?.sigs ?? null, jobs);
  const st = changedJobs(base?.stages ?? null, jobs, stageSig);
  const known = base?.stages ?? {};
  return { memo: { sigs: all.sigs, stages: st.sigs }, changed: all.changed, staged: st.changed.filter((id) => Object.hasOwn(known, id)) };
}

/** Flash expiries by job id: each changed id until `now + ms`, unexpired ones kept, expired ones dropped. */
export function addFlashes(prev: Record<string, number>, changed: string[], now: number, ms = 3000): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, until] of Object.entries(prev)) if (until > now) out[id] = until;
  for (const id of changed) out[id] = now + ms;
  return out;
}

/** How many of `total` rows arrived since the baseline count; none before the baseline is known. */
export const freshCount = (total: number, baseline: number | null): number => (baseline === null || total <= baseline ? 0 : total - baseline);

export interface TickerEnv {
  doc: { visibilityState: string; addEventListener(type: 'visibilitychange', fn: () => void): void; removeEventListener(type: 'visibilitychange', fn: () => void): void };
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: any): void;
  now(): number;
}

/**
 * Calls `onTick(now)` every `ms` while the document is visible. Hidden, it schedules nothing; on return it ticks at
 * once, so times catch up before the next interval. Returns the stop function.
 */
export function startTicker(onTick: (now: number) => void, env: TickerEnv, ms = 1000): () => void {
  // Called unbound: a browser's setInterval throws "Illegal invocation" when called as a method of another object.
  const { doc, setInterval: set, clearInterval: clear, now } = env;
  let handle: unknown;
  let running = false;
  const resume = () => {
    if (running) return;
    running = true;
    handle = set(() => onTick(now()), ms);
  };
  const pause = () => {
    if (!running) return;
    running = false;
    clear(handle);
  };
  const onVisibility = () => {
    if (doc.visibilityState !== 'visible') return pause();
    onTick(now());
    resume();
  };
  doc.addEventListener('visibilitychange', onVisibility);
  if (doc.visibilityState === 'visible') resume();
  return () => {
    pause();
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
