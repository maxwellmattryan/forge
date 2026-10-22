// Settling the experiment ledger. `forge experiment evaluate` is the only writer of a ledger
// status: it compares each open entry's metric over the jobs created after it with the entry's
// baseline, and writes kept, reverted or inconclusive once the interval decides it or the cap is
// reached. `forge experiment check` (and verify's `notes` step) refuse anything else that writes one,
// and new learnings or ledger entries that could never be measured.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LENS_NAME } from './lens.ts';
import { FORBIDDEN, METRIC_PATH, ledgerItems, metricValue, noteFiles, noteItems, parseLearnings, validDate } from './learnings.ts';
import type { LedgerItem } from './learnings.ts';
import { exists } from './paths.ts';
import { realHistoryEnv, resolveBase } from './scope.ts';
import { statsFrom, statsSources } from './stats.ts';
import type { StatsSource } from './stats.ts';
import type { Config, ExperimentEntry, ExperimentEvaluation, ExperimentResult, Job, NotesCheck, Stats } from './types.ts';
import { ForgeError, run, safeText } from './util.ts';

export type Method = 'two-proportion' | 'wilson' | 'bootstrap';
type Verdict = 'kept' | 'reverted' | 'inconclusive' | 'pending';

const Z = 1.96;
const RESAMPLES = 2000;
const MAX_LEDGER_BYTES = 1024 * 1024;

/** ReviewerStats keys a ledger metric may name under `reviewers.<lens>.`: the numeric ones. */
export const REVIEWER_METRICS = [
  'reviews', 'changes', 'blockers', 'changeRate', 'findings', 'fixed', 'disputes', 'disputeRate', 'recurring',
  'missChecked', 'missed', 'missRate', 'blockerMajor', 'severityKnown', 'blockerMajorShare',
];
const VERIFIER_METRICS = ['runs', 'fails', 'unanswered', 'blocks', 'hitRate'];
const USAGE_METRICS = ['tokens', 'estCostUsd', 'runs'];
const SCORE_METRICS = ['scored', 'medianScore'];
const KEY = /^[A-Za-z0-9_-]{1,100}$/;

let empty: Stats | null = null;

/**
 * Whether a ledger metric is a stats path: a fixed path that resolves to a number or null in the
 * stats of no jobs, or a numeric field of one of the keyed maps (a lens, a verifier, a role or model).
 */
export function validMetricPath(name: unknown): boolean {
  if (typeof name !== 'string' || name.length > 200 || !METRIC_PATH.test(name)) return false;
  const segs = name.split('.');
  if (segs.some((s) => FORBIDDEN.has(s))) return false;
  if (metricValue((empty ??= statsFrom([], {})), name) !== undefined) return true;
  const [a, b, c, d] = segs;
  if (segs.length === 3 && a === 'reviewers') return LENS_NAME.test(b) && REVIEWER_METRICS.includes(c);
  if (segs.length === 3 && a === 'verifiers') return /^[a-z0-9][a-z0-9-]{0,63}$/.test(b) && VERIFIER_METRICS.includes(c);
  if (segs.length === 4 && a === 'cost' && (b === 'byRole' || b === 'byModel')) return KEY.test(c) && USAGE_METRICS.includes(d);
  if (segs.length === 4 && a === 'quality' && b === 'scoreByBuilderModel') return KEY.test(c) && SCORE_METRICS.includes(d);
  return false;
}

/** The Wilson score interval for a proportion `p` of `n`, at 95%. */
export function wilson(p: number, n: number): [number, number] {
  const q = Math.min(1, Math.max(0, p));
  const z2 = Z * Z;
  const denom = 1 + z2 / n;
  const center = (q + z2 / (2 * n)) / denom;
  const half = (Z * Math.sqrt((q * (1 - q)) / n + z2 / (4 * n * n))) / denom;
  return [center - half, center + half];
}

/** Newcombe's hybrid score interval for p1 − p0 (method 10), from the two Wilson intervals. */
export function newcombe(p1: number, n1: number, p0: number, n0: number): [number, number] {
  const [l1, u1] = wilson(p1, n1);
  const [l0, u0] = wilson(p0, n0);
  const d = p1 - p0;
  return [d - Math.sqrt((p1 - l1) ** 2 + (u0 - p0) ** 2), d + Math.sqrt((u1 - p1) ** 2 + (p0 - l0) ** 2)];
}

/** mulberry32: a small seeded PRNG, so the same entry always resamples the same way. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The seed for an entry: the first 8 hex of sha256(id). */
export const seedFor = (id: string): number => parseInt(crypto.createHash('sha256').update(id).digest('hex').slice(0, 8), 16);

/** A 95% percentile bootstrap interval of the mean of `values`. */
export function bootstrap(values: number[], seed: number, resamples = RESAMPLES): [number, number] {
  const rand = mulberry32(seed);
  const n = values.length;
  const means: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[Math.floor(rand() * n)];
    means.push(sum / n);
  }
  means.sort((x, y) => x - y);
  return [means[Math.floor(0.025 * resamples)], means[Math.ceil(0.975 * resamples) - 1]];
}

/** Three decimals, and never -0, so a written number reads back as itself. */
const round3 = (x: number): number => {
  const r = Math.round(x * 1000) / 1000;
  return r === 0 ? 0 : r;
};

const isRate = (metric: string): boolean => /(Rate|Share)$/.test(metric.split('.').pop() ?? '');

/** Why an entry can never be settled by measurement, in step 1's order; null when it can. */
export function unsettleable(e: Pick<ExperimentEntry, 'metric' | 'direction' | 'baseline'>): string | null {
  if (!validMetricPath(e.metric)) return 'metric is not a stats path';
  if (!e.direction) return 'no direction';
  if (e.baseline === null) return 'no baseline';
  return null;
}

/** The method step 4 picks: a rate with a baseline sample, a rate without one, or a mean. Null when unsettleable. */
export function methodFor(e: Pick<ExperimentEntry, 'metric' | 'direction' | 'baseline' | 'baselineN'>): Method | null {
  if (unsettleable(e)) return null;
  if (!isRate(e.metric!)) return 'bootstrap';
  return e.baselineN !== null && e.baselineN > 0 ? 'two-proportion' : 'wilson';
}

/** kept on the improving side, reverted on the worsening side, inconclusive when the interval straddles or touches 0. */
export function verdictOf(direction: 'up' | 'down', [lo, hi]: [number, number]): 'kept' | 'reverted' | 'inconclusive' {
  const up = direction === 'up';
  if (up ? lo > 0 : hi < 0) return 'kept';
  if (up ? hi < 0 : lo > 0) return 'reverted';
  return 'inconclusive';
}

/** The three statuses evaluate writes; validWrittenStatus reads exactly these back. */
export const writtenStatus = {
  decided: (verdict: 'kept' | 'reverted' | 'inconclusive', date: string, n: number, method: Method, [lo, hi]: [number, number]) =>
    `status ${verdict} (${date}, n ${n}, ${method}, diff ${String(lo)}..${String(hi)})`,
  belowMin: (date: string, n: number, minJobs: number, jobsAfter: number) => `status inconclusive (${date}, n ${n} below minJobs ${minJobs} after ${jobsAfter} jobs)`,
  unsettleable: (date: string, reason: string) => `status inconclusive (${date}, ${reason})`,
};

const DATE = '(\\d{4}-\\d{2}-\\d{2})';
const NUM = '(-?\\d{1,15}(?:\\.\\d{1,3})?)';
const INT = '(\\d{1,9})';
// Anchored, and every quantifier is bounded and separated by literals: linear on any line.
const FORM_DECIDED = new RegExp(`^status (kept|reverted|inconclusive) \\(${DATE}, n ${INT}, (two-proportion|wilson|bootstrap), diff ${NUM}\\.\\.${NUM}\\)$`);
const FORM_BELOW = new RegExp(`^status inconclusive \\(${DATE}, n ${INT} below minJobs ${INT} after ${INT} jobs\\)$`);
const FORM_REASON = new RegExp(`^status inconclusive \\(${DATE}, (metric is not a stats path|no direction|no baseline)\\)$`);

/** The settlement thresholds, with the defaults for a config that predates them. */
export function thresholds(config: Config): { minJobs: number; maxJobs: number } {
  const e = config.improve?.experiments;
  return { minJobs: e?.minJobs ?? 5, maxJobs: e?.maxJobs ?? 10 };
}

/**
 * Whether `segment` is a status evaluate could have written for `entry`: one of its three forms,
 * dated no earlier than the entry, and consistent with the entry's method, direction and the
 * configured minJobs and maxJobs. It is not recomputed: the job set has moved on since the run.
 */
export function validWrittenStatus(entry: ExperimentEntry, segment: string, config: Config): boolean {
  if (typeof segment !== 'string' || segment.length > 300) return false;
  const { minJobs, maxJobs } = thresholds(config);
  const dated = (d: string) => validDate(d) && (!entry.date || d >= entry.date);
  let m = FORM_DECIDED.exec(segment);
  if (m) {
    const [, word, date, n, method, lo, hi] = m;
    if (!dated(date) || method !== methodFor(entry) || Number(n) < minJobs || Number(lo) > Number(hi)) return false;
    return verdictOf(entry.direction!, [Number(lo), Number(hi)]) === word;
  }
  m = FORM_BELOW.exec(segment);
  if (m) {
    const [, date, n, min, after] = m;
    return dated(date) && Number(n) < Number(min) && Number(min) === minJobs && Number(after) >= maxJobs;
  }
  m = FORM_REASON.exec(segment);
  if (m) {
    const [, date, reason] = m;
    const holds = reason === 'metric is not a stats path' ? !validMetricPath(entry.metric) : reason === 'no direction' ? !entry.direction : entry.baseline === null;
    return dated(date) && holds;
  }
  return false;
}

/** One open entry's result, and the status a run writes for it (null: it stays open). */
function evaluateEntry(entry: ExperimentEntry, after: () => { count: number; values: (metric: string) => number[] }, config: Config, today: string): { result: ExperimentResult; write: string | null } {
  const { minJobs, maxJobs } = thresholds(config);
  const base: ExperimentResult = {
    id: entry.id,
    metric: entry.metric,
    direction: entry.direction,
    baseline: entry.baseline,
    baselineN: entry.baselineN,
    jobsAfter: null,
    n: null,
    value: null,
    method: null,
    interval: null,
    verdict: 'inconclusive',
    status: 'status open',
    reason: null,
  };
  const why = unsettleable(entry);
  if (why) {
    const write = writtenStatus.unsettleable(today, why);
    return { result: { ...base, status: write, reason: why }, write };
  }
  if (!entry.id) return { result: { ...base, verdict: 'pending', reason: 'no id' }, write: null };
  if (!entry.date) return { result: { ...base, verdict: 'pending', reason: 'no date' }, write: null };
  const set = after();
  const values = set.values(entry.metric!);
  const n = values.length;
  const method = methodFor(entry)!;
  const res: ExperimentResult = { ...base, jobsAfter: set.count, n, method, value: n ? round3(values.reduce((a, b) => a + b, 0) / n) : null };
  const capped = set.count >= maxJobs;
  if (n < minJobs) {
    const write = capped ? writtenStatus.belowMin(today, n, minJobs, set.count) : null;
    return { result: { ...res, verdict: 'pending', status: write ?? 'status open' }, write };
  }
  const p0 = entry.baseline!;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  let raw: [number, number];
  if (method === 'two-proportion') raw = newcombe(mean, n, p0, entry.baselineN!);
  else if (method === 'wilson') {
    const [l, u] = wilson(mean, n);
    raw = [l - p0, u - p0];
  } else {
    const [l, u] = bootstrap(values, seedFor(entry.id));
    raw = [l - p0, u - p0];
  }
  const interval: [number, number] = [round3(raw[0]), round3(raw[1])];
  const verdict = verdictOf(entry.direction!, interval);
  const write = verdict !== 'inconclusive' || capped ? writtenStatus.decided(verdict, today, n, method, interval) : null;
  return { result: { ...res, interval, verdict, status: write ?? 'status open' }, write };
}

/** A regular file's text, read without following a link; null when absent. */
function readNoFollow(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ForgeError(`cannot read ${file}: ${(e as Error).message}`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new ForgeError(`${file} is not a regular file`);
    if (st.size > MAX_LEDGER_BYTES) throw new ForgeError(`${file} is over ${MAX_LEDGER_BYTES} bytes`);
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** The ledger evaluate edits: the job worktree's, or the repo's; never through a link or outside its checkout. */
export function ledgerFile(root: string, job: Pick<Job, 'id' | 'worktree'> | null): string {
  const checkout = job ? job.worktree : root;
  if (!checkout || !exists(checkout)) throw new ForgeError(`job ${job?.id} has no worktree; run: forge worktree create ${job?.id}`);
  const real = fs.realpathSync(checkout);
  let dir = real;
  for (const seg of ['.forge', 'notes']) {
    dir = path.join(dir, seg);
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) throw new ForgeError(`${dir} is a symlink; forge experiment edits no ledger through a link`);
    } catch (e) {
      if (e instanceof ForgeError) throw e;
    }
  }
  const file = path.join(dir, 'experiments.md');
  const rel = path.relative(real, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ForgeError(`${file} is outside ${real}`);
  return file;
}

/**
 * Writes through a fresh temp file in the same directory, then renames over the ledger. Not
 * writeTextAtomic: the ledger sits in a builder-written worktree, so the temp file is opened `wx`
 * (a planted file or link at its path is refused), and no directory is created on the way.
 */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { flag: 'wx' });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * `forge experiment evaluate`: settles each open ledger entry it can. Reads jobs from `root` only;
 * writes the one ledger file (the job worktree's with `job`) and nothing else, and with `dryRun`
 * nothing at all.
 */
export function evaluateExperiments(root: string, config: Config, opts: { job?: Pick<Job, 'id' | 'worktree'> | null; dryRun?: boolean; today?: string } = {}): ExperimentEvaluation {
  const file = ledgerFile(root, opts.job ?? null);
  const raw = readNoFollow(file) ?? '';
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  // Done or cancelled, neither eval nor retro, from the repo, live or archived; each job's own stats once.
  let pool: { src: StatsSource; created: number; stats?: Stats }[] | null = null;
  const after = (date: string) => () => {
    pool ??= statsSources(root, {})
      .filter((s) => s.job.kind !== 'retro' && (s.job.state === 'done' || s.job.state === 'cancelled'))
      .map((src) => ({ src, created: Date.parse(String(src.job.createdAt)) }));
    const cut = Date.parse(`${date}T23:59:59.999Z`);
    const jobs = pool.filter((p) => p.created > cut);
    return {
      count: jobs.length,
      values: (metric: string) =>
        jobs
          .map((p) => metricValue((p.stats ??= statsFrom([p.src], { config })), metric))
          .filter((v): v is number => typeof v === 'number'),
    };
  };
  const edits: { at: number; status: string }[] = [];
  const entries: ExperimentResult[] = [];
  for (const item of ledgerItems(raw)) {
    const e = item.entry;
    if (e.status !== 'open') {
      entries.push({ id: e.id, metric: e.metric, direction: e.direction, baseline: e.baseline, baselineN: e.baselineN, jobsAfter: null, n: null, value: null, method: null, interval: null, verdict: 'settled', status: item.statusSegment, reason: null });
      continue;
    }
    const { result, write } = evaluateEntry(e, after(e.date ?? today), config, today);
    if (write && item.openAt === null) {
      entries.push({ ...result, status: item.statusSegment, reason: 'status segment is not "status open"' });
      continue;
    }
    if (write) edits.push({ at: item.openAt!, status: write });
    entries.push(result);
  }
  if (!opts.dryRun && edits.length) {
    let text = raw;
    for (const { at, status } of [...edits].sort((a, b) => b.at - a.at)) text = text.slice(0, at) + status + text.slice(at + 'status open'.length);
    writeAtomic(file, text);
  }
  return { file, dryRun: Boolean(opts.dryRun), written: opts.dryRun ? 0 : edits.length, entries };
}

// ---------- forge experiment check ----------

const problem = (file: string, text: string, what: string) => ({ file, entry: safeText(text.slice(0, 80)), problem: what });

/** ` · ` segments of two versions of an entry differ only in the status segment. */
function onlyStatusChanged(base: LedgerItem, cur: LedgerItem): boolean {
  const a = base.text.split(' · ');
  const b = cur.text.split(' · ');
  if (a.length !== b.length) return false;
  const at = (xs: string[]) => xs.findIndex((s, i) => i > 0 && s.startsWith('status '));
  const i = at(a);
  if (i < 0 || i !== at(b)) return false;
  return a.every((s, k) => k === i || s === b[k]) && a[i] !== b[i];
}

function openProblems(e: ExperimentEntry): string[] {
  const out: string[] = [];
  if (!validMetricPath(e.metric)) out.push(`metric ${safeText(e.metric ?? '', 100)} is not a stats path`);
  if (!e.direction) out.push('missing direction');
  if (e.baseline === null) out.push('missing baseline');
  return out;
}

/** The notes files a job's diff can touch: learnings, the ledger, and each role's addendum, under `.forge/`. */
export const checkedNotes = (): string[] => [...noteFiles(), 'notes/experiments.md'].map((f) => `.forge/${f}`);

/** The file at `rev`, as git stores it (no filters, no replace objects); null when it is absent there. */
function atRev(cwd: string, rev: string, rel: string): string | null {
  const r = run('git', ['cat-file', 'blob', `${rev}:${rel}`], { cwd, env: realHistoryEnv(), allowFail: true });
  // No exit status: git never finished (a blob past run's buffer, say), which is no proof of absence.
  if (!r.ok && r.status === null) throw new ForgeError(`cannot read ${rel} at ${rev.slice(0, 12)}: ${r.stderr.slice(0, 200)}`, 'external');
  return r.ok ? r.stdout : null;
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * `forge experiment check`: with a job, each notes file at `sha` (HEAD by default) against the merge
 * base, so only what the branch adds or edits is checked; without one, a full audit of the repo's
 * files on disk. Ledger entries are matched by id, so evaluate's own settlement is the only accepted
 * change to an existing entry.
 */
export function checkNotes(root: string, config: Config, job: Pick<Job, 'id' | 'worktree' | 'base'> | null, sha?: string): NotesCheck {
  // Every file is read, and its size checked, before anything is parsed: past the cap it is reported, never parsed.
  const over = new Set<string>();
  const capped = (rel: string, size: number): boolean => {
    if (size <= MAX_LEDGER_BYTES) return true;
    over.add(rel);
    return false;
  };
  let read: (rel: string) => string | null;
  let readBase: ((rel: string) => string | null) | null = null;
  if (job) {
    const wt = job.worktree;
    if (!wt || !exists(wt)) throw new ForgeError(`job ${job.id} has no worktree; run: forge worktree create ${job.id}`);
    const head = sha ?? run('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: wt, env: realHistoryEnv() }).stdout.trim();
    if (!SHA.test(head)) throw new ForgeError(`not a commit sha: ${JSON.stringify(head).slice(0, 60)}`);
    const mergeBase = resolveBase(wt, config, job, head).mergeBase;
    if (!SHA.test(mergeBase)) throw new ForgeError(`no merge base for job ${job.id}`, 'external');
    const at = (rev: string) => (rel: string) => {
      const text = atRev(wt, rev, rel);
      return text !== null && capped(rel, Buffer.byteLength(text)) ? text : null;
    };
    read = at(head);
    readBase = at(mergeBase);
  } else {
    read = (rel) => {
      const file = path.join(root, rel);
      return exists(file) && capped(rel, fs.statSync(file).size) ? fs.readFileSync(file, 'utf8') : null;
    };
  }
  const rels = checkedNotes();
  const cur = new Map(rels.map((rel) => [rel, read(rel)] as const));
  const prev = readBase ? new Map(rels.map((rel) => [rel, readBase!(rel)] as const)) : null;
  if (over.size) return { ok: false, problems: [...over].map((rel) => ({ file: rel, entry: '', problem: `over ${MAX_LEDGER_BYTES / (1024 * 1024)} MiB; not checked` })) };
  const problems: NotesCheck['problems'] = [];
  const ledgerRel = '.forge/notes/experiments.md';
  const ledger = ledgerItems(cur.get(ledgerRel) ?? '');
  const ids = new Set(ledger.map((i) => i.entry.id).filter(Boolean));

  // Learnings and addenda: an added or edited entry (every entry in an audit) carries both fields.
  for (const rel of noteFiles().map((f) => `.forge/${f}`)) {
    const text = cur.get(rel) ?? null;
    if (text === null) continue;
    const before = prev ? new Set(noteItems(prev.get(rel) ?? '')) : null;
    for (const item of noteItems(text)) {
      if (before?.has(item)) continue;
      const [l] = parseLearnings(`- ${item}`);
      if (!l) continue;
      if (!l.experiment) problems.push(problem(rel, item, 'missing experiment:'));
      if (!/review-by:/.test(item)) problems.push(problem(rel, item, 'missing review-by:'));
      else if (!l.reviewBy) problems.push(problem(rel, item, 'review-by is not a date'));
      if (l.experiment && !ids.has(l.experiment)) problems.push(problem(rel, item, `unknown experiment ${l.experiment}`));
    }
  }

  // The ledger, entry by id.
  const seen = new Map<string, number>();
  for (const item of ledger) {
    const id = item.entry.id;
    if (!id) continue;
    seen.set(id, (seen.get(id) ?? 0) + 1);
    if (seen.get(id) === 2) problems.push(problem(ledgerRel, item.text, `duplicate id ${id}`));
  }
  const base = new Map<string, LedgerItem>();
  if (prev) for (const item of ledgerItems(prev.get(ledgerRel) ?? '')) if (item.entry.id && !base.has(item.entry.id)) base.set(item.entry.id, item);
  const asNew = (item: LedgerItem) => {
    if (!item.entry.id) problems.push(problem(ledgerRel, item.text, 'missing id'));
    if (item.statusSegment !== 'status open') problems.push(problem(ledgerRel, item.text, 'status must be open'));
    for (const p of openProblems(item.entry)) problems.push(problem(ledgerRel, item.text, p));
  };
  for (const item of ledger) {
    if (!prev) {
      // An audit has no base: open entries are checked as new, the rest are history.
      if (item.entry.status === 'open') asNew(item);
      continue;
    }
    const was = item.entry.id ? base.get(item.entry.id) : undefined;
    if (!was) {
      asNew(item);
      continue;
    }
    if (was.text === item.text) continue;
    const statusOnly = onlyStatusChanged(was, item);
    if (was.statusSegment === 'status open' && statusOnly && validWrittenStatus(item.entry, item.statusSegment ?? '', config)) continue;
    if (was.entry.status !== 'open') problems.push(problem(ledgerRel, item.text, 'a settled entry is history and may not change'));
    else if (statusOnly) problems.push(problem(ledgerRel, item.text, 'only forge experiment evaluate writes a status'));
    else problems.push(problem(ledgerRel, item.text, 'an existing entry may only change its status'));
  }
  for (const [id, item] of base) if (!ids.has(id)) problems.push(problem(ledgerRel, item.text, `entry ${id} was removed`));
  return { ok: !problems.length, problems };
}
