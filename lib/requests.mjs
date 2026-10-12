// @ts-check
// A small file-based inbox. The dashboard (or anything else) drops requests here; the
// orchestrator drains them at the start of each pass. The dashboard never runs agents itself
// unless the repo opts into a launcher, so cost and permissions stay with the human's session.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths, exists } from './paths.mjs';
import { FactoryError, fill, now, readJson, shortId, writeJsonAtomic } from './util.mjs';

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
  if (!REQUEST_TYPES.includes(req.type)) throw new FactoryError(`unknown request type "${req.type}"`);
  if (['approve', 'revise-spec', 'rework', 'answer', 'cancel', 'resume'].includes(req.type) && !req.job)
    throw new FactoryError(`request "${req.type}" needs a job`);
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

/** @param {string} root @param {string} id @param {{status:'done'|'rejected'|'in-progress', result?:string}} update */
export function ackRequest(root, id, update) {
  const file = path.join(dir(root), `${id}.json`);
  if (!exists(file)) throw new FactoryError(`no request ${id}`);
  const rec = readJson(file);
  rec.status = update.status;
  rec.result = update.result ?? null;
  rec.updatedAt = now();
  writeJsonAtomic(file, rec);
  return rec;
}

/**
 * Opt-in: `dashboard.launcher` is a shell template (with {prompt}) that starts a headless
 * orchestrator session to drain the inbox, e.g. a non-interactive agent CLI invocation.
 * @param {string} root @param {any} config @param {any} rec
 */
function launch(root, config, rec) {
  const template = config.dashboard?.launcher;
  if (!template) return false;
  const prompt = '/factory requests';
  const cmd = fill(template, { prompt: JSON.stringify(prompt).slice(1, -1), root });
  const logFile = path.join(paths(root).runtime, 'launcher.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  fs.writeSync(fd, `\n[${now()}] request ${rec.id} (${rec.type}) → ${cmd}\n`);
  const child = spawn(process.env.SHELL || '/bin/sh', ['-lc', cmd], { cwd: root, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  return true;
}
