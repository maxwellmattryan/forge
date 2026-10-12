// @ts-check
// A small file-based inbox. The dashboard (or anything else) drops requests here; the
// orchestrator drains them at the start of each pass. The dashboard never runs agents itself
// unless the repo opts into a launcher, so cost and permissions stay with the human's session.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths, exists } from './paths.mjs';
import { ForgeError, fill, now, readJson, shortId, withLock, writeJsonAtomic } from './util.mjs';

export const REQUEST_TYPES = ['next', 'run', 'approve', 'revise-spec', 'rework', 'answer', 'cancel', 'resume', 'sync', 'eval-run', 'retro'];

/** @param {string} root */
function dir(root) {
  return path.join(paths(root).runtime, 'requests');
}

/**
 * @param {string} root @param {any} config
 * @param {{type:string, job?:string|null, text?:string|null, args?:Record<string, any>, from?:string}} req
 */
export function enqueue(root, config, req) {
  if (!REQUEST_TYPES.includes(req.type)) throw new ForgeError(`unknown request type "${req.type}"`);
  if (['approve', 'revise-spec', 'rework', 'answer', 'cancel', 'resume'].includes(req.type) && !req.job)
    throw new ForgeError(`request "${req.type}" needs a job`);
  const id = `${Date.now()}-${shortId()}`;
  const rec = {
    id,
    type: req.type,
    job: req.job ?? null,
    text: req.text ? String(req.text).slice(0, 8000) : null,
    args: req.args ?? {},
    from: req.from ?? 'cli',
    status: 'pending',
    createdAt: now(),
  };
  writeJsonAtomic(path.join(dir(root), `${id}.json`), rec);
  const launched = launch(root, config, rec);
  return { ...rec, launched };
}

/** @param {string} root @param {{status?:string}} [opts] */
export function listRequests(root, opts = {}) {
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

/** @param {string} root */
const lockDir = (root) => path.join(paths(root).locks, 'requests');

/**
 * Two orchestrator sessions drain the same inbox, so a request is claimed under a lock before
 * anything acts on it. The second claimant is refused (exit 3) while the first is live.
 * @param {string} root @param {string} id @param {string} session @param {boolean} [force]
 */
export function claimRequest(root, id, session, force = false) {
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

/** @param {string} root @param {string} id @param {{status:'done'|'rejected'|'in-progress', result?:string}} update */
export function ackRequest(root, id, update) {
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

/**
 * Opt-in: `dashboard.launcher` is a shell template (with {prompt}) that starts a headless
 * orchestrator session to drain the inbox, e.g. a non-interactive agent CLI invocation.
 * @param {string} root @param {any} config @param {any} rec
 */
function launch(root, config, rec) {
  const template = config.dashboard?.launcher;
  if (!template) return false;
  const prompt = '/forge requests';
  const cmd = fill(template, { prompt: JSON.stringify(prompt).slice(1, -1), root });
  const logFile = path.join(paths(root).runtime, 'launcher.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  fs.writeSync(fd, `\n[${now()}] request ${rec.id} (${rec.type}) → ${cmd}\n`);
  const child = spawn(process.env.SHELL || '/bin/sh', ['-lc', cmd], { cwd: root, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  return true;
}
