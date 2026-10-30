// The supervisor's meter: what each daemon session spent, per turn, from claude's own cost report on its
// result line. `.forge/runtime/meter/<scope>.jsonl` holds one record per costed turn. The supervisor in
// `forge dash` is its only writer (lib/office/session/meter.ts), and no CLI command writes it, so no session
// can append to it. claude's figures are cumulative per conversation and carry over a --resume, so each record
// is the delta against a baseline held per spawn (meterDelta). The spend ledger, budget enforcement and the
// reconciler read it. Beside it, each session's own usage per turn (session usage): the result line's `usage`, its
// main-loop calls only, kept so `forge stats` can show the orchestrator's spend after the session logs rotate away. A job
// session's is a `session-usage` job event, the inbox's and office's `.forge/runtime/session-usage/<scope>.jsonl`, both
// written only by the supervisor (lib/office/session/meter.ts recordTurnUsage); no budget reads it.
// docs/architecture/policies.md "Usage accounting".
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '#core/paths.ts';
import { openAppend, openRead } from '#core/job/session-files.ts';
import { INBOX_SCOPE, OFFICE_SCOPE, validRuntimeScope } from '#core/job/requests.ts';
import { ForgeError } from '#core/errors.ts';
import { estimateCost } from '#integrations/claude/pricing.ts';
import { initModel } from '#integrations/claude/stream.ts';
import type { ModelCost, SessionCost, TurnUsage } from '#integrations/claude/types.ts';
import type { LaneSpend, OrchestratorSpend } from '#core/types.ts';

/** The record shape's version: a later shape change appends a step here, and the reader skips any other. */
export const METER_VERSION = 1;
/** A meter file larger than this is not one the supervisor wrote at a sane size; it is not read. */
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_MODELS = 20;

/** claude's raw cumulative at a result: the next resumed spawn's baseline. */
export interface MeterCum {
  usd: number;
  models: Record<string, ModelCost>;
}

/** One turn's delta against its spawn's baseline (meterDelta). */
export interface MeterDelta {
  usd: number;
  /** The four token counts summed over `models`. */
  tokens: number;
  models: Record<string, ModelCost>;
  cum: MeterCum;
  /** The baseline was unknown (a resume the meter has no record of): this record counts 0 and becomes the baseline. */
  rebased?: true;
  /** The cumulative fell below the baseline (a fresh conversation): the whole cumulative counts. */
  reset?: true;
}

/** One line of a meter file. */
export interface MeterRecord extends MeterDelta {
  v: typeof METER_VERSION;
  ts: string;
  scope: string;
  sessionId: string | null;
  spawnId: string;
  /** The session's turn count when the result arrived. */
  turn: number;
}

const FIELDS = ['usd', 'input', 'output', 'cacheRead', 'cacheWrite'] as const;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const obj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const tokensOf = (m: ModelCost): number => m.input + m.output + m.cacheRead + m.cacheWrite;

/** A scope's meter file. The scope is checked first, so no path is ever built from an unvalidated one. */
export function meterFile(root: string, scope: string): string {
  if (!validRuntimeScope(scope)) throw new ForgeError(`invalid meter scope ${JSON.stringify(String(scope).slice(0, 80))}`, 'usage');
  return path.join(paths(root).runtime, 'meter', `${scope}.jsonl`);
}

/** Whether `dir` is missing or a real directory: a planted link or file in its place refuses the meter (and the session-usage ledger). */
function realDirOrMissing(dir: string): boolean {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch {
    return true;
  }
}

/**
 * Appends one record through a descriptor that follows no link and never blocks on a FIFO, in one write.
 * Throws when the runtime or meter directory is not a real directory, or the file is not a regular one.
 */
export function appendMeter(root: string, rec: MeterRecord): void {
  const file = meterFile(root, rec.scope);
  const dir = path.dirname(file);
  for (const d of [paths(root).runtime, dir]) if (!realDirOrMissing(d)) throw new ForgeError(`${d} is not a directory`);
  fs.mkdirSync(dir, { recursive: true });
  const fd = openAppend(file);
  try {
    fs.writeSync(fd, JSON.stringify(rec) + '\n');
  } finally {
    fs.closeSync(fd);
  }
}

/** A models map whose every entry has the five finite, non-negative fields, rebuilt; null otherwise. */
function modelsOf(v: unknown): Record<string, ModelCost> | null {
  if (!obj(v)) return null;
  const entries = Object.entries(v);
  if (entries.length > MAX_MODELS) return null;
  const out: [string, ModelCost][] = [];
  for (const [name, m] of entries) {
    if (!name || name.length > 100 || !obj(m) || !FIELDS.every((f) => fin(m[f]))) return null;
    out.push([name, { usd: m.usd as number, input: m.input as number, output: m.output as number, cacheRead: m.cacheRead as number, cacheWrite: m.cacheWrite as number }]);
  }
  return Object.fromEntries(out);
}

/** One parsed line as a record of `scope`, or null when it breaks any rule. */
function recordOf(raw: unknown, scope: string): MeterRecord | null {
  if (!obj(raw) || raw.v !== METER_VERSION || raw.scope !== scope) return null;
  if (typeof raw.ts !== 'string' || Number.isNaN(Date.parse(raw.ts))) return null;
  if (!(raw.sessionId === null || typeof raw.sessionId === 'string') || typeof raw.spawnId !== 'string') return null;
  if (!fin(raw.turn) || !fin(raw.usd) || !fin(raw.tokens) || !obj(raw.cum) || !fin(raw.cum.usd)) return null;
  const models = modelsOf(raw.models);
  const cumModels = modelsOf(raw.cum.models);
  if (!models || !cumModels) return null;
  const rec: MeterRecord = { v: METER_VERSION, ts: raw.ts, scope, sessionId: raw.sessionId as string | null, spawnId: raw.spawnId, turn: raw.turn, usd: raw.usd, tokens: raw.tokens, models, cum: { usd: raw.cum.usd, models: cumModels } };
  if (raw.rebased === true) rec.rebased = true;
  if (raw.reset === true) rec.reset = true;
  return rec;
}

/**
 * Parsed files by path, kept while their size and mtime hold, so repeated checks don't re-parse. A file that
 * can't be read drops its entry, and past MEMO_MAX the oldest goes, so a long `forge dash` never holds every
 * job it has seen.
 */
const memo = new Map<string, { size: number; mtimeMs: number; records: MeterRecord[] }>();
const MEMO_MAX = 256;

/** A scope's records, and why its file couldn't be read. */
export interface MeterRead {
  records: MeterRecord[];
  /** Null when the file was read or is missing (no records yet); else what is wrong with it, naming the path. */
  problem: string | null;
}

/**
 * A scope's records, oldest first, read through one descriptor that follows no link and never blocks. A line
 * that breaks the record rules is dropped. A missing file has no records and no problem; a linked, non-regular
 * or oversized file, a directory that is not a real one, or a failed read has no records and says why, so a
 * caller that enforces a cap can fail closed.
 */
export function readMeterChecked(root: string, scope: string): MeterRead {
  const file = meterFile(root, scope);
  const unread = (problem: string | null): MeterRead => {
    memo.delete(file);
    return { records: [], problem };
  };
  for (const d of [paths(root).runtime, path.dirname(file)]) if (!realDirOrMissing(d)) return unread(`${d} is not a directory`);
  let fd: number | undefined;
  try {
    fd = openRead(file);
    const st = fs.fstatSync(fd);
    if (st.size > MAX_BYTES) return unread(`${file} is over ${MAX_BYTES / 1024 / 1024} MiB`);
    const hit = memo.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return { records: hit.records, problem: null };
    const records: MeterRecord[] = [];
    for (const line of fs.readFileSync(fd, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      const rec = recordOf(raw, scope);
      if (rec) records.push(rec);
    }
    memo.delete(file);
    memo.set(file, { size: st.size, mtimeMs: st.mtimeMs, records });
    if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!);
    return { records, problem: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return unread(null);
    return unread(code ? `${file} can't be read (${code})` : (err as Error).message);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** A scope's records (readMeterChecked), tolerant: a file that can't be read has none. */
export function readMeter(root: string, scope: string): MeterRecord[] {
  return readMeterChecked(root, scope).records;
}

/** The cumulative a result reports: its usd, or the models' sum when claude sent no usable total. */
function cumOf(cost: SessionCost): MeterCum {
  const models = Object.fromEntries(Object.entries(cost.models).map(([name, m]) => [name, { ...m }]));
  const usd = cost.usd ?? Object.values(models).reduce((n, m) => n + m.usd, 0);
  return { usd: round6(usd), models };
}

/**
 * One turn's spend: the result's cumulative less the spawn's baseline. A null baseline (unknown) rebases,
 * counting 0; a cumulative below the baseline is a fresh conversation, so all of it counts. Per model, a
 * model new since the baseline counts in full and a count that fell clamps to 0.
 */
export function meterDelta(base: MeterCum | null, cost: SessionCost): MeterDelta {
  const cum = cumOf(cost);
  if (base === null) return { usd: 0, tokens: 0, models: {}, cum, rebased: true };
  const reset = cum.usd < base.usd;
  const models = Object.fromEntries(
    Object.entries(cum.models).map(([name, m]) => {
      const b = reset || !Object.hasOwn(base.models, name) ? null : base.models[name];
      const d = Object.fromEntries(FIELDS.map((f) => [f, Math.max(0, m[f] - (b ? b[f] : 0))])) as unknown as ModelCost;
      d.usd = round6(d.usd);
      return [name, d];
    }),
  );
  const usd = reset ? cum.usd : round6(Math.max(0, cum.usd - base.usd));
  const tokens = Object.values(models).reduce((n, m) => n + tokensOf(m), 0);
  return { usd, tokens, models, cum, ...(reset ? { reset: true as const } : {}) };
}

/** The records' usd on the UTC day of `at` (ms). */
export function meterTodayUsd(records: readonly MeterRecord[], at: number): number {
  const day = new Date(at).toISOString().slice(0, 10);
  return round6(records.reduce((n, r) => (new Date(Date.parse(r.ts)).toISOString().slice(0, 10) === day ? n + r.usd : n), 0));
}

/** The last cumulative recorded for `sessionId`, or null when the meter has none (a resume then rebases). */
export function lastMeterCum(records: readonly MeterRecord[], sessionId: string | null | undefined): MeterCum | null {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  return records.findLast((r) => r.sessionId === sessionId)?.cum ?? null;
}

/** The newest record's time, or null: the reconciler's metered progress mark. */
export function lastMeterAt(records: readonly MeterRecord[]): string | null {
  let best: string | null = null;
  for (const r of records) if (best === null || Date.parse(r.ts) > Date.parse(best)) best = r.ts;
  return best;
}

export const SESSION_USAGE_EVENT = 'session-usage';
/** The session-usage runtime record's own version, as METER_VERSION is the meter's: a later shape change bumps it, and the reader skips any other. */
export const SESSION_USAGE_VERSION = 1;

/** One turn's session usage, as a job event's fields or a runtime line's (which adds `v`, `ts` and `scope`). */
export interface SessionUsagePayload {
  session: string | null;
  turn: number;
  model: string | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
  numTurns: number | null;
  durationMs: number | null;
  ok: boolean;
}

/** One session-usage record as stats and the ledger read it: sessionUsageOf. */
export interface SessionUsage {
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  ts: string;
}

const COUNTS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

export function sessionUsagePayload(u: TurnUsage, session: string | null, turn: number, ok: boolean): SessionUsagePayload {
  const { input, output, cacheRead, cacheWrite } = u;
  return { session, turn, model: u.model, usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite }, numTurns: u.numTurns, durationMs: u.durationMs, ok };
}

/**
 * The one validator for a session-usage job event or runtime line: its normalised figures, or null when it is another
 * event type, has no readable `ts`, or a count that is not finite and >= 0. `totalTokens` is the four counts' sum, never
 * the stored one; a model that is not a usable id reads null.
 */
export function sessionUsageOf(e: unknown): SessionUsage | null {
  if (!obj(e) || (e.type !== undefined && e.type !== SESSION_USAGE_EVENT)) return null;
  if (typeof e.ts !== 'string' || Number.isNaN(Date.parse(e.ts))) return null;
  const u = e.usage;
  if (!obj(u) || !COUNTS.every((f) => fin(u[f]))) return null;
  const [input, output, cacheRead, cacheWrite] = COUNTS.map((f) => u[f] as number);
  return { model: initModel(e.model), input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, ts: e.ts };
}

/** Whether an event is a session-usage record: accounting, not activity, for the server's and speed's filters. */
export const isSessionUsageEvent = (e: { type?: unknown } | null | undefined): boolean => e?.type === SESSION_USAGE_EVENT;

/** The inbox's or office's session-usage file. Any other scope throws, so no path is ever built from one. */
export function sessionUsageFile(root: string, scope: string): string {
  if (scope !== INBOX_SCOPE && scope !== OFFICE_SCOPE) throw new ForgeError(`invalid session-usage scope ${JSON.stringify(String(scope).slice(0, 80))}`, 'usage');
  return path.join(paths(root).runtime, 'session-usage', `${scope}.jsonl`);
}

/** Appends one session-usage record as appendMeter does: no link followed, no FIFO blocked on, real directories only, one write. */
export function appendSessionUsage(root: string, scope: string, payload: SessionUsagePayload): void {
  const file = sessionUsageFile(root, scope);
  const dir = path.dirname(file);
  for (const d of [paths(root).runtime, dir]) if (!realDirOrMissing(d)) throw new ForgeError(`${d} is not a directory`);
  fs.mkdirSync(dir, { recursive: true });
  const fd = openAppend(file);
  try {
    fs.writeSync(fd, JSON.stringify({ v: SESSION_USAGE_VERSION, ts: new Date().toISOString(), scope, ...payload }) + '\n');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A scope's session-usage records, oldest first, read as readMeterChecked reads. A line of another version or scope, or
 * one sessionUsageOf refuses, is dropped. A missing, linked, non-regular or oversized file, a directory that is not a real
 * one, or a failed read has none: nothing enforces this figure, so nothing fails closed.
 */
export function readSessionUsage(root: string, scope: string): SessionUsage[] {
  const file = sessionUsageFile(root, scope);
  if (![paths(root).runtime, path.dirname(file)].every((d) => realDirOrMissing(d))) return [];
  let fd: number | undefined;
  try {
    fd = openRead(file);
    if (fs.fstatSync(fd).size > MAX_BYTES) return [];
    const out: SessionUsage[] = [];
    for (const line of fs.readFileSync(fd, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj(raw) || raw.v !== SESSION_USAGE_VERSION || raw.scope !== scope) continue;
      const u = sessionUsageOf(raw);
      if (u) out.push(u);
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** One record priced with today's table (and config's usage.pricing): an unpriced model's tokens count at $0. */
export function priceSessionUsage(u: SessionUsage, pricingOverrides?: Record<string, any>): { tokens: number; usd: number } {
  return { tokens: u.totalTokens, usd: estimateCost(u, pricingOverrides).usd };
}

export const emptyLane = (): LaneSpend => ({ tokens: 0, estCostUsd: 0, turns: 0 });

/** Adds one priced record to a lane: one daemon turn. */
export function addToLane(lane: LaneSpend, priced: { tokens: number; usd: number }): void {
  lane.tokens += priced.tokens;
  lane.estCostUsd += priced.usd;
  lane.turns += 1;
}

const roundLane = (l: LaneSpend): LaneSpend => ({ tokens: l.tokens, estCostUsd: round4(l.estCostUsd), turns: l.turns });

/** A lane of these records (on or after `sinceMs` when given), priced. */
export function laneOf(records: readonly SessionUsage[], pricingOverrides: Record<string, any> | undefined, sinceMs: number | null): LaneSpend {
  const lane = emptyLane();
  for (const r of records) if (sinceMs === null || Date.parse(r.ts) >= sinceMs) addToLane(lane, priceSessionUsage(r, pricingOverrides));
  return roundLane(lane);
}

/** Stats.cost.orchestrator from its lanes and coverage: each lane's usd rounded to 4 decimals, and the totals their sum. */
export function orchestratorSpend(byLane: OrchestratorSpend['byLane'], coverage: OrchestratorSpend['coverage']): OrchestratorSpend {
  const lanes = { job: roundLane(byLane.job), inbox: roundLane(byLane.inbox), office: roundLane(byLane.office) };
  const all = [lanes.job, lanes.inbox, lanes.office];
  return {
    tokens: all.reduce((n, l) => n + l.tokens, 0),
    estCostUsd: round4(all.reduce((n, l) => n + l.estCostUsd, 0)),
    turns: all.reduce((n, l) => n + l.turns, 0),
    byLane: lanes,
    coverage: { ...coverage, agentUsd: round4(coverage.agentUsd) },
  };
}
