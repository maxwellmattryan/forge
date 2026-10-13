import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export class ForgeError extends Error {
  // `declare` keeps this a type only: a plain field would become a runtime class field and show up in Object.keys.
  declare exitCode: number;
  constructor(message: string, code: number = 1) {
    super(message);
    this.exitCode = code;
  }
}

export const now = (): string => new Date().toISOString();

/**
 * Runs a binary without a shell so arguments can never be reinterpreted.
 */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; input?: string; allowFail?: boolean; env?: NodeJS.ProcessEnv } = {},
): { ok: boolean; stdout: string; stderr: string; status: number | null } {
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

export function hasBinary(cmd: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function readJson(file: string, fallback?: any): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined && (e as any).code === 'ENOENT') return fallback;
    throw new ForgeError(`cannot read ${file}: ${(e as Error).message}`);
  }
}

/**
 * Write-then-rename so readers (the dashboard, other sessions) never see a half-written file.
 */
export function writeJsonAtomic(file: string, data: any): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function writeTextAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function readText(file: string, fallback = ''): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

/**
 * mkdir is atomic on every filesystem we care about, which makes it a portable lock primitive
 * across concurrent Forge sessions on one machine.
 */
export function withLock<T>(lockDir: string, fn: () => T, opts: { timeoutMs?: number; staleMs?: number } = {}): T {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 60_000;
  const start = Date.now();
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (e) {
      if ((e as any).code !== 'EEXIST') throw e;
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

export function slugify(text: string, maxWords = 6): string {
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

export function shortId(): string {
  return Math.random().toString(36).slice(2, 6);
}

export function deepMerge<T extends Record<string, any>>(target: T, src: Record<string, any>): T {
  if (!src || typeof src !== 'object') return target;
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      (target as Record<string, any>)[k] = v;
    }
  }
  return target;
}

export function getPath(obj: any, dotted: string): any {
  if (!dotted) return obj;
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj: any, dotted: string, value: any): void {
  const keys = dotted.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
}

/** Interprets CLI values so `--field round=2` stores a number, not "2". */
export function coerce(v: string): any {
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

/**
 * Splits a command template into argv the way a POSIX shell splits words, without any of the
 * shell's other powers: whitespace separates, '…' is literal, "…" honours \" and \\.
 * `label` names the setting in errors.
 */
export function splitWords(template: string, label = 'command'): string[] {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (/\s/.test(c)) {
      if (inWord) out.push(cur);
      cur = '';
      inWord = false;
    } else if (c === "'") {
      const end = template.indexOf("'", i + 1);
      if (end === -1) throw new ForgeError(`${label}: unterminated ' in ${JSON.stringify(template)}`);
      cur += template.slice(i + 1, end);
      i = end;
      inWord = true;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < template.length && template[j] !== '"'; j++) {
        if (template[j] === '\\' && (template[j + 1] === '"' || template[j + 1] === '\\')) j++;
        cur += template[j];
      }
      if (j >= template.length) throw new ForgeError(`${label}: unterminated " in ${JSON.stringify(template)}`);
      i = j;
      inWord = true;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) out.push(cur);
  return out;
}

/**
 * The daemon's executable: a bare `claude` (found on PATH) or an absolute path to one. Relative
 * paths are refused because the child runs with the repo as cwd, where they would name repo files.
 * This catches mistakes such as a migrated shell template; it is not a security boundary (see
 * docs/ARCHITECTURE.md "Daemon security").
 */
export function isClaudeExecutable(word: string): boolean {
  if (/^claude(?:\.exe)?$/.test(word)) return true;
  return path.isAbsolute(word) && /[\\/]claude(?:\.exe)?$/.test(word);
}

export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export function tail(text: string, n: number): string {
  const lines = text.trimEnd().split('\n');
  return lines.slice(-n).join('\n');
}
