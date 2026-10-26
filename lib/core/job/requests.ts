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

import { ASSISTANTS_SCOPE, ASSISTANT_SCOPE_PREFIX, INBOX_SCOPE, MAX_ASSISTANTS, OFFICE_SCOPE, REQUEST_TYPES } from '#api/constants.ts';

export { ASSISTANTS_SCOPE, ASSISTANT_SCOPE_PREFIX, INBOX_SCOPE, JOBS_SCOPE, MAX_ASSISTANTS, OFFICE_SCOPE, REQUEST_TYPES } from '#api/constants.ts';

/** Request types that act on one job, so they need one and route to that job's daemon session. */
const JOB_REQUEST_TYPES = ['approve', 'revise-spec', 'rework', 'answer', 'cancel', 'resume'] as const;

/** Carries a daemon session's scope into its environment; never stdin or argv. */
export const SCOPE_ENV = 'FORGE_DAEMON_SCOPE';
export const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_JOB_ID = 200;

/** A syntactically valid job id: safe to build a path or an env value from. */
export function validJobId(s: unknown): s is string {
  return typeof s === 'string' && s.length <= MAX_JOB_ID && JOB_ID.test(s);
}

/** `_assistant-1` … `_assistant-16`: no leading zero and nothing after the digits, so no path or meter file is built from a forged one. */
const ASSISTANT_SCOPE = /^_assistant-([1-9]|1[0-6])$/;

/** An assistant foreman session's scope. */
export function isAssistantScope(s: unknown): s is string {
  return typeof s === 'string' && ASSISTANT_SCOPE.test(s);
}

/** The scope of assistant foreman `n`, 1 to MAX_ASSISTANTS. */
export function assistantScope(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > MAX_ASSISTANTS) throw new ForgeError(`assistant foreman ${n} is outside 1-${MAX_ASSISTANTS}`);
  return `${ASSISTANT_SCOPE_PREFIX}${n}`;
}

/** Not a job's scope: the inbox, the office, the gate group or an assistant foreman. Never counted against a cap, never leased. */
export function sharedScope(s: unknown): boolean {
  return s === INBOX_SCOPE || s === OFFICE_SCOPE || s === ASSISTANTS_SCOPE || isAssistantScope(s);
}

/** Whether a session in `sessionScope` takes a request routed to `routed`: its own, or the gate group for an assistant foreman. */
export function servesScope(sessionScope: string, routed: string): boolean {
  return sessionScope === routed || (isAssistantScope(sessionScope) && routed === ASSISTANTS_SCOPE);
}

/** Syntax only: the inbox, the office, an assistant foreman or a valid job id (never the gate group). Existence is requestScope's business. */
export function validScope(s: unknown): s is string {
  return s === INBOX_SCOPE || s === OFFICE_SCOPE || isAssistantScope(s) || validJobId(s);
}

/**
 * Which daemon session a request belongs to: the assistant foremen's group for a gate, its job's for a job request
 * whose job exists, the inbox for everything else (which rejects malformed or unknown jobs per the skill).
 */
export function requestScope(root: string, rec: { type?: unknown; job?: unknown }): string {
  if (rec?.type === 'gate') return ASSISTANTS_SCOPE;
  if (!(JOB_REQUEST_TYPES as readonly unknown[]).includes(rec?.type) || !validJobId(rec.job)) return INBOX_SCOPE;
  return exists(path.join(paths(root).jobs, rec.job, 'job.json')) ? rec.job : INBOX_SCOPE;
}

/** The scope a `forge` call runs in: none outside a daemon session, else FORGE_DAEMON_SCOPE, checked. */
export function daemonScope(env: NodeJS.ProcessEnv = process.env): { daemon: false; scope: null } | { daemon: true; scope: string } | { problem: string } {
  if (env.FORGE_DAEMON !== '1') return { daemon: false, scope: null };
  const scope = env[SCOPE_ENV];
  if (!validScope(scope)) return { problem: `forge refuses: ${SCOPE_ENV} is missing or invalid in this daemon session` };
  return { daemon: true, scope };
}

/** The daemon scope this call runs in is the office session. */
export function inOffice(env: NodeJS.ProcessEnv = process.env): boolean {
  const s = daemonScope(env);
  return 'daemon' in s && s.daemon && s.scope === OFFICE_SCOPE;
}

/** The daemon scope this call runs in is an assistant foreman session. */
export function inAssistant(env: NodeJS.ProcessEnv = process.env): boolean {
  const s = daemonScope(env);
  return 'daemon' in s && s.daemon && isAssistantScope(s.scope);
}

function dir(root: string): string {
  return path.join(paths(root).runtime, 'requests');
}

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
  if (req.type === 'gate' && !validJobId(req.job)) throw new ForgeError('a gate request needs a valid job');
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

function requestFile(root: string, id: string): string {
  if (typeof id !== 'string' || !REQUEST_ID.test(id)) throw new ForgeError(`invalid request id ${JSON.stringify(String(id).slice(0, 80))}`);
  return path.join(dir(root), `${id}.json`);
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
