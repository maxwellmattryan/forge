// @ts-check
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export class ForgeError extends Error {
  /** @param {string} message @param {number} [code] */
  constructor(message, code = 1) {
    super(message);
    this.exitCode = code;
  }
}

export const now = () => new Date().toISOString();

/**
 * Runs a binary without a shell so arguments can never be reinterpreted.
 * @param {string} cmd @param {string[]} args @param {{cwd?:string, input?:string, allowFail?:boolean, env?:NodeJS.ProcessEnv}} [opts]
 * @returns {{ok:boolean, stdout:string, stderr:string, status:number|null}}
 */
export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    if (opts.allowFail) return { ok: false, stdout: '', stderr: String(res.error.message), status: null };
    throw new ForgeError(`${cmd} failed to start: ${res.error.message}`);
  }
  const out = { ok: res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status };
  if (!out.ok && !opts.allowFail) {
    throw new ForgeError(`${cmd} ${args.join(' ')} exited ${res.status}: ${(out.stderr || out.stdout).trim()}`);
  }
  return out;
}

/** @param {string} cmd */
export function hasBinary(cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** @param {string} file @param {any} [fallback] */
export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined && /** @type {any} */ (e).code === 'ENOENT') return fallback;
    throw new ForgeError(`cannot read ${file}: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * Write-then-rename so readers (the dashboard, other sessions) never see a half-written file.
 * @param {string} file @param {any} data
 */
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** @param {string} file @param {string} text */
export function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** @param {string} file */
export function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
/** @param {number} ms */
export function sleepSync(ms) {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

/**
 * mkdir is atomic on every filesystem we care about, which makes it a portable lock primitive
 * across concurrent Forge sessions on one machine.
 * @template T
 * @param {string} lockDir @param {() => T} fn @param {{timeoutMs?:number, staleMs?:number}} [opts]
 * @returns {T}
 */
export function withLock(lockDir, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 60_000;
  const start = Date.now();
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (e) {
      if (/** @type {any} */ (e).code !== 'EEXIST') throw e;
      try {
        const age = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (age > staleMs) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > timeoutMs) throw new ForgeError(`timed out waiting for lock ${lockDir}`);
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

/** @param {string} text @param {number} [maxWords] */
export function slugify(text, maxWords = 6) {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, maxWords)
      .join('-')
      .slice(0, 48)
      .replace(/-+$/, '') || 'job'
  );
}

export function shortId() {
  return Math.random().toString(36).slice(2, 6);
}

/** @param {Record<string, any>} target @param {Record<string, any>} src */
export function deepMerge(target, src) {
  if (!src || typeof src !== 'object') return target;
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

/** @param {any} obj @param {string} dotted */
export function getPath(obj, dotted) {
  if (!dotted) return obj;
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** @param {any} obj @param {string} dotted @param {any} value */
export function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
}

/** Interprets CLI values so `--field round=2` stores a number, not "2". @param {string} v */
export function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^[\[{]/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/** @param {string} template @param {Record<string, string|number>} vars */
export function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** @param {string} text @param {number} n */
export function tail(text, n) {
  const lines = text.trimEnd().split('\n');
  return lines.slice(-n).join('\n');
}
