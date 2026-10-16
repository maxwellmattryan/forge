// A small file-based inbox. The dashboard (or anything else) drops requests here; an
// orchestrator session drains them: the human's own (`/forge requests`) or, with
// `daemon.enabled`, the headless one `forge dash` supervises (lib/daemon.ts). Enqueueing only
// writes a file, so nothing here starts a process.
import fs from 'node:fs';
import path from 'node:path';
import { paths, exists } from './paths.ts';
import type { ForgeRequest } from './types.ts';
import { ForgeError, now, readJson, shortId, withLock, writeJsonAtomic } from './util.ts';

export const REQUEST_TYPES = ['next', 'run', 'approve', 'revise-spec', 'rework', 'answer', 'cancel', 'resume', 'sync', 'eval-run', 'retro', 'gate'] as const;

/** Request types that act on one job, so they need one and route to that job's daemon session. */
export const JOB_REQUEST_TYPES = ['approve', 'revise-spec', 'rework', 'answer', 'cancel', 'resume'] as const;

/**
 * The daemon session for requests without a (valid, existing) job. Job ids start with an
 * alphanumeric, so it can never be one.
 */
export const INBOX_SCOPE = '_inbox';
/** The foreman's daemon session: it receives every `gate` request and never drives a job. */
export const OFFICE_SCOPE = '_office';
/** Carries a daemon session's scope into its environment; never stdin or argv. */
export const SCOPE_ENV = 'FORGE_DAEMON_SCOPE';
export const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_JOB_ID = 200;

/** A syntactically valid job id: safe to build a path or an env value from. */
export function validJobId(s: unknown): s is string {
  return typeof s === 'string' && s.length <= MAX_JOB_ID && JOB_ID.test(s);
}

/** Syntax only: the inbox, the office or a valid job id. Existence is requestScope's business. */
export function validScope(s: unknown): s is string {
  return s === INBOX_SCOPE || s === OFFICE_SCOPE || validJobId(s);
}

/**
 * Which daemon session a request belongs to: the office for a gate, its job's for a job request
 * whose job exists, the inbox for everything else (which rejects malformed or unknown jobs per the skill).
 */
export function requestScope(root: string, rec: { type?: unknown; job?: unknown }): string {
  if (rec?.type === 'gate') return OFFICE_SCOPE;
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
export const REQUEST_ID = /^\d+-[A-Za-z0-9]+$/;

function requestFile(root: string, id: string): string {
  if (typeof id !== 'string' || !REQUEST_ID.test(id)) throw new ForgeError(`invalid request id ${JSON.stringify(String(id).slice(0, 80))}`);
  return path.join(dir(root), `${id}.json`);
}

/** A claim older than this with no ack is presumed abandoned (its session died) and can be retaken. */
const CLAIM_STALE_MS = 30 * 60 * 1000;

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
