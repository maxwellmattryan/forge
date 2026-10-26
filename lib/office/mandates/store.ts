// Mandate files: `.forge/runtime/mandates/<id>.md`, YAML frontmatter then the owner's guidance. Read
// without following a link or blocking on a FIFO, and written under one lock only through mandateWrite
// (`forge mandate new|edit|pause|resume|close` and the dashboard's Foreman page, the same checks for
// both) and by the Office pass (`forge office pass`, which pauses and closes). Read for a job whose
// `mandate` is set to narrow what the Foreman decides (jobMandateDecides). A mandate's runtime dir `<id>/`
// beside it holds its drafting runs' files (draft.ts, intake.ts), its board and its closing summary
// (pass.ts, director.ts). docs/architecture/foreman.md.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '#core/paths.ts';
import { ForgeError } from '#core/errors.ts';
import { listJobs, logRepoEvent } from '#core/job/store.ts';
import { readRegular, writeTextAtomic } from '#core/os/fs.ts';
import { withLock, withLockAsync } from '#core/os/lock.ts';
import { now } from '#core/utils.ts';
import * as yaml from '#core/format/yaml.ts';
import { currentActor } from '#integrations/github/actor.ts';
import { decides } from '#engine/pipeline/moves/foreman-gates.ts';
import { MANDATE_ID, MANDATE_KEYS, applyInput, blankMandate, cleanReason, fillDefaults, isMandateId, isReadable, issueRefs, mandateProblems, storedMandate } from './contract.ts';
import type { Config, EventActor, GateClass, Job } from '#core/types.ts';
import type { Mandate, MandateInput, ReadMandate } from './types.ts';

export { MANDATE_ID };

/** A mandate file is a short contract and at most 8000 characters of guidance: anything larger is not one. */
const MAX_BYTES = 64 * 1024;

/** The audit actions a mandate write logs, as `mandate-<action>`; `filed` is a goal mandate's draft filed (filing.ts). */
export type MandateAction = 'new' | 'edit' | 'pause' | 'resume' | 'close' | 'filed';

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
    writeTextAtomic(fileOf(root, m.id), render(m), { root });
    logRepoEvent(root, `mandate-${action}`, { mandate: m.id, ...(reason ? { reason } : {}), actor: out.actor ?? currentActor(root) });
    return out;
  });
}

/** The owner's mandate writes: `forge mandate <op>` and the Foreman page's POSTs. */
export type MandateOp = 'new' | 'edit' | 'pause' | 'resume' | 'close';

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

/**
 * The one owner's mandate write, for the CLI and the dashboard: under the mandates lock, every check
 * before the write, so a refusal (a ForgeError: not_found, or exit 1 with every problem joined by `; `)
 * writes no file and no audit line. `new` takes every term not given from foreman.mandate; `edit` replaces
 * only the terms given, and with `updatedAt` refuses once the stored mandate has moved on (a CLI edit or a
 * pass pause in between); the status moves are idempotent. `changed` is false when nothing was written.
 */
export function mandateWrite(
  root: string,
  config: Config,
  op: MandateOp,
  id: string,
  o: { input?: MandateInput; reason?: string | null; updatedAt?: string; actor?: EventActor } = {},
): { changed: boolean } {
  const actor = o.actor ? { actor: o.actor } : {};
  const input = o.input ?? {};
  const out = writeMandate(root, (all) => {
    if (op === 'new') {
      if (all.some((m) => m.id === id)) throw new ForgeError(`mandate ${id} exists; change it with forge mandate edit`, 1);
      const refs = issueRefs(root, config, fillDefaults(config, input));
      const m = applyInput(blankMandate(id, now()), refs.input);
      const problems = [...refs.problems, ...mandateProblems(config, m, all, null)];
      if (problems.length) throw new ForgeError(problems.join('; '), 1);
      return { mandate: m, action: 'new' as MandateAction, ...actor };
    }
    const existing = mandateTarget(all, id);
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
  return { changed: out !== null };
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
