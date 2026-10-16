// Readiness triage: `forge tracker triage` scores ready tracker items before work starts, in two
// CLI calls with the `forge:triage` agent between them (the CLI never calls a model). Prepare writes a
// batch of fenced item text for the agent; apply validates the agent's verdicts and writes only
// templated text to the tracker. The cache (runtime/triage.json, unversioned) keeps each item's
// content hash, so an unchanged item is never judged, commented on or marked twice.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REF, scoreItems, searchTerms } from './issue-link.ts';
import { isActive, listJobs } from './jobs.ts';
import { paths } from './paths.ts';
import { repoSlug } from './pr.ts';
import { roster } from './roster.ts';
import { UNTRUSTED_LINE, fenced, oneLine } from './tracker-link.ts';
import { ForgeError, now, run, withLock, writeJsonAtomic, writeTextAtomic } from './util.ts';
import type { Config, Effort, Tracker, TrackerCtx, TrackerItem, TriageMissing } from './types.ts';

export const TRIAGE_MISSING = ['outcome', 'acceptance', 'scope', 'duplicate'] as const satisfies readonly TriageMissing[];
export const BATCH_RE = /^\d{8}T\d{6}Z-[a-z0-9]{4}$/;
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;
const KEEP_BATCHES = 5;
const MAX_CACHE = 500;
const MAX_VERDICTS = 256 * 1024;
const MAX_ITEMS_FILE = 256 * 1024;
const MAX_BODY = 8000;
const MAX_TITLE = 200;
const MAX_CANDIDATES = 3;
/** Two title terms in common (2 points each): a weaker match is noise, not a duplicate. */
const MIN_DUP_SCORE = 4;

const HASH_RE = /^[0-9a-f]{16}$/;
const CANDIDATE_ID = /^(?:job:[A-Za-z0-9][A-Za-z0-9._-]{0,199}|pr:\d{1,9})$/;
const LOCAL_JOB_LABEL = /^job [A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** One cached verdict, keyed `<tracker>:<ref>`. `noted` is the missing set the last comment covered. */
export interface TriageCacheEntry {
  hash: string;
  ready: boolean;
  missing: TriageMissing[];
  duplicateOf: string | null;
  noted: TriageMissing[] | null;
  at: string;
}

interface Candidate {
  id: string;
  label: string;
}

interface BatchItem {
  ref: string;
  hash: string;
  needsInfo: boolean;
  candidates: string[];
}

export type PrepareResult =
  | { batch: null; pending: 0; items: []; skipped: number }
  | {
      batch: string;
      pending: number;
      items: { ref: string; title: string }[];
      skipped: number;
      prs: 'ok' | 'unavailable' | 'off';
      subagent: 'forge:triage';
      model: string;
      effort: Effort | null;
      brief: string;
    };

export type ApplyItemResult =
  | { ref: string; ready: false; missing: TriageMissing[]; commented: boolean; marked: boolean }
  | { ref: string; ready: true; missing: []; cleared: boolean }
  | { ref: string; skipped: 'stale' | 'claimed' | 'no verdict' }
  | { ref: string; error: string };

const triageDir = (root: string): string => path.join(paths(root).runtime, 'triage');
const cacheFile = (root: string): string => path.join(paths(root).runtime, 'triage.json');
const lockDir = (root: string): string => path.join(paths(root).locks, 'triage');
const cacheKey = (tracker: Tracker, ref: string): string => `${tracker.name}:${ref}`;

/** What an item's text is judged on: its title and body, as get() returns them. */
export function itemHash(item: Pick<TrackerItem, 'title' | 'body'>): string {
  return crypto.createHash('sha256').update(`${item.title ?? ''}\0${item.body ?? ''}`).digest('hex').slice(0, 16);
}

/** Known keys only, once each, in TRIAGE_MISSING order. */
function missingSet(raw: unknown): TriageMissing[] {
  const got = new Set(Array.isArray(raw) ? raw : []);
  return TRIAGE_MISSING.filter((k) => got.has(k));
}

/** The triage cache, malformed entries dropped. */
export function readTriageCache(root: string): Record<string, TriageCacheEntry> {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(cacheFile(root), 'utf8'));
  } catch {
    return {};
  }
  // runtime/triage.json is agent-writable: a `__proto__` key must stay an ordinary entry.
  const out: Record<string, TriageCacheEntry> = Object.create(null);
  const items = raw && typeof raw === 'object' && raw.items && typeof raw.items === 'object' ? raw.items : {};
  for (const [key, e] of Object.entries<any>(items)) {
    if (!e || typeof e !== 'object' || typeof e.hash !== 'string' || !HASH_RE.test(e.hash) || typeof e.ready !== 'boolean' || typeof e.at !== 'string') continue;
    out[key] = {
      hash: e.hash,
      ready: e.ready,
      missing: missingSet(e.missing),
      duplicateOf: typeof e.duplicateOf === 'string' ? e.duplicateOf : null,
      noted: Array.isArray(e.noted) ? missingSet(e.noted) : null,
      at: e.at,
    };
  }
  return out;
}

function writeCache(root: string, items: Record<string, TriageCacheEntry>): void {
  const kept = Object.entries(items)
    .sort((a, b) => b[1].at.localeCompare(a[1].at))
    .slice(0, MAX_CACHE);
  writeJsonAtomic(cacheFile(root), { items: Object.fromEntries(kept) });
}

/** The comment a not-ready item gets: fixed text, one bullet per missing key. */
export function commentBody(missing: readonly TriageMissing[], dupLabel: string | null, prefix: string): string {
  const lines: Record<TriageMissing, string> = {
    outcome: '- **Outcome**: what should be true when this is done.',
    acceptance: '- **Acceptance criteria or a reproduction**: how to tell it works; for a bug, the steps to reproduce it and the expected and actual behaviour.',
    scope: '- **A bounded scope**: one reviewable change; split a large or many-part request into separate issues.',
    duplicate: `- **Not a duplicate**: this looks like the same work as ${dupLabel ?? 'an active Forge job'}; close one, or say how they differ.`,
  };
  return [
    'Forge looked at this issue before starting work on it and needs a little more first:',
    '',
    ...missingSet(missing).map((k) => lines[k]),
    '',
    `Please add this to the issue. Until then Forge skips it (label \`${prefix}needs-info\`) and checks again when the issue changes.`,
  ].join('\n');
}

/** The one-line note the local backlog keeps under a needs-info item. */
export function noteLine(missing: readonly TriageMissing[], dupLabel: string | null): string {
  const piece: Record<TriageMissing, string> = {
    outcome: 'a clear outcome',
    acceptance: 'acceptance criteria or a reproduction',
    scope: 'a bounded scope',
    duplicate: `possible duplicate of ${dupLabel ?? 'an active Forge job'}`,
  };
  return missingSet(missing).map((k) => piece[k]).join('; ');
}

/** Whether Forge or someone else has taken the item since it was listed. */
function claimed(root: string, config: Config, tracker: Tracker, item: TrackerItem): boolean {
  if (item.claimedBy) return true;
  if (['in-progress', 'done', 'dropped', 'CLOSED'].includes(String(item.status ?? ''))) return true;
  if (listJobs(root).some((j) => isActive(j) && j.source?.tracker === tracker.name && String(j.source.ref) === item.ref)) return true;
  if (tracker.name === 'github') {
    const prefix = config.tracker.github.labels.prefix;
    return (item.labels ?? []).some((l) => l.startsWith(prefix) && l !== `${prefix}queued` && l !== `${prefix}needs-info`);
  }
  return false;
}

function batchId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const rand = Array.from(crypto.randomBytes(4), (b) => (b % 36).toString(36)).join('');
  return `${stamp}-${rand}`;
}

/** Open PRs as duplicate candidates, fetched once; `off` without PRs, `unavailable` when gh fails. */
function openPrs(root: string, config: Config): { prs: 'ok' | 'unavailable' | 'off'; list: { number: number; title: string }[] } {
  if (!config.pr.enabled) return { prs: 'off', list: [] };
  try {
    const slug = repoSlug(root, config);
    const r = run('gh', ['pr', 'list', '-R', slug, '--state', 'open', '--json', 'number,title,url', '--limit', '100'], { cwd: root, allowFail: true });
    if (!r.ok) return { prs: 'unavailable', list: [] };
    const raw = JSON.parse(r.stdout);
    if (!Array.isArray(raw)) return { prs: 'unavailable', list: [] };
    const list = raw.filter((p: any) => Number.isInteger(p?.number) && p.number > 0 && p.number < 1e9 && typeof p.title === 'string').map((p: any) => ({ number: p.number as number, title: p.title as string }));
    return { prs: 'ok', list };
  } catch {
    return { prs: 'unavailable', list: [] };
  }
}

/** Where a duplicate candidate may be cited on a (possibly public) tracker: never by a local job id there. */
function jobLabel(tracker: Tracker, job: { id: string; source?: { tracker?: string; ref?: unknown } | null }): string {
  const ref = String(job.source?.ref ?? '');
  if (job.source?.tracker === tracker.name && /^\d{1,9}$/.test(ref)) return `#${ref}`;
  if (job.source?.tracker === tracker.name && tracker.name === 'local' && LOCAL_JOB_LABEL.test(`job ${job.id}`)) return `job ${job.id}`;
  return 'an active Forge job';
}

/** Drops all but the newest KEEP_BATCHES batch dirs. Only names BATCH_RE accepts are touched. */
function pruneBatches(root: string): void {
  const dir = triageDir(root);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => BATCH_RE.test(n)).sort().reverse();
  } catch {
    return;
  }
  for (const n of names.slice(KEEP_BATCHES)) {
    const p = path.join(dir, n);
    try {
      if (fs.lstatSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
    } catch {}
  }
}

/** `forge tracker triage [--limit N] [--all]`: the batch the triage agent judges. */
export function prepareTriage(root: string, config: Config, tracker: Tracker, opts: { limit: number; all: boolean }): PrepareResult {
  if (config.tracker.kind === 'none') return { batch: null, pending: 0, items: [], skipped: 0 };
  const ctx: TrackerCtx = { root, config };
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(opts.limit)));
  const listed = new Map<string, TrackerItem>();
  const add = (i: TrackerItem) => {
    const ref = String(i?.ref ?? '');
    if (REF.test(ref) && !listed.has(ref)) listed.set(ref, i);
  };
  tracker.list(ctx, { ready: true, limit }).forEach(add);
  tracker
    .list(ctx, { limit: 100 })
    .filter((i) => i.needsInfo && !i.claimedBy)
    .slice(0, limit)
    .forEach(add);
  const cache = withLock(lockDir(root), () => readTriageCache(root));
  let skipped = 0;
  const pending: { item: TrackerItem; hash: string; needsInfo: boolean }[] = [];
  for (const [ref, listedItem] of listed) {
    const item = tracker.get(ctx, ref);
    if (!item) continue;
    const hash = itemHash(item);
    if (!opts.all && cache[cacheKey(tracker, ref)]?.hash === hash) {
      skipped++;
      continue;
    }
    pending.push({ item: { ...item, ref }, hash, needsInfo: Boolean(item.needsInfo ?? listedItem.needsInfo) });
  }
  if (!pending.length) return { batch: null, pending: 0, items: [], skipped };

  const jobs = listJobs(root).filter((j) => isActive(j) && j.kind !== 'eval' && !j.children?.length);
  const pr = openPrs(root, config);
  const batch = batchId();
  const dir = path.join(triageDir(root), batch);
  fs.mkdirSync(dir, { recursive: true });
  const md: string[] = [UNTRUSTED_LINE, '', `# Triage batch ${batch}`, ''];
  const recorded: (Omit<BatchItem, 'candidates'> & { candidates: Candidate[] })[] = [];
  pending.forEach(({ item, hash, needsInfo }, n) => {
    const terms = searchTerms(item.title);
    const jobHits = scoreItems(
      jobs.filter((j) => !(j.source?.tracker === tracker.name && String(j.source?.ref) === item.ref)).map((j) => ({ ref: `job:${j.id}`, title: j.title, label: jobLabel(tracker, j) })),
      terms,
    );
    const prHits = scoreItems(pr.list.map((p) => ({ ref: `pr:${p.number}`, title: p.title, label: `PR #${p.number}` })), terms);
    const hits = [...jobHits, ...prHits]
      .filter((h) => h.score >= MIN_DUP_SCORE && CANDIDATE_ID.test(h.ref))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CANDIDATES);
    const title = oneLine(item.title, MAX_TITLE);
    const body = String(item.body ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
      .slice(0, MAX_BODY);
    md.push(`## Item ${n + 1}: ref ${item.ref}`, '', fenced(`${title}\n\n${body}`.trim()), '');
    if (hits.length) md.push('Duplicate candidates (id: title):', '', fenced(hits.map((h) => `${h.ref}: ${oneLine(h.title, MAX_TITLE)}`).join('\n')), '');
    else md.push('Duplicate candidates: none.', '');
    // The label is a record for humans: apply derives its own from the id, never from this file.
    const candidates: Candidate[] = hits.map((h) => ({ id: h.ref, label: h.label }));
    recorded.push({ ref: item.ref, hash, needsInfo, candidates });
  });
  const itemsMd = path.join(dir, 'items.md');
  writeTextAtomic(itemsMd, md.join('\n'));
  writeJsonAtomic(path.join(dir, 'items.json'), { batch, tracker: tracker.name, createdAt: now(), items: recorded });
  pruneBatches(root);
  const row = roster(root, config).agents.find((a) => a.role === 'triage');
  return {
    batch,
    pending: pending.length,
    items: pending.map(({ item }) => ({ ref: item.ref, title: oneLine(item.title, MAX_TITLE) })),
    skipped,
    prs: pr.prs,
    subagent: 'forge:triage',
    model: row?.model ?? 'haiku',
    effort: row?.effort ?? null,
    brief: `Triage the tracker items in \`${itemsMd}\`. Judge each against the rubric in your instructions and write your verdicts to \`${path.join(dir, 'verdicts.json')}\`. Reply with one line.`,
  };
}

/** An agent-writable JSON file through one O_NOFOLLOW descriptor: a regular file, at most `cap` bytes, valid JSON. */
function readCappedJson(file: string, cap: number): unknown {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    throw new ForgeError(`no ${path.basename(file)} at ${file}`, 'not_found');
  }
  if (!st.isFile()) throw new ForgeError(`${file} is not a regular file`);
  if (st.size > cap) throw new ForgeError(`${file} is over ${cap / 1024} KiB`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let text: string;
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile()) throw new ForgeError(`${file} is not a regular file`);
    const buf = Buffer.alloc(cap + 1);
    let len = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, len, buf.length - len, null);
      if (!n) break;
      len += n;
      if (len > cap) throw new ForgeError(`${file} is over ${cap / 1024} KiB`);
    }
    text = buf.subarray(0, len).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ForgeError(`${file} is not valid JSON`);
  }
}

function readVerdicts(file: string): Map<string, { missing: unknown; duplicateOf: unknown }> {
  const raw: any = readCappedJson(file, MAX_VERDICTS);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) throw new ForgeError(`${file} must hold {"items": [...]}`);
  const out = new Map<string, { missing: unknown; duplicateOf: unknown }>();
  for (const v of raw.items) {
    // A GitHub ref written as a number still names the item; anything else names none.
    const ref = typeof v?.ref === 'string' ? v.ref : Number.isInteger(v?.ref) ? String(v.ref) : null;
    if (ref !== null && !out.has(ref)) out.set(ref, { missing: v.missing, duplicateOf: v.duplicateOf });
  }
  return out;
}

/** items.json, every field checked: it is the CLI's own record, but it sits where an agent can write. */
function readBatch(dir: string): BatchItem[] {
  const raw: any = readCappedJson(path.join(dir, 'items.json'), MAX_ITEMS_FILE);
  const items: BatchItem[] = [];
  for (const i of Array.isArray(raw?.items) ? raw.items : []) {
    if (typeof i?.ref !== 'string' || !REF.test(i.ref) || typeof i.hash !== 'string' || !HASH_RE.test(i.hash)) continue;
    if (items.some((x) => x.ref === i.ref)) continue;
    const candidates = (Array.isArray(i.candidates) ? i.candidates : [])
      .filter((c: any) => typeof c?.id === 'string' && CANDIDATE_ID.test(c.id))
      .map((c: any) => c.id as string);
    items.push({ ref: i.ref, hash: i.hash, needsInfo: i.needsInfo === true, candidates });
  }
  return items;
}

/**
 * How a duplicate candidate is cited, derived from its id and Forge's own job records: the label
 * items.json carries is agent-writable, so it never reaches a comment.
 */
function candidateLabel(root: string, tracker: Tracker, id: string): string {
  const pr = /^pr:(\d{1,9})$/.exec(id);
  if (pr) return `PR #${pr[1]}`;
  const job = listJobs(root).find((j) => `job:${j.id}` === id);
  return job ? jobLabel(tracker, job) : 'an active Forge job';
}

/** `forge tracker triage --apply <batch>`: validated verdicts in, templated tracker writes out. */
export function applyTriage(root: string, config: Config, tracker: Tracker, batch: string): { batch: string; results: ApplyItemResult[]; ready: number; needsInfo: number; skipped: number } {
  if (!BATCH_RE.test(batch)) throw new ForgeError(`invalid triage batch id ${JSON.stringify(String(batch).slice(0, 60))} (expected YYYYMMDDTHHMMSSZ-xxxx)`, 'usage');
  const dir = path.join(triageDir(root), batch);
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(dir);
  } catch {}
  if (!st?.isDirectory()) throw new ForgeError(`no triage batch ${batch}`, 'not_found');
  const items = readBatch(dir);
  const verdicts = readVerdicts(path.join(dir, 'verdicts.json'));
  const ctx: TrackerCtx = { root, config };
  const prefix = config.tracker.github.labels.prefix;
  return withLock(lockDir(root), () => {
    const cache = readTriageCache(root);
    const results: ApplyItemResult[] = [];
    for (const bi of items) {
      const v = verdicts.get(bi.ref);
      if (!v) {
        results.push({ ref: bi.ref, skipped: 'no verdict' });
        continue;
      }
      try {
        const item = tracker.get(ctx, bi.ref);
        if (!item || claimed(root, config, tracker, item)) {
          results.push({ ref: bi.ref, skipped: 'claimed' });
          continue;
        }
        if (itemHash(item) !== bi.hash) {
          results.push({ ref: bi.ref, skipped: 'stale' });
          continue;
        }
        const dupId = typeof v.duplicateOf === 'string' ? bi.candidates.find((c) => c === v.duplicateOf) ?? null : null;
        const dup = dupId ? { id: dupId, label: candidateLabel(root, tracker, dupId) } : null;
        const missing = missingSet(v.missing).filter((k) => k !== 'duplicate' || dup);
        const key = cacheKey(tracker, bi.ref);
        const prev = cache[key];
        let noted = prev?.noted ?? null;
        if (missing.length) {
          let commented = false;
          if (tracker.name !== 'local' && !sameSet(missing, prev?.noted ?? null)) {
            tracker.comment(ctx, bi.ref, commentBody(missing, dup?.label ?? null, prefix));
            commented = true;
          }
          const marked = typeof tracker.setNeedsInfo === 'function';
          if (marked) tracker.setNeedsInfo!(ctx, bi.ref, noteLine(missing, dup?.label ?? null));
          if (commented || tracker.name === 'local') noted = missing;
          results.push({ ref: bi.ref, ready: false, missing, commented, marked });
        } else {
          const has = Boolean(item.needsInfo ?? bi.needsInfo);
          const cleared = has && typeof tracker.setNeedsInfo === 'function';
          if (cleared) tracker.setNeedsInfo!(ctx, bi.ref, null);
          results.push({ ref: bi.ref, ready: true, missing: [], cleared });
        }
        // Forge's own comment and mark must never count as a change, so the hash is taken afterwards.
        const fresh = tracker.get(ctx, bi.ref);
        cache[key] = { hash: fresh ? itemHash(fresh) : bi.hash, ready: !missing.length, missing, duplicateOf: missing.includes('duplicate') ? dup!.id : null, noted, at: now() };
      } catch (e) {
        results.push({ ref: bi.ref, error: (e as Error).message.slice(0, 300) });
      }
    }
    writeCache(root, cache);
    return {
      batch,
      results,
      ready: results.filter((r) => 'ready' in r && r.ready).length,
      needsInfo: results.filter((r) => 'ready' in r && !r.ready).length,
      skipped: results.filter((r) => 'skipped' in r).length,
    };
  });
}

function sameSet(a: readonly TriageMissing[], b: readonly TriageMissing[] | null): boolean {
  return b !== null && a.length === b.length && a.every((k) => b.includes(k));
}
