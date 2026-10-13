// A small file-based inbox. The dashboard (or anything else) drops requests here; an
// orchestrator session drains them: the human's own (`/forge requests`) or, with
// `daemon.enabled`, the headless one `forge dash` supervises (lib/daemon.ts). Enqueueing only
// writes a file, so nothing here starts a process.
import fs from 'node:fs';
import path from 'node:path';
import { paths, exists } from './paths.ts';
import type { ForgeRequest } from './types.ts';
import { ForgeError, now, readJson, shortId, withLock, writeJsonAtomic } from './util.ts';

export const REQUEST_TYPES = ['next', 'run', 'approve', 'revise-spec', 'rework', 'answer', 'cancel', 'resume', 'sync', 'eval-run', 'retro'] as const;

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
  if (['approve', 'revise-spec', 'rework', 'answer', 'cancel', 'resume'].includes(req.type) && !req.job)
    throw new ForgeError(`request "${req.type}" needs a job`);
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

/** A claim older than this with no ack is presumed abandoned (its session died) and can be retaken. */
const CLAIM_STALE_MS = 30 * 60 * 1000;

const lockDir = (root: string): string => path.join(paths(root).locks, 'requests');

/**
 * Two orchestrator sessions drain the same inbox, so a request is claimed under a lock before
 * anything acts on it. The second claimant is refused (exit 3) while the first is live.
 */
export function claimRequest(root: string, id: string, session: string, force = false): ForgeRequest {
  const file = path.join(dir(root), `${id}.json`);
  if (!exists(file)) throw new ForgeError(`no request ${id}`);
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
  const file = path.join(dir(root), `${id}.json`);
  if (!exists(file)) throw new ForgeError(`no request ${id}`);
  return withLock(lockDir(root), () => {
    const rec = readJson(file);
    rec.status = update.status;
    rec.result = update.result ?? null;
    rec.updatedAt = now();
    writeJsonAtomic(file, rec);
    return rec;
  });
}
