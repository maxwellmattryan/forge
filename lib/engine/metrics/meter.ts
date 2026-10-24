// The supervisor's meter: what each daemon session spent, per turn, from claude's own cost report on its
// result line. `.forge/runtime/meter/<scope>.jsonl` holds one record per costed turn. The supervisor in
// `forge dash` is its only writer (lib/office/session/meter.ts), and no CLI command writes it, so no session
// can append to it. claude's figures are cumulative per conversation and carry over a --resume, so each record
// is the delta against a baseline held per spawn (meterDelta). The spend ledger, budget enforcement and the
// reconciler read it. docs/architecture/policies.md "Usage accounting".
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '#core/paths.ts';
import { openAppend, openRead } from '#core/job/session-files.ts';
import { validScope } from '#core/job/requests.ts';
import { ForgeError } from '#core/errors.ts';
import type { ModelCost, SessionCost } from '#integrations/claude/types.ts';

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
  if (!validScope(scope)) throw new ForgeError(`invalid meter scope ${JSON.stringify(String(scope).slice(0, 80))}`, 'usage');
  return path.join(paths(root).runtime, 'meter', `${scope}.jsonl`);
}

/** Whether `dir` is missing or a real directory: a planted link or file in its place refuses the meter. */
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

/** Parsed files by path, kept while their size and mtime hold, so repeated checks don't re-parse. */
const memo = new Map<string, { size: number; mtimeMs: number; records: MeterRecord[] }>();

/**
 * A scope's records, oldest first, read through one descriptor that follows no link and never blocks.
 * Tolerant: a line that breaks the record rules is dropped, and a missing, linked, non-regular or
 * oversized file reads as [].
 */
export function readMeter(root: string, scope: string): MeterRecord[] {
  const file = meterFile(root, scope);
  if (!realDirOrMissing(paths(root).runtime) || !realDirOrMissing(path.dirname(file))) return [];
  let fd: number | undefined;
  try {
    fd = openRead(file);
    const st = fs.fstatSync(fd);
    if (st.size > MAX_BYTES) return [];
    const hit = memo.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.records;
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
    memo.set(file, { size: st.size, mtimeMs: st.mtimeMs, records });
    return records;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
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
