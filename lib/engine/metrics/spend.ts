// The repo spend ledger, one ledger from two sources: every job's agent-end usage (reported), re-priced with
// today's table, and every daemon session's supervisor-metered spend (lib/engine/metrics/meter.ts), each bucketed by
// UTC day, role and model, across live jobs, archive records and the inbox and office sessions. A job's metered
// cell is the remainder past the agent ends its own session's meter already holds, so nothing counts twice. The
// repo budget (lib/engine/metrics/repo-budget.ts) and `forge stats --csv` read it. `.forge/runtime/spend.json`
// caches each entry's buckets keyed by its events and meter files' size and mtime, so a check re-parses only the
// entries that changed. It is not in lib/integrations/claude/pricing.ts because jobs.ts imports pricing.ts, and the
// ledger needs jobs.ts and the archive.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { archiveDir, hasLiveJob, readArchived } from '#core/job/archive.ts';
import { listJobs, parseEventLines } from '#core/job/store.ts';
import { ASSISTANT_SCOPE_PREFIX, INBOX_SCOPE, OFFICE_SCOPE, chatIdOf, isAssistantScope, isChatScope, validScope } from '#core/job/requests.ts';
import { paths, stateFile } from '#core/paths.ts';
import { estimateCost, pricing, resolveModel } from '#integrations/claude/pricing.ts';
import type { Config, Job, JobEvent, UsageRow } from '#core/types.ts';
import { meterFile, readMeter } from './meter.ts';
import type { MeterRecord } from './meter.ts';
import type { SpendBucket } from './types.ts';
import { writeJsonAtomic } from '#core/os/fs.ts';

export const SPEND_CACHE_VERSION = 2;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
/** A cache or events file larger than this is not one Forge wrote at a sane size; it is not read. */
const MAX_BYTES = 256 * 1024 * 1024;

/**
 * One job's (or daemon session's) ledger entry. Bucket keys are `<YYYY-MM-DD>|<role>|<model>`: `buckets` holds the
 * reported agent-end usage, `metered` the supervisor's (role orchestrator, inbox or office). A `session` entry is the
 * inbox, the office, or the meter of a job with no live job and no archive record.
 */
export interface SpendJob {
  source: 'live' | 'archive' | 'session';
  size: number;
  mtimeMs: number;
  meterSize: number;
  meterMtimeMs: number;
  kind: string | null;
  title: string;
  buckets: Record<string, SpendBucket>;
  metered: Record<string, SpendBucket>;
}

export interface SpendCache {
  version: number;
  pricing: string;
  jobs: Record<string, SpendJob>;
}

/** How many events files and archive records the ledger parsed: tests assert cache reuse with it. */
export const spendCounters = { parsed: 0 };

export const spendFile = (root: string): string => path.join(paths(root).runtime, 'spend.json');

const emptyBucket = (): SpendBucket => ({ runs: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 });
const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
// Role and model become part of a bucket key and a CSV cell: one short line, no key separator.
const keyPart = (v: unknown, fallback: string): string => {
  const s = typeof v === 'string' ? v.replace(/[|\r\n\t]/g, '_').slice(0, 100) : '';
  return s || fallback;
};

/** The pricing table's hash: a price change invalidates every cached cost. */
function pricingHash(config: Config): string {
  return crypto.createHash('sha256').update(JSON.stringify(pricing(config?.usage?.pricing ?? {}))).digest('hex');
}

/** UTC `YYYY-MM-DD` of a timestamp, or null when it doesn't parse. */
function utcDay(ts: unknown): string | null {
  if (typeof ts !== 'string') return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** An agent-end that carries a usage object: a metered run, what the spend ledger and the reconciler's progress mark count. */
export function hasUsage(e: Pick<JobEvent, 'type'> & { usage?: unknown }): boolean {
  return e.type === 'agent-end' && Boolean(e.usage) && typeof e.usage === 'object';
}

const addTo = (b: SpendBucket, add: Omit<SpendBucket, 'runs' | 'tokens'>, runs: number, tokens: number): void => {
  b.runs += runs;
  b.tokens += tokens;
  b.input += add.input;
  b.output += add.output;
  b.cacheRead += add.cacheRead;
  b.cacheWrite += add.cacheWrite;
  b.usd = round4(b.usd + add.usd);
};

/**
 * Buckets of one job's events: each agent-end with usage, on the UTC day of its `ts` (at or after `sinceMs`). And the
 * covered cells (`<day>|<model>`): the same usage of the agent ends marked `metered`, which ended inside the job's own
 * daemon session, so its meter already holds their cost.
 */
function bucketsOf(events: JobEvent[], config: Config, sinceMs: number | null = null): { buckets: Record<string, SpendBucket>; covered: Record<string, SpendBucket> } {
  const out: Record<string, SpendBucket> = {};
  const covered: Record<string, SpendBucket> = {};
  for (const e of events) {
    if (!hasUsage(e)) continue;
    const day = utcDay(e.ts);
    if (!day) continue;
    if (sinceMs !== null && Date.parse(e.ts) < sinceMs) continue;
    const u = e.usage as Record<string, unknown>;
    const input = count(u.input);
    const output = count(u.output);
    const cacheRead = count(u.cacheRead);
    const cacheWrite = count(u.cacheWrite);
    const total = count(u.totalTokens) || input + output + cacheRead + cacheWrite;
    const model = typeof e.model === 'string' ? e.model : null;
    const cost = estimateCost({ input, output, cacheRead, cacheWrite, totalTokens: total, model }, config?.usage?.pricing);
    // As addUsage keys byRole: the base role, except that a reviewer keeps its lens.
    const role = typeof e.role === 'string' ? e.role : '';
    const base = role.split(':')[0];
    const modelKey = keyPart(cost.model ?? model, 'unknown');
    const key = `${day}|${keyPart(base === 'reviewer' ? role : base, 'unknown')}|${modelKey}`;
    const add = { input, output, cacheRead, cacheWrite, usd: cost.usd };
    addTo((out[key] ??= emptyBucket()), add, 1, total);
    if (e.metered === true) addTo((covered[`${day}|${modelKey}`] ??= emptyBucket()), add, 1, total);
  }
  return { buckets: out, covered };
}

/** The ledger role a meter scope's spend is: the inbox, the office, an assistant foreman, a chat, or a job's orchestrator (with every agent it ran). */
const meterRole = (scope: string): string =>
  scope === INBOX_SCOPE ? 'inbox' : scope === OFFICE_SCOPE ? 'office' : isAssistantScope(scope) ? 'assistant' : isChatScope(scope) ? 'chat' : 'orchestrator';

/** A shared session's ledger title, or null for a job's meter. */
function sessionTitle(scope: string): string | null {
  if (scope === INBOX_SCOPE) return 'Inbox session';
  if (scope === OFFICE_SCOPE) return 'Office session';
  const chat = chatIdOf(scope);
  if (chat !== null) return `Chat ${chat}`;
  return isAssistantScope(scope) ? `Assistant foreman ${scope.slice(ASSISTANT_SCOPE_PREFIX.length)}` : null;
}

/**
 * A scope's metered buckets: each record's models in `<day>|<model>` cells (the model resolved as pricing does; a
 * record's usd beyond its models' goes to `unknown`), `runs` counting records per cell. claude priced them, so they
 * are never re-priced. The covered cells are subtracted, each field clamped at 0: what is left is what the session
 * spent beyond the agents it reported.
 */
function meteredBuckets(records: readonly MeterRecord[], covered: Record<string, SpendBucket>, role: string, config: Config, sinceMs: number | null): Record<string, SpendBucket> {
  const table = pricing(config?.usage?.pricing ?? {});
  const cells: Record<string, SpendBucket> = {};
  for (const rec of records) {
    const day = utcDay(rec.ts);
    if (!day || (sinceMs !== null && Date.parse(rec.ts) < sinceMs)) continue;
    const touched = new Set<string>();
    let modelsUsd = 0;
    for (const [name, m] of Object.entries(rec.models)) {
      const cell = `${day}|${resolveModel(name, table) ?? keyPart(name, 'unknown')}`;
      addTo((cells[cell] ??= emptyBucket()), m, 0, 0);
      touched.add(cell);
      modelsUsd += m.usd;
    }
    if (rec.usd - modelsUsd > 1e-6) {
      const cell = `${day}|unknown`;
      addTo((cells[cell] ??= emptyBucket()), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: rec.usd - modelsUsd }, 0, 0);
      touched.add(cell);
    }
    for (const cell of touched) cells[cell].runs += 1;
  }
  const out: Record<string, SpendBucket> = {};
  for (const [cell, b] of Object.entries(cells)) {
    const c = Object.hasOwn(covered, cell) ? covered[cell] : null;
    const left = (f: 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'usd') => Math.max(0, b[f] - (c ? c[f] : 0));
    const r: SpendBucket = { runs: b.runs, tokens: 0, input: left('input'), output: left('output'), cacheRead: left('cacheRead'), cacheWrite: left('cacheWrite'), usd: round4(left('usd')) };
    r.tokens = r.input + r.output + r.cacheRead + r.cacheWrite;
    const [day, model] = cell.split('|');
    out[`${day}|${role}|${model}`] = r;
  }
  return out;
}

/** A meter file's fingerprint (size and mtime), zeros when it is missing or not a regular file. */
function meterPrint(root: string, scope: string): { meterSize: number; meterMtimeMs: number } {
  try {
    const st = fs.lstatSync(meterFile(root, scope));
    if (st.isFile()) return { meterSize: st.size, meterMtimeMs: st.mtimeMs };
  } catch {}
  return { meterSize: 0, meterMtimeMs: 0 };
}

/** A scope's metered buckets, or none for a scope that can't name a meter file. */
function meteredOf(root: string, scope: string, covered: Record<string, SpendBucket>, config: Config, sinceMs: number | null): Record<string, SpendBucket> {
  return validScope(scope) ? meteredBuckets(readMeter(root, scope), covered, meterRole(scope), config, sinceMs) : {};
}

/** Reads a regular file through one descriptor that follows no link and never blocks on a FIFO. */
function readNoFollow(file: string): { text: string; size: number; mtimeMs: number } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return { text: fs.readFileSync(fd, 'utf8'), size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The cache, or null when it is missing, a link, unparsable, or written for another version or price table. */
function readSpendCache(root: string, hash: string): SpendCache | null {
  const r = readNoFollow(spendFile(root));
  if (!r) return null;
  let raw: any;
  try {
    raw = JSON.parse(r.text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || raw.version !== SPEND_CACHE_VERSION || raw.pricing !== hash) return null;
  if (!raw.jobs || typeof raw.jobs !== 'object' || Array.isArray(raw.jobs)) return null;
  return raw as SpendCache;
}

const sameFile = (e: SpendJob | undefined, source: SpendJob['source'], size: number, mtimeMs: number, meter: { meterSize: number; meterMtimeMs: number }): e is SpendJob =>
  Boolean(
    e &&
      e.source === source &&
      e.size === size &&
      e.mtimeMs === mtimeMs &&
      e.meterSize === meter.meterSize &&
      e.meterMtimeMs === meter.meterMtimeMs &&
      e.buckets &&
      typeof e.buckets === 'object' &&
      e.metered &&
      typeof e.metered === 'object',
  );

/**
 * Every job's spend, from the cache where a job's file is unchanged. With `write` (the default) an
 * updated cache is saved; the server and the daemon pool pass false and never write it. `since` (an
 * ISO time, for the CSV export) keeps only events at or after it, and so neither reads nor writes the cache.
 */
export function spendLedger(root: string, config: Config, { write = true, since = null }: { write?: boolean; since?: string | null } = {}): Record<string, SpendJob> {
  const sinceMs = since ? Date.parse(since) : null;
  if (sinceMs !== null) write = false;
  const hash = pricingHash(config);
  const cache = sinceMs === null ? readSpendCache(root, hash) : null;
  const old = cache?.jobs ?? {};
  const jobs: Record<string, SpendJob> = {};
  let changed = !cache;
  const live = new Set<string>();
  for (const job of listJobs(root)) {
    live.add(job.id);
    // The CLI copy when the job has one: the job folder's events.jsonl is a mirror a session could append to.
    const file = stateFile(root, job.id, 'events.jsonl');
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(file);
    } catch {}
    const size = st?.isFile() ? st.size : 0;
    const mtimeMs = st?.isFile() ? st.mtimeMs : 0;
    // Taken before the meter is read, so a record appended in between is seen next time.
    const print = meterPrint(root, job.id);
    const prev = Object.hasOwn(old, job.id) ? old[job.id] : undefined;
    if (sameFile(prev, 'live', size, mtimeMs, print)) {
      jobs[job.id] = { ...prev, kind: job.kind ?? null, title: job.title ?? '' };
      if (prev.kind !== (job.kind ?? null) || prev.title !== (job.title ?? '')) changed = true;
      continue;
    }
    // The fingerprint comes from the descriptor read, so an append between stat and read is seen next time.
    const r = st?.isFile() ? readNoFollow(file) : null;
    spendCounters.parsed++;
    const { buckets, covered } = r ? bucketsOf(parseEventLines(r.text), config, sinceMs) : { buckets: {}, covered: {} };
    jobs[job.id] = {
      source: 'live',
      size: r?.size ?? 0,
      mtimeMs: r?.mtimeMs ?? 0,
      ...print,
      kind: job.kind ?? null,
      title: job.title ?? '',
      buckets,
      metered: meteredOf(root, job.id, covered, config, sinceMs),
    };
    changed = true;
  }
  const dir = archiveDir(root);
  let names: fs.Dirent[] = [];
  try {
    if (fs.lstatSync(dir).isDirectory()) names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {}
  for (const e of names) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const id = e.name.slice(0, -5);
    if (live.has(id) || Object.hasOwn(jobs, id) || hasLiveJob(root, id)) continue;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(path.join(dir, e.name));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const print = meterPrint(root, id);
    const prev = Object.hasOwn(old, id) ? old[id] : undefined;
    if (sameFile(prev, 'archive', st.size, st.mtimeMs, print)) {
      jobs[id] = prev;
      continue;
    }
    const rec = readArchived(root, id);
    spendCounters.parsed++;
    changed = true;
    if (!rec) continue;
    const { buckets, covered } = bucketsOf(rec.events, config, sinceMs);
    const summaryUsd = count(rec.summary?.usage?.estCostUsd);
    // A record whose events lost their usage still carries the job's total; it counts on its finish day.
    const usageless = !rec.events.some(hasUsage);
    const finished = utcDay(rec.job.finishedAt) ? rec.job.finishedAt! : rec.archivedAt;
    if (usageless && summaryUsd > 0 && (sinceMs === null || Date.parse(finished) >= sinceMs)) {
      const day = utcDay(finished);
      if (day) buckets[`${day}|unknown|unknown`] = { ...emptyBucket(), tokens: count(rec.summary?.usage?.totalTokens), usd: round4(summaryUsd) };
    }
    jobs[id] = { source: 'archive', size: st.size, mtimeMs: st.mtimeMs, ...print, kind: rec.job.kind ?? null, title: rec.job.title ?? '', buckets, metered: meteredOf(root, id, covered, config, sinceMs) };
  }
  // The inbox, the office, and the meter of a job that is neither live nor archived (deleted): meter files are never deleted.
  const meterDir = path.join(paths(root).runtime, 'meter');
  let meters: fs.Dirent[] = [];
  try {
    if (fs.lstatSync(meterDir).isDirectory()) meters = fs.readdirSync(meterDir, { withFileTypes: true });
  } catch {}
  for (const e of meters) {
    const scope = e.name.slice(0, -'.jsonl'.length);
    if (!e.isFile() || !e.name.endsWith('.jsonl') || !validScope(scope) || Object.hasOwn(jobs, scope)) continue;
    const print = meterPrint(root, scope);
    const prev = Object.hasOwn(old, scope) ? old[scope] : undefined;
    if (sameFile(prev, 'session', 0, 0, print)) {
      jobs[scope] = prev;
      continue;
    }
    spendCounters.parsed++;
    changed = true;
    const shared = sessionTitle(scope);
    jobs[scope] = { source: 'session', size: 0, mtimeMs: 0, ...print, kind: shared ? 'session' : null, title: shared ?? '', buckets: {}, metered: meteredOf(root, scope, {}, config, sinceMs) };
  }
  if (Object.keys(old).some((id) => !Object.hasOwn(jobs, id))) changed = true;
  if (write && changed) {
    try {
      writeJsonAtomic(spendFile(root), { version: SPEND_CACHE_VERSION, pricing: hash, jobs } satisfies SpendCache);
    } catch {
      // A read-only or full disk costs the next check a re-parse, never the check itself.
    }
  }
  return jobs;
}

/** Spend in the UTC day and month of `at`. */
export function periodTotals(ledger: Record<string, SpendJob>, at: number = Date.now()): { dayUsd: number; monthUsd: number; monthTokens: number } {
  const day = new Date(at).toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  let dayUsd = 0;
  let monthUsd = 0;
  let monthTokens = 0;
  for (const j of Object.values(ledger)) {
    for (const [key, b] of [...Object.entries(j.buckets), ...Object.entries(j.metered ?? {})]) {
      if (!key.startsWith(month)) continue;
      monthUsd += count(b.usd);
      monthTokens += count(b.tokens);
      if (key.startsWith(day + '|')) dayUsd += count(b.usd);
    }
  }
  return { dayUsd: round4(dayUsd), monthUsd: round4(monthUsd), monthTokens };
}

export type LedgerBy = 'job' | 'role' | 'model' | 'day';
export const LEDGER_BY: readonly LedgerBy[] = ['job', 'role', 'model', 'day'];

/** One CSV row: its key cells and totals. */
export interface LedgerRow {
  key: string[];
  totals: SpendBucket;
}

/**
 * The ledger summed by job, role, model or day, and by source (`reported` agent ends, `supervisor` meter), sorted by
 * key. Filter by time when building the ledger (`since`).
 */
export function ledgerRows(ledger: Record<string, SpendJob>, { by }: { by: LedgerBy }): LedgerRow[] {
  const rows = new Map<string, LedgerRow>();
  for (const [id, j] of Object.entries(ledger)) {
    const sources: [string, Record<string, SpendBucket>][] = [
      ['reported', j.buckets],
      ['supervisor', j.metered ?? {}],
    ];
    for (const [source, bucketKey, b] of sources.flatMap(([s, buckets]) => Object.entries(buckets).map(([k, v]) => [s, k, v] as const))) {
      const [day, role, model] = bucketKey.split('|');
      const key = [...(by === 'job' ? [id, j.kind ?? '', j.title] : [by === 'role' ? role : by === 'model' ? model : day]), source];
      const k = JSON.stringify(key);
      const row = rows.get(k) ?? { key, totals: emptyBucket() };
      for (const f of ['runs', 'tokens', 'input', 'output', 'cacheRead', 'cacheWrite'] as const) row.totals[f] += count(b[f]);
      row.totals.usd = round4(row.totals.usd + count(b.usd));
      rows.set(k, row);
    }
  }
  return [...rows.values()].sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) {
      const c = a.key[i] < b.key[i] ? -1 : a.key[i] > b.key[i] ? 1 : 0;
      if (c) return c;
    }
    return 0;
  });
}

/** The roles meterRole gives: the only keys sessionRows writes. */
const SESSION_ROLES: ReadonlySet<string> = new Set(['orchestrator', 'inbox', 'office', 'assistant', 'chat']);

/** The supervisor's buckets summed by role (orchestrator, inbox, office, assistant): Stats.cost.sessions. `runs` counts metered turns. */
export function sessionRows(ledger: Record<string, SpendJob>): Record<string, UsageRow> {
  const out: Record<string, UsageRow> = {};
  for (const j of Object.values(ledger)) {
    for (const [key, b] of Object.entries(j.metered ?? {})) {
      // A cached key comes from spend.json: any other role (`<day>|__proto__|m`) is skipped, never used as a key.
      const role = key.split('|')[1];
      if (!SESSION_ROLES.has(role)) continue;
      const r = (out[role] ??= { tokens: 0, estCostUsd: 0, runs: 0 });
      r.tokens += count(b.tokens);
      r.estCostUsd = round4(r.estCostUsd + count(b.usd));
      r.runs += count(b.runs);
    }
  }
  return out;
}

/** A job's spend from both sources: what its agents reported, the part of that its own session's meter holds, and the meter's total. */
export interface JobSpend {
  reported: { usd: number; tokens: number };
  covered: { usd: number; tokens: number };
  metered: { usd: number; tokens: number; turns: number } | null;
}

/**
 * Covered usage per CLI-copy events file, kept while its size and mtime hold. A file that is gone drops its
 * entry, and past COVERED_MAX the oldest goes, so a long `forge dash` never holds every job it has seen.
 */
const coveredMemo = new Map<string, { size: number; mtimeMs: number; pricing: string; covered: { usd: number; tokens: number } }>();
const COVERED_MAX = 256;

/** The usage of a job's `metered` agent ends, priced as the ledger does, from its CLI copy of events.jsonl (never the job folder's mirror). */
function coveredOf(root: string, config: Config, id: string): { usd: number; tokens: number } {
  const file = stateFile(root, id, 'events.jsonl');
  const hash = pricingHash(config);
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(file);
  } catch {}
  const hit = coveredMemo.get(file);
  if (st?.isFile() && hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.pricing === hash) return hit.covered;
  coveredMemo.delete(file);
  const r = st?.isFile() ? readNoFollow(file) : null;
  const cells = r ? bucketsOf(parseEventLines(r.text), config).covered : {};
  const covered = Object.values(cells).reduce((n, b) => ({ usd: round4(n.usd + b.usd), tokens: n.tokens + b.tokens }), { usd: 0, tokens: 0 });
  if (r) {
    coveredMemo.set(file, { size: r.size, mtimeMs: r.mtimeMs, pricing: hash, covered });
    if (coveredMemo.size > COVERED_MAX) coveredMemo.delete(coveredMemo.keys().next().value!);
  }
  return covered;
}

/** What a job has spent from each source: the reported totals (job.usage), the covered part, and the meter's sum (null without records). */
export function jobSpend(root: string, config: Config, job: Pick<Job, 'id' | 'usage'>): JobSpend {
  const reported = { usd: count(job.usage?.estCostUsd), tokens: count(job.usage?.totalTokens) };
  const records = validScope(job.id) ? readMeter(root, job.id) : [];
  const metered = records.length
    ? records.reduce((n, r) => ({ usd: round4(n.usd + r.usd), tokens: n.tokens + r.tokens, turns: n.turns + 1 }), { usd: 0, tokens: 0, turns: 0 })
    : null;
  return { reported, covered: metered ? coveredOf(root, config, job.id) : { usd: 0, tokens: 0 }, metered };
}

/**
 * The spent figure every budget check enforces. With no meter records, the reported totals. With them, the meter plus
 * whatever was reported beyond what it covers, and never less than the reported total: an under-report, or an edited
 * events.jsonl claiming covered runs, can't lower it below either the meter or the report.
 */
export function spentFrom(s: JobSpend): { usd: number; tokens: number } {
  if (!s.metered) return { usd: s.reported.usd, tokens: s.reported.tokens };
  const rule = (k: 'usd' | 'tokens') => Math.max(s.reported[k], s.metered![k] + s.reported[k] - Math.min(s.covered[k], s.reported[k]));
  return { usd: round4(rule('usd')), tokens: rule('tokens') };
}
