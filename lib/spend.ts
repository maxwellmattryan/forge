// The repo spend ledger: every job's agent-end usage, re-priced with today's table and bucketed by
// UTC day, role and model, across live jobs and archive records. The repo budget (lib/repo-budget.ts)
// and `forge stats --csv` read it. `.forge/runtime/spend.json` caches each job's buckets keyed by
// its events file's size and mtime, so a check re-parses only the jobs that changed. It is not in
// lib/pricing.ts because jobs.ts imports pricing.ts, and the ledger needs jobs.ts and the archive.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { archiveDir, hasLiveJob, readArchived } from './archive.ts';
import { jobDir, listJobs, parseEventLines } from './jobs.ts';
import { paths } from './paths.ts';
import { estimateCost, pricing } from './pricing.ts';
import type { Config, JobEvent, SpendBucket } from './types.ts';
import { writeJsonAtomic } from './util.ts';

export const SPEND_CACHE_VERSION = 1;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
/** A cache or events file larger than this is not one Forge wrote at a sane size; it is not read. */
const MAX_BYTES = 256 * 1024 * 1024;

/** One job's ledger entry. Bucket keys are `<YYYY-MM-DD>|<role>|<model>`. */
export interface SpendJob {
  source: 'live' | 'archive';
  size: number;
  mtimeMs: number;
  kind: string | null;
  title: string;
  buckets: Record<string, SpendBucket>;
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

/** Buckets of one job's events: each agent-end with usage, on the UTC day of its `ts` (at or after `sinceMs`). */
function bucketsOf(events: JobEvent[], config: Config, sinceMs: number | null = null): Record<string, SpendBucket> {
  const out: Record<string, SpendBucket> = {};
  for (const e of events) {
    if (e.type !== 'agent-end' || !e.usage || typeof e.usage !== 'object') continue;
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
    const key = `${day}|${keyPart(base === 'reviewer' ? role : base, 'unknown')}|${keyPart(cost.model ?? model, 'unknown')}`;
    const b = (out[key] ??= emptyBucket());
    b.runs += 1;
    b.tokens += total;
    b.input += input;
    b.output += output;
    b.cacheRead += cacheRead;
    b.cacheWrite += cacheWrite;
    b.usd = round4(b.usd + cost.usd);
  }
  return out;
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

const sameFile = (e: SpendJob | undefined, source: SpendJob['source'], size: number, mtimeMs: number): e is SpendJob =>
  Boolean(e && e.source === source && e.size === size && e.mtimeMs === mtimeMs && e.buckets && typeof e.buckets === 'object');

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
    const file = path.join(jobDir(root, job.id), 'events.jsonl');
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(file);
    } catch {}
    const size = st?.isFile() ? st.size : 0;
    const mtimeMs = st?.isFile() ? st.mtimeMs : 0;
    const prev = Object.hasOwn(old, job.id) ? old[job.id] : undefined;
    if (sameFile(prev, 'live', size, mtimeMs)) {
      jobs[job.id] = { ...prev, kind: job.kind ?? null, title: job.title ?? '' };
      if (prev.kind !== (job.kind ?? null) || prev.title !== (job.title ?? '')) changed = true;
      continue;
    }
    // The fingerprint comes from the descriptor read, so an append between stat and read is seen next time.
    const r = st?.isFile() ? readNoFollow(file) : null;
    spendCounters.parsed++;
    jobs[job.id] = {
      source: 'live',
      size: r?.size ?? 0,
      mtimeMs: r?.mtimeMs ?? 0,
      kind: job.kind ?? null,
      title: job.title ?? '',
      buckets: r ? bucketsOf(parseEventLines(r.text), config, sinceMs) : {},
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
    const prev = Object.hasOwn(old, id) ? old[id] : undefined;
    if (sameFile(prev, 'archive', st.size, st.mtimeMs)) {
      jobs[id] = prev;
      continue;
    }
    const rec = readArchived(root, id);
    spendCounters.parsed++;
    changed = true;
    if (!rec) continue;
    const buckets = bucketsOf(rec.events, config, sinceMs);
    const summaryUsd = count(rec.summary?.usage?.estCostUsd);
    // A record whose events lost their usage still carries the job's total; it counts on its finish day.
    const usageless = !rec.events.some((x) => x.type === 'agent-end' && x.usage && typeof x.usage === 'object');
    const finished = utcDay(rec.job.finishedAt) ? rec.job.finishedAt! : rec.archivedAt;
    if (usageless && summaryUsd > 0 && (sinceMs === null || Date.parse(finished) >= sinceMs)) {
      const day = utcDay(finished);
      if (day) buckets[`${day}|unknown|unknown`] = { ...emptyBucket(), tokens: count(rec.summary?.usage?.totalTokens), usd: round4(summaryUsd) };
    }
    jobs[id] = { source: 'archive', size: st.size, mtimeMs: st.mtimeMs, kind: rec.job.kind ?? null, title: rec.job.title ?? '', buckets };
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
    for (const [key, b] of Object.entries(j.buckets)) {
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

/** The ledger summed by job, role, model or day, sorted by key. Filter by time when building the ledger (`since`). */
export function ledgerRows(ledger: Record<string, SpendJob>, { by }: { by: LedgerBy }): LedgerRow[] {
  const rows = new Map<string, LedgerRow>();
  for (const [id, j] of Object.entries(ledger)) {
    for (const [bucketKey, b] of Object.entries(j.buckets)) {
      const [day, role, model] = bucketKey.split('|');
      const key = by === 'job' ? [id, j.kind ?? '', j.title] : [by === 'role' ? role : by === 'model' ? model : day];
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
