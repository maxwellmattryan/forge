// Mandate files: `.forge/runtime/mandates/<id>.md`, YAML frontmatter then the owner's guidance. Read
// without following a link or blocking on a FIFO, and written under one lock only through mandateWrite
// (`forge mandate new|edit|pause|resume|close|cancel|delete` and the dashboard's Office page, the same
// checks for both) and by the Office pass (`forge office pass`, which pauses and closes). Read for a job whose
// `mandate` is set to narrow what the Foreman decides (jobMandateDecides), and to tell `forge sync`
// whether its merged work gets a score run (jobMandateScoring). A mandate's runtime dir `<id>/`
// beside it holds its drafting runs' files (draft.ts, intake.ts), its board and its closing summary
// (pass.ts, director.ts). docs/architecture/foreman/mandates.md › Mandates.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '#core/paths.ts';
import { ForgeError } from '#core/errors.ts';
import { listArchived } from '#core/job/archive.ts';
import { enqueue, listRequests } from '#core/job/requests.ts';
import { listJobs, logRepoEvent } from '#core/job/store.ts';
import { confinedDir, readRegular, writeTextAtomic } from '#core/os/fs.ts';
import { withLock, withLockAsync } from '#core/os/lock.ts';
import { now } from '#core/utils.ts';
import * as yaml from '#core/format/yaml.ts';
import { currentActor } from '#integrations/github/actor.ts';
import { decides } from '#engine/pipeline/moves/foreman-gates.ts';
import { MANDATE_ID, MANDATE_KEYS, applyInput, blankMandate, cleanReason, fillDefaults, isMandateId, isReadable, issueRefs, mandateProblems, storedMandate } from './contract.ts';
import { queueMandateRetro } from '#engine/evals/retro.ts';
import { logDirective } from './directives.ts';
import type { Config, EventActor, GateClass, Job, MandateScoring } from '#core/types.ts';
import type { Mandate, MandateInput, ReadMandate } from './types.ts';

export { MANDATE_ID };

/** A mandate file is a short contract and at most 8000 characters of guidance: anything larger is not one. */
const MAX_BYTES = 64 * 1024;

/** The audit actions a mandate write logs, as `mandate-<action>`; `filed` is a goal mandate's draft filed (filing.ts). */
export type MandateAction = 'new' | 'edit' | 'pause' | 'resume' | 'close' | 'cancel' | 'delete' | 'filed';

const fileOf = (root: string, id: string): string => path.join(paths(root).mandates, `${id}.md`);

/** The repo-relative path of a mandate's file, as `forge mandate show` prints it. */
export const mandateFile = (root: string, id: string): string => path.relative(root, fileOf(root, id));

/** The frontmatter between the first two `---` lines, and the body after them; null when there is none. */
function splitFrontmatter(text: string): { front: string; body: string } | null {
  const lines = text.split('\n');
  if (lines[0]?.replace(/\r$/, '') !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.replace(/\r$/, '') === '---');
  if (end < 0) return null;
  const body = lines.slice(end + 1).join('\n');
  return { front: lines.slice(1, end).join('\n'), body: body.endsWith('\n') ? body.slice(0, -1) : body };
}

/**
 * One mandate, or `{ id, problem }` when its file can't be read safely: a bad id, no file (`no such
 * mandate`), a link, a non-regular file, over 64 KiB, bad frontmatter, or a term that breaks the
 * contract's rules (storedMandate). Callers never act on an unreadable mandate.
 */
export function readMandate(root: string, id: string): ReadMandate {
  if (!isMandateId(id)) return { id: String(id).slice(0, 60), problem: 'not a mandate id' };
  const bytes = readRegular(fileOf(root, id), MAX_BYTES);
  if (typeof bytes === 'string') return { id, problem: bytes === 'unreadable (ENOENT)' ? 'no such mandate' : bytes };
  const parts = splitFrontmatter(bytes.toString('utf8'));
  if (!parts) return { id, problem: 'no frontmatter between --- lines' };
  let raw: unknown;
  try {
    raw = yaml.parse(parts.front);
  } catch (e) {
    return { id, problem: `bad frontmatter: ${(e as Error).message.slice(0, 120)}` };
  }
  return storedMandate(raw, id, parts.body);
}

/** Every `<id>.md` in the mandates dir whose name is a mandate id, read; other names are ignored. */
export function listMandates(root: string): ReadMandate[] {
  let names: string[];
  try {
    names = fs.readdirSync(paths(root).mandates);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.md') && isMandateId(n.slice(0, -3)))
    .map((n) => readMandate(root, n.slice(0, -3)))
    .sort((a, b) => {
      // Unreadable files have no creation time; they sort after the rest, by id.
      const at = (m: ReadMandate) => (isReadable(m) ? m.createdAt : '￿');
      return at(a).localeCompare(at(b)) || a.id.localeCompare(b.id);
    });
}

/**
 * A mandate as its file holds it: every frontmatter key in order, then the body. The goal goes last as
 * one JSON-quoted line, which the YAML subset reads back byte for byte: its block scalars don't (a first
 * line's leading spaces, a second trailing newline, an indented `---`). `'` is written as `'`
 * because the subset's double-quoted reader unescapes `\'` before JSON.parse.
 */
function render(m: Mandate): string {
  const front = Object.fromEntries(MANDATE_KEYS.filter((k) => k !== 'goal').map((k) => [k, m[k]]));
  const goal = m.goal === null ? 'null' : JSON.stringify(m.goal).replace(/'/g, '\\u0027');
  return `---\n${yaml.stringify(front)}goal: ${goal}\n---\n${m.body ? `${m.body}\n` : ''}`;
}

/** The lock every mandate write takes, and a drafting run's record under a mandate's runtime dir. */
export function withMandatesLock<T>(root: string, fn: () => T): T {
  return withLock(path.join(paths(root).locks, 'mandates'), fn);
}

/**
 * The director loop's lock: the Office pass holds it for its whole run, and `forge office start`
 * while it re-checks the limits and starts a job, so two starts can't both take the last free slot.
 */
export function withOfficeLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  return withLockAsync(path.join(paths(root).locks, 'office'), fn, { timeoutMs: OFFICE_LOCK_WAIT_MS });
}

/** A pass may call the tracker once per milestone: a start waits this long for one to finish. */
const OFFICE_LOCK_WAIT_MS = 5 * 60 * 1000;

/** A mandate's runtime dir: its survey, ledger and draft. listMandates ignores it (no `.md` suffix). */
export const mandateDir = (root: string, id: string): string => path.join(paths(root).mandates, id);

/** A closed mandate's closing summary, which the Office pass writes (lib/office/mandates/pass.ts). */
export const summaryFile = (root: string, id: string): string => path.join(mandateDir(root, id), 'summary.json');

/** The Office pass's latest error-free tracker scope read, which the mandate plan reads (lib/office/mandates/progress.ts). */
export const scopeFile = (root: string, id: string): string => path.join(mandateDir(root, id), 'scope.json');

/**
 * The one write path. Under the mandates lock, `plan` gets every mandate as it is now and returns the
 * record to write with its audit action, or null to write nothing (it throws to refuse). A written
 * record appends one `mandate-<action>` event to the repo audit log, with `actor` when the plan names
 * one (the foreman or the dashboard deciding a draft), else whoever runs the CLI.
 */
export function writeMandate<T extends { mandate: Mandate; action: MandateAction; reason?: string | null; actor?: EventActor } | null>(root: string, plan: (all: ReadMandate[]) => T): T {
  return withMandatesLock(root, () => {
    const out = plan(listMandates(root));
    if (!out) return out;
    const { mandate: m, action, reason } = out;
    commitMandate(root, m.id, m, action, reason ? { reason } : {}, out.actor);
    return out;
  });
}

/**
 * Under the mandates lock: writes `m`'s file when given, then appends one `mandate-<action>` event for
 * mandate `id` with `data`, and `actor` or else whoever runs the CLI.
 */
function commitMandate(root: string, id: string, m: Mandate | null, action: MandateAction, data: Record<string, unknown>, actor: EventActor | undefined): void {
  if (m) writeTextAtomic(fileOf(root, m.id), render(m), { root });
  logRepoEvent(root, `mandate-${action}`, { mandate: id, ...data, actor: actor ?? currentActor(root) });
}

/** The owner's mandate writes: `forge mandate <op>` and the Office page's POSTs. */
export type MandateOp = 'new' | 'edit' | 'pause' | 'resume' | 'close' | 'cancel' | 'delete';

/** The readable mandate `id` among `all`; not_found when there is none, refused when it can't be read. */
export function mandateTarget(all: ReadMandate[], id: string): Mandate {
  const m = all.find((x) => x.id === id);
  if (!m) throw new ForgeError(`no mandate ${JSON.stringify(id).slice(0, 60)}`, 'not_found');
  if (!isReadable(m)) throw new ForgeError(`mandate ${id} can't be read (${m.problem})`, 1);
  return m;
}

/** Whether two records say the same thing, the edit time aside. */
const same = (a: Mandate, b: Mandate): boolean => JSON.stringify({ ...a, updatedAt: '' }) === JSON.stringify({ ...b, updatedAt: '' });

/** The status moves: each idempotent, so the move to the status a mandate already has writes nothing. */
function statusMove(op: 'pause' | 'resume' | 'close', m: Mandate, reason: string | null, at: string): Mandate | null {
  if (op === 'close') return m.status === 'closed' ? null : { ...m, status: 'closed', reason, closedAt: at, updatedAt: at };
  if (m.status === 'closed') throw new ForgeError(`mandate ${m.id} is closed`, 1);
  if (op === 'pause') return m.status === 'paused' ? null : { ...m, status: 'paused', reason, updatedAt: at };
  return m.status === 'active' ? null : { ...m, status: 'active', reason: null, updatedAt: at };
}

/** Whether anything sits at `p`, a link or a dir included. */
function present(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Attempts newMandateId makes before it refuses: with 2^32 candidates, a run of taken ones means something is wrong. */
const ID_ATTEMPTS = 16;

/**
 * A new mandate's id when the owner gives none: `m-` and 8 random hex digits that no mandate holds,
 * readable or not, and that no `<id>.md` entry or runtime dir `<id>/` holds either. A leftover runtime
 * dir keeps an old mandate's survey, draft, ledger and filing.json, which a new mandate must never
 * inherit, and none in `named`: the ids a live or archived job still names (a deleted mandate's). Call
 * it under the mandates lock, inside the write, so two creates can't pick the same id.
 */
export function newMandateId(
  root: string,
  all: ReadMandate[],
  random: () => string = () => crypto.randomBytes(4).toString('hex'),
  named: ReadonlySet<string> = new Set(),
): string {
  for (let i = 0; i < ID_ATTEMPTS; i++) {
    const c = `m-${random()}`;
    if (!isMandateId(c) || all.some((m) => m.id === c) || named.has(c) || present(fileOf(root, c)) || present(mandateDir(root, c))) continue;
    return c;
  }
  throw new ForgeError("couldn't pick an unused mandate id; pass one", 1);
}

/** How many live and archived jobs name each mandate id, so a deleted mandate's id is never handed out again. */
function namedIds(root: string): Map<string, number> {
  const named = new Map<string, number>();
  const add = (id: unknown) => {
    if (typeof id === 'string' && id) named.set(id, (named.get(id) ?? 0) + 1);
  };
  for (const j of listJobs(root)) add(j.mandate);
  for (const a of listArchived(root)) add(a.job.mandate);
  return named;
}

/** A mandate write's result: `cancelled` for a cancel, the jobs still naming it for a delete. */
export interface MandateWriteResult {
  changed: boolean;
  id: string;
  cancelled?: { job: string; request: string }[];
  jobs?: string[];
}

/** A cancel's reason as the file stores it: `cancelled`, or `cancelled: <R>`, cleaned to one capped line. */
const cancelReason = (raw: string | null | undefined): string => cleanReason(raw ? `cancelled: ${raw}` : 'cancelled') ?? 'cancelled';

/** The open request states: a job with a cancel in one of them gets no second one. */
const OPEN = new Set(['pending', 'in-progress']);

/**
 * `cancel`, under the mandates lock: the close as `close` makes it (null when already closed), then one
 * `cancel` request per unfinished live job of the mandate, in id order, skipping a job that already has
 * an open one. Logs one `mandate-cancel` event when anything changed.
 */
function cancelMandate(root: string, config: Config, id: string, o: { reason?: string | null; actor?: EventActor; from: 'cli' | 'dashboard' }): { closed: Mandate | null; cancelled: { job: string; request: string }[] } {
  return withMandatesLock(root, () => {
    const m = mandateTarget(listMandates(root), id);
    const reason = cancelReason(o.reason);
    const closed = statusMove('close', m, reason, now());
    if (closed) writeTextAtomic(fileOf(root, m.id), render(closed), { root });
    const open = new Set(listRequests(root).filter((r) => r.type === 'cancel' && OPEN.has(r.status)).map((r) => r.job));
    const text = `mandate ${m.id} ${reason}`;
    const cancelled = listJobs(root)
      .filter((j) => j.mandate === m.id && j.state !== 'done' && j.state !== 'cancelled' && !open.has(j.id))
      .map((j) => j.id)
      .sort()
      .map((job) => ({ job, request: enqueue(root, config, { type: 'cancel', job, text, from: o.from }).id }));
    if (closed || cancelled.length) commitMandate(root, m.id, null, 'cancel', { reason, jobs: cancelled.map((c) => c.job) }, o.actor);
    return { closed, cancelled };
  });
}

/**
 * `delete`, under the mandates lock: only a closed mandate no open mandate follows (`after`). Removes the
 * runtime dir `<id>/` first, then `<id>.md`, so a stopped run leaves the file and runs again. rmSync
 * lstats every entry: a link is unlinked, never followed. Logs one `mandate-delete` event; returns the
 * live jobs that still name it.
 */
function deleteMandate(root: string, id: string, actor: EventActor | undefined): string[] {
  return withMandatesLock(root, () => {
    const all = listMandates(root);
    const m = mandateTarget(all, id);
    if (m.status !== 'closed') throw new ForgeError(`mandate ${m.id} is ${m.status}: only a closed mandate can be deleted (forge mandate close or cancel first)`, 1);
    const follower = all.find((x) => isReadable(x) && x.status !== 'closed' && x.after === m.id);
    if (follower) throw new ForgeError(`mandate ${follower.id} follows ${m.id} (after) and is not closed; change its --after first`, 1);
    // The mandates dir itself must be a real directory under the repo, never a link: m.id already passed isMandateId.
    confinedDir(root, paths(root).mandates);
    fs.rmSync(mandateDir(root, m.id), { recursive: true, force: true });
    fs.rmSync(fileOf(root, m.id), { force: true });
    const jobs = mandateJobs(root, m.id);
    commitMandate(root, m.id, null, 'delete', { jobs: jobs.length }, actor);
    return jobs;
  });
}

/** After a close wrote, outside the mandates lock (the retro queue takes its own): its retro and the `retro` directive. */
function afterClose(root: string, config: Config, id: string, actor: EventActor | undefined): void {
  const retro = queueMandateRetro(root, config, id);
  if (retro) logDirective(root, { mandate: id, action: 'retro', reason: `queued request ${retro.request} over ${retro.jobs} jobs`, actor: actor ?? currentActor(root) });
}

/**
 * The one owner's mandate write, for the CLI and the dashboard: under the mandates lock, every check
 * before the write, so a refusal (a ForgeError: not_found, or exit 1 with every problem joined by `; `)
 * writes no file and no audit line. `new` takes every term not given from foreman.mandate, and with a
 * null id picks one (newMandateId, under the same lock); `edit` replaces only the terms given, and with
 * `updatedAt` refuses once the stored mandate has moved on (a CLI edit or a pass pause in between); the
 * status moves are idempotent. A close that writes queues the mandate's retro (queueMandateRetro) and
 * logs its `retro` directive with the owner's actor. `cancel` closes too, then queues a `cancel` request
 * (`from`, default cli) per unfinished job (`cancelled`); `delete` removes a closed mandate (`jobs`: the
 * live jobs still naming it). A new mandate never takes an id a job still names. `changed` is false
 * when nothing was written; `id` is the mandate's id, the picked one for a new mandate without one.
 */
export function mandateWrite(
  root: string,
  config: Config,
  op: MandateOp,
  id: string | null,
  o: { input?: MandateInput; reason?: string | null; updatedAt?: string; actor?: EventActor; from?: 'cli' | 'dashboard' } = {},
): MandateWriteResult {
  if (id === null && op !== 'new') throw new ForgeError('a mandate id is required', 'usage');
  if (op === 'cancel') {
    const { closed, cancelled } = cancelMandate(root, config, id as string, { reason: o.reason, actor: o.actor, from: o.from ?? 'cli' });
    if (closed) afterClose(root, config, closed.id, o.actor);
    return { changed: closed !== null || cancelled.length > 0, id: id as string, cancelled };
  }
  if (op === 'delete') return { changed: true, id: id as string, jobs: deleteMandate(root, id as string, o.actor) };
  const actor = o.actor ? { actor: o.actor } : {};
  const input = o.input ?? {};
  const out = writeMandate(root, (all) => {
    if (op === 'new') {
      const named = namedIds(root);
      const mid = id ?? newMandateId(root, all, undefined, new Set(named.keys()));
      if (all.some((m) => m.id === mid)) throw new ForgeError(`mandate ${mid} exists; change it with forge mandate edit`, 1);
      const naming = named.get(mid);
      if (naming) throw new ForgeError(`mandate id ${mid} is still named by ${naming} jobs (a deleted mandate's); pick another id`, 1);
      const refs = issueRefs(root, config, fillDefaults(config, input));
      const m = applyInput(blankMandate(mid, now()), refs.input);
      const problems = [...refs.problems, ...mandateProblems(config, m, all, null)];
      if (problems.length) throw new ForgeError(problems.join('; '), 1);
      return { mandate: m, action: 'new' as MandateAction, ...actor };
    }
    const existing = mandateTarget(all, id as string);
    if (op !== 'edit') {
      const reason = op === 'resume' ? null : cleanReason(o.reason);
      const next = statusMove(op, existing, reason, now());
      return next ? { mandate: next, action: op as MandateAction, reason, ...actor } : null;
    }
    if (o.updatedAt !== undefined && o.updatedAt !== existing.updatedAt) throw new ForgeError(`mandate ${id} changed since you read it; reload and edit again`, 1);
    const refs = issueRefs(root, config, input);
    const m = applyInput(existing, refs.input);
    const problems = [...refs.problems, ...mandateProblems(config, m, all, existing)];
    if (problems.length) throw new ForgeError(problems.join('; '), 1);
    return same(m, existing) ? null : { mandate: { ...m, updatedAt: now() }, action: 'edit' as MandateAction, ...actor };
  });
  // After the mandates lock is released: the retro queue takes its own lock.
  if (op === 'close' && out !== null) afterClose(root, config, out.mandate.id, o.actor);
  return { changed: out !== null, id: out?.mandate.id ?? (id as string) };
}

/** The ids of the jobs whose `mandate` is `id`. */
export function mandateJobs(root: string, id: string): string[] {
  return listJobs(root)
    .filter((j) => j.mandate === id)
    .map((j) => j.id)
    .sort();
}

/**
 * What a job's mandate lets the Foreman decide: null when the job is in none; nothing for a closed
 * mandate; the written decides cut to the effective foreman.decides for an active or paused one (a
 * paused mandate's in-flight jobs finish); or the problem when its file is missing or can't be read,
 * which the callers treat as no class delegated (fail closed).
 */
export function jobMandateDecides(root: string, config: Config, job: Pick<Job, 'mandate'>): MandateDecides | null {
  return job.mandate === null || job.mandate === undefined ? null : mandateDecides(root, config, job.mandate);
}

/**
 * A job's mandate's scoring term, whatever the mandate's status (a closed mandate's merged jobs are still
 * scored by it); null when the job is in no mandate, or its file is missing or can't be read, so the job
 * falls back to scoring.sample: an unreadable file never forces a score run.
 */
export function jobMandateScoring(root: string, job: Pick<Job, 'mandate'>): MandateScoring | null {
  if (typeof job.mandate !== 'string' || !job.mandate) return null;
  const m = readMandate(root, job.mandate);
  return isReadable(m) ? m.scoring : null;
}

/** What mandateDecides returns: the cut decides and the mandate, or why its file can't be read. */
export type MandateDecides = { id: string; decides: GateClass[]; mandate: Mandate } | { id: string; problem: string };

/**
 * What mandate `id` lets the Foreman decide: its written decides cut to the effective foreman.decides,
 * whatever its status, or the problem when its file is missing or can't be read (no class delegated).
 */
export function mandateDecides(root: string, config: Config, id: string): MandateDecides {
  const m = readMandate(root, id);
  if (!isReadable(m)) return { id: m.id, problem: m.problem };
  if (m.status === 'closed') return { id: m.id, decides: [], mandate: m };
  const granted = decides(config);
  return { id: m.id, decides: m.decides.filter((g) => granted.includes(g)), mandate: m };
}
