// Post-merge scoring: a sampled share of merged jobs, plus every merged job of a mandate that scores all,
// gets one run of the judge against the spec's acceptance criteria and the merged PR's diff, so real work
// has a quality score beside the evals'. The mandate's term comes from a resolver the CLI passes (this
// layer can't read mandates), asked only for the CLI record's `mandate`, never the job folder's job.json.
//
// score.md and the diff are untrusted (the judge, or the builder's merged code, wrote them): from
// score.md only a regex-parsed number is stored, and the diff reaches only the judge, fenced as data.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { effectiveLimits, exceededKeys, measureJob } from '../metrics/budget.ts';
import { validModel } from '#core/config/load.ts';
import { configForJob } from './overlay.ts';
import { jobDir, listJobs, loadJob, logEvent, setJob, updateJob } from '#core/job/store.ts';
import type { GhFn } from './outcome.ts';
import { repoSlug } from '#integrations/github/pull-requests.ts';
import { repoBudgetStatus } from '../metrics/repo-budget.ts';
import { enqueue, listRequests } from '#core/job/requests.ts';
import type { Config, Job, JobScore } from '#core/types.ts';
import type { MandateScoring } from '#api/types.ts';
import { gh } from '#integrations/github/gh.ts';
import { ForgeError } from '#core/errors.ts';
import { writeAtomic } from '#core/os/fs.ts';

const DAY_MS = 86_400_000;
/** Merges older than this are never queued: the bound on retrying a failed diff fetch. */
const SCORE_LOOKBACK_DAYS = 7;
const PER_SYNC = 5;
export const MAX_DIFF_BYTES = 1_048_576;
const MAX_SCORE_MD_BYTES = 65_536;
const TRUNCATED = `[forge: diff truncated at ${MAX_DIFF_BYTES} bytes]`;
// One line, its parts separated by fixed tokens, so no two quantifiers can match the same characters.
const SCORE_LINE = /^SCORE:\s*(\d(?:\.\d)?)\s*\/\s*5\s*$/;

const defaultGh = (root: string): GhFn => (args) => gh(root, args, { allowFail: true });
const isPositiveInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const timeOf = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

/**
 * Whether job `id` is in the sample: the first 4 bytes of sha256(id), as an unsigned big-endian
 * integer over 2^32, below `sample`. Deterministic, so a re-sync never re-rolls the choice.
 */
export function isSampled(id: string, sample: number): boolean {
  if (typeof sample !== 'number' || !Number.isFinite(sample) || sample <= 0) return false;
  if (sample >= 1) return true;
  const n = createHash('sha256').update(String(id)).digest().readUInt32BE(0);
  return n / 2 ** 32 < sample;
}

/** When the root PR merged: the PR's own merge time, else the outcome's; null when neither is a time. */
export function mergeTime(job: Pick<Job, 'pr' | 'outcome'>): number | null {
  return timeOf(job.pr?.mergedAt) ?? timeOf(job.outcome?.mergedAt);
}

/** A job's mandate's scoring term, or null for none or an unreadable mandate (lib/office/mandates/store.ts jobMandateScoring). */
export type MandateScoringFn = (job: Job) => MandateScoring | null;

/**
 * Whether sync should queue a score run for `job` now: merged in the lookback, never scored, and either
 * in a mandate that scores all or sampled. A mandate that scores off is never due; one that samples,
 * no mandate and an unreadable one (null) fall back to scoring.sample.
 */
function scoreDue(job: Job, now: Date, config: Config, mandateScoring?: MandateScoringFn): boolean {
  if (job.kind === 'eval' || job.pr?.state !== 'MERGED' || job.score !== null) return false;
  const at = mergeTime(job);
  if (at === null || at > now.getTime() || now.getTime() - at > SCORE_LOOKBACK_DAYS * DAY_MS) return false;
  // Only after the cheap checks: the resolver reads a file.
  const term = mandateScoring && typeof job.mandate === 'string' && job.mandate ? mandateScoring(job) : null;
  if (term === 'off') return false;
  if (term === 'all') return true;
  return isSampled(job.id, config.scoring?.sample ?? 0);
}

function slugOf(root: string, config: Config): string | null {
  try {
    const s = repoSlug(root, config);
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

/** The diff as score.diff stores it: at most MAX_DIFF_BYTES, then a line saying it was cut. */
export function capDiff(diff: string): Buffer {
  const bytes = Buffer.from(diff, 'utf8');
  if (bytes.length <= MAX_DIFF_BYTES) return bytes;
  return Buffer.concat([bytes.subarray(0, MAX_DIFF_BYTES), Buffer.from(`\n${TRUNCATED}\n`)]);
}

const blankScore = (): Omit<JobScore, 'status'> => ({ queuedAt: null, value: null, outOf: 5, recordedAt: null, judgeModel: null, builderModel: null });

/**
 * `forge sync`'s scoring pass over a sampled share of merged jobs, plus every merged job of a mandate
 * that scores all (`mandateScoring` gives a job's term): for up to `limit` due jobs, oldest merge first,
 * hold the ones over a budget, or fetch the merged PR's diff and queue one judge run with a `resume`
 * request. A failed fetch leaves the job alone for the next sync, inside the lookback.
 */
export function queueScores(
  root: string,
  config: Config,
  opts: { now?: Date; gh?: GhFn; limit?: number; mandateScoring?: MandateScoringFn } = {},
): { queued: string[]; held: string[] } {
  const queued: string[] = [];
  const held: string[] = [];
  if (!config.pr?.enabled) return { queued, held };
  const now = opts.now ?? new Date();
  const due = listJobs(root)
    .filter((j) => scoreDue(j, now, config, opts.mandateScoring))
    .sort((a, b) => (mergeTime(a) as number) - (mergeTime(b) as number) || a.id.localeCompare(b.id))
    .slice(0, opts.limit ?? PER_SYNC);
  if (!due.length) return { queued, held };
  const gh = opts.gh ?? defaultGh(root);
  const slug = slugOf(root, config);
  let repoHeld: boolean | null = null;
  for (const job of due) {
    // Before any request is written: a held job never spends a judge run.
    const over = exceededKeys(effectiveLimits(configForJob(root, config, job), job), measureJob(root, config, job), job.budget.ack, job.round).length > 0;
    repoHeld ??= repoBudgetStatus(root, config, { write: false }).held;
    if (over || repoHeld) {
      const reason = over ? 'budget exceeded' : 'repo budget';
      setJob(root, job.id, { owned: { score: { ...blankScore(), status: 'held', recordedAt: now.toISOString(), reason } } });
      logEvent(root, job.id, 'score', { status: 'held', reason });
      held.push(job.id);
      continue;
    }
    const number = isPositiveInt(job.pr?.number) ? job.pr!.number : null;
    if (!slug || !number) continue;
    const r = gh(['pr', 'diff', String(number), '-R', slug]);
    if (!r.ok) continue;
    // The job dir is agent-writable: writeAtomic never follows a link planted at either name.
    writeAtomic(path.join(jobDir(root, job.id), 'score.diff'), capDiff(r.stdout));
    setJob(root, job.id, { owned: { score: { ...blankScore(), status: 'queued', queuedAt: now.toISOString() } } });
    logEvent(root, job.id, 'score', { status: 'queued' });
    // A fixed text: nothing from the PR reaches a session through it.
    if (!listRequests(root, { status: 'pending' }).some((q) => q.type === 'resume' && q.job === job.id))
      enqueue(root, config, { type: 'resume', job: job.id, text: 'forge sync queued a score run', from: 'sync' });
    queued.push(job.id);
  }
  return { queued, held };
}

/** score.md's first non-empty line as a score from 0 to 5, one decimal at most. */
export function parseScoreMd(text: string): { value: number } | { error: 'malformed score.md' } {
  const line = text.split('\n').map((l) => l.replace(/\r$/, '')).find((l) => l.trim() !== '');
  const m = line === undefined ? null : SCORE_LINE.exec(line);
  const value = m ? Number(m[1]) : NaN;
  return Number.isFinite(value) && value >= 0 && value <= 5 ? { value } : { error: 'malformed score.md' };
}

/** score.md as text when it is a regular file of at most MAX_SCORE_MD_BYTES, reached without a link. */
function readScoreMd(file: string): { text: string } | { error: 'no score.md' | 'malformed score.md' } {
  let link: fs.Stats;
  try {
    link = fs.lstatSync(file);
  } catch {
    return { error: 'no score.md' };
  }
  if (!link.isFile() || link.size > MAX_SCORE_MD_BYTES) return { error: 'malformed score.md' };
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return { error: 'malformed score.md' };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.dev !== link.dev || st.ino !== link.ino || st.size > MAX_SCORE_MD_BYTES) return { error: 'malformed score.md' };
    const buf = Buffer.alloc(MAX_SCORE_MD_BYTES + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return n > MAX_SCORE_MD_BYTES ? { error: 'malformed score.md' } : { text: buf.subarray(0, n).toString('utf8') };
  } catch {
    return { error: 'malformed score.md' };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * `forge job score record`: reads score.md and moves the queued score to `scored`, or to `failed`
 * (and throws) when the file is missing or malformed. Refuses a job with no queued run.
 */
export function recordScore(root: string, id: string): { id: string; score: JobScore } {
  const job = loadJob(root, id);
  if (job.score?.status !== 'queued') throw new ForgeError(`no score run is queued for ${job.id}`);
  const file = path.join(jobDir(root, job.id), 'score.md');
  const read = readScoreMd(file);
  const parsed = 'text' in read ? parseScoreMd(read.text) : read;
  const at = new Date().toISOString();
  let score: JobScore | null = null;
  updateJob(root, job.id, (j) => {
    // Inside the lock, so two records can't both move the same queued run.
    if (j.score?.status !== 'queued') throw new ForgeError(`no score run is queued for ${j.id}`);
    const models = { judgeModel: validModel(j.agents.judge?.model), builderModel: validModel(j.agents.builder?.model) };
    score = 'value' in parsed
      ? { ...j.score, ...models, status: 'scored', value: parsed.value, recordedAt: at }
      : { ...j.score, ...models, status: 'failed', value: null, recordedAt: at, reason: parsed.error };
    j.score = score;
  });
  const s = score as unknown as JobScore;
  if (s.status === 'failed') {
    logEvent(root, job.id, 'score', { status: 'failed', reason: s.reason });
    throw new ForgeError(`${file}: ${s.reason}; the first non-empty line must be SCORE: <0-5>/5`);
  }
  logEvent(root, job.id, 'score', { status: 'scored', value: s.value });
  return { id: job.id, score: s };
}
