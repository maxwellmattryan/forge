// A small file-based inbox. The dashboard (or anything else) drops requests here; an
// orchestrator session drains them: the human's own (`/forge requests`) or, with
// `daemon.enabled`, the headless one `forge dash` supervises (lib/office/session/lifecycle.ts). Enqueueing only
// writes a file, so nothing here starts a process.
import fs from 'node:fs';
import path from 'node:path';
import { paths, exists } from '../paths.ts';
import type { ForgeRequest, JobLease } from '../types.ts';
import { ForgeError } from '../errors.ts';
import { readJson, writeJsonAtomic } from '../os/fs.ts';
import { withLock } from '../os/lock.ts';
import { now, shortId } from '../utils.ts';

import { CHAT_SCOPE_PREFIX, GATES_SCOPE, INBOX_SCOPE, MANDATE_ID_SOURCE, OFFICE_SCOPE, REQUEST_TYPES } from '#api/constants.ts';

export { CHAT_SCOPE_PREFIX, GATES_SCOPE, INBOX_SCOPE, JOBS_SCOPE, MAX_GATE_RUNS, OFFICE_SCOPE, REQUEST_TYPES } from '#api/constants.ts';

/** Request types that act on one job, so they need one and route to that job's daemon session. */
export const JOB_REQUEST_TYPES = ['approve', 'revise-spec', 'rework', 'answer', 'cancel', 'resume'] as const;

/** Carries a daemon session's scope into its environment; never stdin or argv. */
export const SCOPE_ENV = 'FORGE_DAEMON_SCOPE';
export const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_JOB_ID = 200;

/** A syntactically valid job id: safe to build a path or an env value from. */
export function validJobId(s: unknown): s is string {
  return typeof s === 'string' && s.length <= MAX_JOB_ID && JOB_ID.test(s);
}

/** A chat's id: 12 lowercase hex characters (crypto.randomBytes(6)), so no path or meter file is built from a forged one. */
export const CHAT_ID = /^[0-9a-f]{12}$/;

/** A chat session's scope: CHAT_SCOPE_PREFIX and a chat id, nothing else. */
export function isChatScope(s: unknown): s is string {
  return typeof s === 'string' && s.startsWith(CHAT_SCOPE_PREFIX) && CHAT_ID.test(s.slice(CHAT_SCOPE_PREFIX.length));
}

/** The session scope of chat `id`. */
export function chatScope(id: string): string {
  if (typeof id !== 'string' || !CHAT_ID.test(id)) throw new ForgeError(`no chat ${JSON.stringify(String(id).slice(0, 40))}`);
  return `${CHAT_SCOPE_PREFIX}${id}`;
}

/** The chat id in a chat scope, or null for any other scope. */
export function chatIdOf(scope: unknown): string | null {
  return isChatScope(scope) ? scope.slice(CHAT_SCOPE_PREFIX.length) : null;
}

/** Not a job's scope: the inbox, the office, the gate group or a chat. Never counted against a cap, never leased. */
export function sharedScope(s: unknown): boolean {
  return s === INBOX_SCOPE || s === OFFICE_SCOPE || s === GATES_SCOPE || isChatScope(s);
}

/** Whether a session in `sessionScope` takes a request routed to `routed`: only its own. No session serves the gate group. */
export function servesScope(sessionScope: string, routed: string): boolean {
  return sessionScope === routed;
}

/** Syntax only: the inbox, the office, a chat or a valid job id (never the gate group). Existence is requestScope's business. */
export function validScope(s: unknown): s is string {
  return s === INBOX_SCOPE || s === OFFICE_SCOPE || isChatScope(s) || validJobId(s);
}

/**
 * A legacy assistant foreman's scope, `_assistant-1` … `_assistant-16` (no leading zero, nothing after the digits),
 * only so meter files written before gate runs stay readable: no session runs in one.
 */
export const LEGACY_ASSISTANT_SCOPE = /^_assistant-([1-9]|1[0-6])$/;

/**
 * A scope a runtime file (a meter file, a log) may be named after: a session scope, the gate runs' `_gates`, or a
 * legacy assistant scope whose meter file still counts in the ledger. Never a session's scope: validScope is.
 */
export function validRuntimeScope(s: unknown): s is string {
  return validScope(s) || s === GATES_SCOPE || (typeof s === 'string' && LEGACY_ASSISTANT_SCOPE.test(s));
}

/** The Foreman's authority: a capability object only forge dash's gate runner holds. No argv, env or file can produce one. */
export interface ForemanAuthority {
  readonly kind: 'foreman-authority';
}

const AUTHORITIES = new WeakSet<object>();

/** What every foreman decision, release approval, milestone-draft decision or hand-off without the authority is refused with. */
export const FOREMAN_AUTHORITY_REFUSAL = "only the Foreman's gate runner in forge dash records foreman decisions";

/**
 * A new authority object, for lib/office/foreman/run.ts alone: the CLI never calls it, so no `forge` command, in any
 * scope, can record a foreman decision. A hostile local process could import this module itself; the line guards a misled model.
 */
export function issueForemanAuthority(): ForemanAuthority {
  const a: ForemanAuthority = Object.freeze({ kind: 'foreman-authority' as const });
  AUTHORITIES.add(a);
  return a;
}

/** Whether `v` is an authority issueForemanAuthority made: a lookalike object, or anything parsed from text, never is. */
export function holdsForemanAuthority(v: unknown): v is ForemanAuthority {
  return typeof v === 'object' && v !== null && AUTHORITIES.has(v);
}

/**
 * Which daemon session a request belongs to: the gate group for a gate (no session: forge dash's gate runner takes
 * them), the office for a draft or a direct (the Office pass's wake), its job's for a job request whose job exists,
 * the inbox for everything else (which rejects malformed or unknown jobs per the skill).
 */
export function requestScope(root: string, rec: { type?: unknown; job?: unknown }): string {
  if (rec?.type === 'gate') return GATES_SCOPE;
  if (rec?.type === 'draft' || rec?.type === 'direct') return OFFICE_SCOPE;
  if (!(JOB_REQUEST_TYPES as readonly unknown[]).includes(rec?.type) || !validJobId(rec.job)) return INBOX_SCOPE;
  return exists(path.join(paths(root).jobs, rec.job, 'job.json')) ? rec.job : INBOX_SCOPE;
}

/** The scope a `forge` call runs in: none outside a daemon session, else FORGE_DAEMON_SCOPE, checked. */
export function daemonScope(env: NodeJS.ProcessEnv = process.env): { daemon: false; scope: null } | { daemon: true; scope: string } | { problem: string } {
  if (env.FORGE_DAEMON !== '1') return { daemon: false, scope: null };
  const scope = env[SCOPE_ENV];
  // A gate run's assistant reads files and writes feedback.md; it has no Bash, and no forge call it could make is answered.
  if (scope === GATES_SCOPE) return { problem: "forge refuses: a gate run's assistant runs no forge commands" };
  if (!validScope(scope)) return { problem: `forge refuses: ${SCOPE_ENV} is missing or invalid in this daemon session` };
  return { daemon: true, scope };
}

/** The daemon scope this call runs in is the office session. */
export function inOffice(env: NodeJS.ProcessEnv = process.env): boolean {
  const s = daemonScope(env);
  return 'daemon' in s && s.daemon && s.scope === OFFICE_SCOPE;
}

/** The daemon scope this call runs in is a chat session. */
export function inChat(env: NodeJS.ProcessEnv = process.env): boolean {
  const s = daemonScope(env);
  return 'daemon' in s && s.daemon && isChatScope(s.scope);
}

function dir(root: string): string {
  return path.join(paths(root).runtime, 'requests');
}

const MANDATE_ID = new RegExp(MANDATE_ID_SOURCE);
/** A mandate id as a request's `args.mandate`: the id grammar, and never `none`. */
export const isMandateIdArg =(v: unknown): v is string => typeof v === 'string' && MANDATE_ID.test(v) && v !== 'none';
/** The gate classes a job-less gate request may carry: a mandate's, never a job's. */
const MANDATE_GATES = ['milestone-approval', 'release'] as const;

/**
 * `_config` is kept so callers need not change.
 */
export function enqueue(
  root: string,
  _config: any,
  req: { type: string; job?: string | null; text?: string | null; args?: Record<string, any>; from?: string },
): ForgeRequest {
  if (!(REQUEST_TYPES as readonly string[]).includes(req.type)) throw new ForgeError(`unknown request type "${req.type}"`);
  if ((JOB_REQUEST_TYPES as readonly string[]).includes(req.type) && !req.job)
    throw new ForgeError(`request "${req.type}" needs a job`);
  // A goal mandate's milestone draft and an `until: released` mandate's release plan are the gates no job
  // waits on: job-less, with a valid mandate id instead.
  const mandateGate =
    req.type === 'gate' && (req.job === null || req.job === undefined) && (MANDATE_GATES as readonly unknown[]).includes(req.args?.gate) && isMandateIdArg(req.args?.mandate);
  if (req.type === 'gate' && !mandateGate && !validJobId(req.job)) throw new ForgeError('a gate request needs a valid job');
  // The inbox puts a mandate retro's `args.mandate` on a `forge retro prepare --mandate` command line.
  if (req.type === 'retro' && req.args?.mandate !== undefined && !isMandateIdArg(req.args.mandate)) throw new ForgeError("a retro request's args.mandate must be a mandate id");
  const id = `${Date.now()}-${shortId()}`;
  const rec: ForgeRequest = {
    id,
    // Validated against REQUEST_TYPES above.
    type: req.type as ForgeRequest['type'],
    job: req.job ?? null,
    text: req.text ? String(req.text).slice(0, 8000) : null,
    args: req.args ?? {},
    from: req.from ?? 'cli',
    status: 'pending',
    createdAt: now(),
  };
  writeJsonAtomic(path.join(dir(root), `${id}.json`), rec);
  return rec;
}

export function listRequests(root: string, opts: { status?: string } = {}): ForgeRequest[] {
  const d = dir(root);
  if (!exists(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(d, f), null))
    .filter((r) => r && (!opts.status || r.status === opts.status))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** enqueue's `<Date.now()>-<shortId()>`. Checked before any path is built from an id. */
const REQUEST_ID = /^\d+-[A-Za-z0-9]+$/;

/** A request id in enqueue's grammar: safe to build a path or an argv element from. */
export const validRequestId = (s: unknown): s is string => typeof s === 'string' && s.length <= 80 && REQUEST_ID.test(s);

function requestFile(root: string, id: string): string {
  if (!validRequestId(id)) throw new ForgeError(`invalid request id ${JSON.stringify(String(id).slice(0, 80))}`);
  return path.join(dir(root), `${id}.json`);
}

/** Request `id` as stored, or null when it is missing or unreadable; an id outside the grammar throws before any path is built. */
export function readRequest(root: string, id: string): ForgeRequest | null {
  const file = requestFile(root, id);
  if (!exists(file)) return null;
  try {
    const rec = readJson(file, null);
    return rec && typeof rec === 'object' ? (rec as ForgeRequest) : null;
  } catch {
    return null;
  }
}

/** A claim older than this with no ack is presumed abandoned (its session died) and can be retaken. */
const CLAIM_STALE_MS = 30 * 60 * 1000;

/** The result a request gets when its session ends under it a second time: it is not tried a third. */
export const REQUEUE_REJECTED = 'its session ended twice while handling it';

const lockDir = (root: string): string => path.join(paths(root).locks, 'requests');

/**
 * Two orchestrator sessions drain the same inbox, so a request is claimed under a lock before
 * anything acts on it. The second claimant is refused (exit 3) while the first is live.
 */
export function claimRequest(root: string, id: string, session: string, force = false): ForgeRequest {
  const file = requestFile(root, id);
  if (!exists(file)) throw new ForgeError(`no request ${id}`, 'not_found');
  return withLock(lockDir(root), () => {
    const rec = readJson(file);
    if (['done', 'rejected'].includes(rec.status)) throw new ForgeError(`request ${id} is already ${rec.status}`);
    const live = rec.status === 'in-progress' && rec.session && rec.session !== session && Date.now() - Date.parse(rec.updatedAt ?? rec.createdAt) < CLAIM_STALE_MS;
    if (live && !force) throw new ForgeError(`request ${id} is being handled by session ${rec.session}; pass --force to take over`, 3);
    rec.status = 'in-progress';
    rec.session = session;
    rec.updatedAt = now();
    writeJsonAtomic(file, rec);
    return rec;
  });
}

/**
 * Returns `in-progress` requests whose session is gone to `pending`, so the next session picks them
 * up with no person pressing Resume. A request's session is gone when (a) it routes to a job whose
 * lease that session holds and the lease has expired, (b) the caller saw that session exit
 * (`exited`: the supervisor on a child's exit, the pool at boot), or (c) neither lease rule covers
 * it and its claim is older than CLAIM_STALE_MS (inbox, office and job-less requests, or a job
 * another session drives). Rule (c) never touches a claim of a session in `busy` (forge dash's
 * sessions mid-turn: a turn may run past CLAIM_STALE_MS, up to daemon.turnTimeoutMinutes), and is
 * off with `byAge: false` (a caller that can't see the dash's sessions while one runs). A request
 * requeued once before is rejected instead, so one that kills its session can't loop. `leaseOf`
 * reads a job's lease (lib/core/job/store.ts), which this module must not import; `note` logs on the
 * request's job after the lock is released.
 */
export function requeueOrphans(
  root: string,
  opts: {
    leaseOf: (jobId: string) => JobLease | null;
    at?: number;
    exited?: readonly string[];
    busy?: readonly string[];
    byAge?: boolean;
    note?: (job: string, text: string) => void;
  },
): { requeued: ForgeRequest[]; rejected: ForgeRequest[] } {
  const at = opts.at ?? Date.now();
  const exited = new Set(opts.exited ?? []);
  const busy = new Set(opts.busy ?? []);
  const byAge = opts.byAge !== false;
  const requeued: ForgeRequest[] = [];
  const rejected: ForgeRequest[] = [];
  if (!listRequests(root, { status: 'in-progress' }).length) return { requeued, rejected };
  withLock(lockDir(root), () => {
    for (const rec of listRequests(root, { status: 'in-progress' })) {
      if (!REQUEST_ID.test(String(rec.id))) continue;
      const scope = requestScope(root, rec);
      const lease = sharedScope(scope) ? null : opts.leaseOf(scope);
      const leased = Boolean(lease?.driver && rec.session && lease.driver === rec.session);
      const expired = leased && !(Date.parse(lease!.expiresAt ?? '') > at);
      const claimed = Date.parse(rec.updatedAt ?? rec.createdAt);
      const stale = byAge && !leased && !(rec.session && busy.has(rec.session)) && !(at - claimed < CLAIM_STALE_MS);
      if (!expired && !stale && !(rec.session && exited.has(rec.session))) continue;
      const again = (Number.isSafeInteger(rec.requeues) ? rec.requeues! : 0) >= 1;
      const next: ForgeRequest = again
        ? { ...rec, status: 'rejected', result: REQUEUE_REJECTED, updatedAt: new Date(at).toISOString() }
        : { ...rec, status: 'pending', requeues: (Number.isSafeInteger(rec.requeues) ? rec.requeues! : 0) + 1, updatedAt: new Date(at).toISOString() };
      delete next.session;
      writeJsonAtomic(requestFile(root, rec.id), next);
      (again ? rejected : requeued).push(next);
    }
  });
  for (const r of requeued) if (validJobId(r.job)) opts.note?.(r.job, `request ${r.id} (${r.type}) is pending again: the session handling it ended`);
  for (const r of rejected) if (validJobId(r.job)) opts.note?.(r.job, `request ${r.id} (${r.type}) rejected: ${REQUEUE_REJECTED}`);
  return { requeued, rejected };
}

/**
 * Gives a claim back without counting it: back to `pending` only while `session` still holds it in progress,
 * `requeues` untouched. For a run that ended through no fault of the request (a usage limit, a pool stop).
 * False when the claim is no longer that session's.
 */
export function releaseClaim(root: string, id: string, session: string): boolean {
  const file = requestFile(root, id);
  if (!exists(file)) return false;
  return withLock(lockDir(root), () => {
    const rec = readJson(file, null);
    if (!rec || rec.status !== 'in-progress' || rec.session !== session) return false;
    rec.status = 'pending';
    delete rec.session;
    rec.updatedAt = now();
    writeJsonAtomic(file, rec);
    return true;
  });
}

/** The result a `resume` gets when its job session's working turn, written for it, ends (lib/office/session/owned.ts takeUp). */
export const RESUME_TAKEN_UP = "its job session's turn took it up";

/**
 * Closes request `id` only while it is still open (`pending` or `in-progress`) and `accept` holds, both read under the
 * requests lock, so a claim or an ack made since the caller looked is never overwritten. The engine's own close, never
 * an agent's: `session` is dropped, nothing but `status`, `result` and `updatedAt` is written. Returns the written
 * record, or null (nothing written) for an invalid id, a missing or unreadable file, a closed request or a refused one.
 */
export function closeIfOpen(root: string, id: string, accept: (rec: ForgeRequest) => boolean, update: { status: 'done' | 'rejected'; result: string }): ForgeRequest | null {
  if (typeof id !== 'string' || !REQUEST_ID.test(id)) return null;
  const file = requestFile(root, id);
  if (!exists(file)) return null;
  return withLock(lockDir(root), () => {
    let rec: ForgeRequest | null;
    try {
      rec = readJson(file, null);
    } catch {
      return null;
    }
    if (!rec || typeof rec !== 'object' || (rec.status !== 'pending' && rec.status !== 'in-progress') || !accept(rec)) return null;
    const next: ForgeRequest = { ...rec, status: update.status, result: update.result, updatedAt: now() };
    delete next.session;
    writeJsonAtomic(file, next);
    return next;
  });
}

export function ackRequest(root: string, id: string, update: { status: 'done' | 'rejected' | 'in-progress'; result?: string }): ForgeRequest {
  const file = requestFile(root, id);
  if (!exists(file)) throw new ForgeError(`no request ${id}`, 'not_found');
  return withLock(lockDir(root), () => {
    const rec = readJson(file);
    rec.status = update.status;
    rec.result = update.result ?? null;
    rec.updatedAt = now();
    writeJsonAtomic(file, rec);
    return rec;
  });
}
