import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The CLI's error codes and the exit each one fixes (docs/CLI.md "Error codes"). Scripts branch on
 * these, so renaming or removing one is a breaking change.
 */
export const ERROR_CODES = { failed: 1, not_found: 1, internal: 1, usage: 2, unknown_command: 2, not_initialized: 2, not_a_repo: 2, config_invalid: 2, owned: 3, blocked: 4, external: 5 } as const;
export type ErrorCode = keyof typeof ERROR_CODES;
export type ExitCode = (typeof ERROR_CODES)[ErrorCode];
/** The code a bare exit number means, so `new ForgeError(msg, 3)` written before codes existed keeps working. */
export const DEFAULT_CODE: Record<ExitCode, ErrorCode> = { 1: 'failed', 2: 'usage', 3: 'owned', 4: 'blocked', 5: 'external' };

export class ForgeError extends Error {
  // `declare` keeps these types only: a plain field would become a runtime class field and show up in Object.keys.
  declare code: ErrorCode;
  declare exitCode: ExitCode;
  /** A next command to run, shown under `--json`; null when the message says it all. */
  declare hint: string | null;
  constructor(message: string, code: ErrorCode | ExitCode = 'failed', hint: string | null = null) {
    super(message);
    this.code = typeof code === 'number' ? (DEFAULT_CODE[code] ?? 'failed') : code;
    this.exitCode = ERROR_CODES[this.code];
    this.hint = hint;
  }
}

export const now = (): string => new Date().toISOString();

/**
 * A branch or job name that is safe as one shell word and as a git argument: no metacharacters,
 * no whitespace, and no leading `-` that git would read as an option.
 */
export const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** `value` when it matches SAFE_REF; otherwise a one-line ForgeError naming `field`. */
export function assertSafeRef(value: unknown, field: string): string {
  if (typeof value === 'string' && SAFE_REF.test(value)) return value;
  const shown = (JSON.stringify(value) ?? String(value)).slice(0, 80);
  throw new ForgeError(`${field} ${shown} is not a safe branch name: it must start with a letter or digit and use only A-Z a-z 0-9 . _ / - (at most 200 characters)`);
}

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
    throw new ForgeError(`${cmd} failed to start: ${res.error.message}`, 'external');
  }
  const out = { ok: res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status };
  if (!out.ok && !opts.allowFail) {
    throw new ForgeError(`${cmd} ${args.join(' ')} exited ${res.status}: ${(out.stderr || out.stdout).trim()}`, 'external');
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

/**
 * Interprets CLI values so `--field round=2` stores a number, not "2". A `[`/`{` value that is not
 * JSON is almost always one whose quotes the shell stripped, so it fails rather than being stored
 * as a string that crashes `forge job step` later.
 */
export function coerce(v: string, key = 'value'): any {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^[\[{]/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      const bare = /^\[([^"\[\]{}]*)\]$/.exec(v);
      const suggestion = bare
        ? JSON.stringify(bare[1].split(',').map((s) => s.trim()).filter(Boolean))
        : v.startsWith('[') ? '["a","b"]' : '{"k":"v"}';
      throw new ForgeError(`--field ${key}: ${JSON.stringify(v.slice(0, 80))} is not valid JSON; quote it for the shell, e.g. --field '${key}=${suggestion}'`, 'usage');
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
