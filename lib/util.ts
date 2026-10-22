import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The CLI's error codes and the exit each one fixes (docs/CLI.md "Error codes"). Scripts branch on
 * these, so renaming or removing one is a breaking change.
 */
export const ERROR_CODES = { failed: 1, not_found: 1, internal: 1, secret_found: 1, protected_path: 1, interim_stale: 1, release_gate: 1, usage: 2, unknown_command: 2, not_initialized: 2, not_a_repo: 2, config_invalid: 2, owned: 3, stale_epoch: 3, blocked: 4, external: 5, docker_missing: 5, docker_stopped: 5 } as const;
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

export const REDACTED = '[redacted]';

/** `text` with every secret replaced by `[redacted]`. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join(REDACTED);
  return out;
}

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

/** What run() returns. `timedOut` is set only when `timeoutMs` ran out and the child was killed. */
export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
  timedOut?: true;
}

export interface RunOpts {
  cwd?: string;
  input?: string;
  allowFail?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** The arguments error messages name, when `args` starts with a wrapper's own options (lib/git.ts's pins). */
  shownArgs?: string[];
}

/** `<cmd> <first arg> timed out after <n> s`, with the timeout rounded up to whole seconds. */
export function timedOutMessage(cmd: string, args: readonly string[], timeoutMs: number): string {
  return `${[cmd, args[0]].filter(Boolean).join(' ')} timed out after ${Math.ceil(timeoutMs / 1000)} s`;
}

/**
 * Runs a binary without a shell so arguments can never be reinterpreted.
 */
export function run(cmd: string, args: string[], opts: RunOpts = {}): RunResult {
  const shown = opts.shownArgs ?? args;
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeoutMs,
  });
  const code = (res.error as NodeJS.ErrnoException | undefined)?.code;
  // A timeout kills the child and sets res.error (ETIMEDOUT); it is a hang, not a failure to start.
  if (code === 'ETIMEDOUT' && opts.timeoutMs !== undefined) {
    const message = timedOutMessage(cmd, shown, opts.timeoutMs);
    if (opts.allowFail) return { ok: false, stdout: '', stderr: message, status: null, timedOut: true };
    throw new ForgeError(message, 'external');
  }
  // A child that exits before reading its `input` makes spawnSync report EPIPE beside the real exit
  // status (a race under load, not a failure to start): the exit status is the answer.
  const unreadInput = code === 'EPIPE' && res.status !== null;
  if (res.error && !unreadInput) {
    if (opts.allowFail) return { ok: false, stdout: '', stderr: String(res.error.message), status: null };
    throw new ForgeError(`${cmd} failed to start: ${res.error.message}`, 'external');
  }
  const out = { ok: res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status };
  if (!out.ok && !opts.allowFail) {
    throw new ForgeError(`${cmd} ${shown.join(' ')} exited ${res.status}: ${(out.stderr || out.stdout).trim()}`, 'external');
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

/**
 * Where `cmd` would be found on `env.PATH`, by stat and access only (nothing runs, unlike
 * hasBinary). Relative PATH entries are skipped: they would search the cwd, which a checkout controls.
 */
export function findOnPath(cmd: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (!cmd || cmd.includes('/') || cmd.includes('\\') || cmd.includes('\0')) return null;
  const win = platform === 'win32';
  const exts = win ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [];
  const names = win ? [...(path.extname(cmd) ? [cmd] : []), ...exts.map((e) => cmd + e)] : [cmd];
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const n of names) {
      const file = path.join(dir, n);
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (!win) fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {
        // missing or not executable: keep looking
      }
    }
  }
  return null;
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

/** writeJsonAtomic for a file only its owner may read (mode 0600 from creation, never wider): credentials. */
export function writeJsonPrivate(file: string, data: any): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  // `wx` refuses a planted file or symlink at the temp path.
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function writeTextAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Text that came from outside Forge, made safe for one markdown line: control characters,
 * Unicode line separators and backticks go, so it can't break out of its line or a code span.
 */
export function safeText(s: string, max = 200): string {
  return String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029`]/g, '').slice(0, max);
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
 * The process group first (the shell's children keep it alive), then the pid. EPERM counts as
 * dead too: a process we may not signal is not ours, so the pid was reused. Pid 1 is never a
 * process Forge started, and its group signal would be kill(-1), every process we may signal.
 */
export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return false;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 0);
      return true;
    } catch {}
  }
  return false;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch {}
}

/** SIGTERM to `pid`'s group, up to `graceMs` for it to go, then SIGKILL to the group. */
export function killAndWait(pid: number, graceMs: number): void {
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (pidAlive(pid) && Date.now() < deadline) sleepSync(50);
  if (pidAlive(pid)) signalGroup(pid, 'SIGKILL');
}

/** killAndWait without blocking the event loop. */
export async function killAndWaitAsync(pid: number, graceMs: number): Promise<void> {
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (pidAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (pidAlive(pid)) signalGroup(pid, 'SIGKILL');
}

/**
 * Whether `pid` is provably gone: its group and the pid both answer ESRCH. Stricter than pidAlive,
 * for breaking locks: EPERM means a process exists that this one may not signal (another uid, or
 * one outside this sandbox), so it is never proof of death.
 */
function pidGone(pid: number): boolean {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 0);
      return false;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    }
  }
  return true;
}

/** How far a process's start time may be from a recorded one and still be that process (ps reports whole seconds). */
export const START_SLACK_MS = 30_000;

/** `ps -o lstart=`'s format under LC_ALL=C: `Tue Oct 21 09:14:03 2026`. */
const LSTART = /^\s*(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s*$/;

/** When `pid` started, in ms, from `ps -o lstart=`; null on Windows, for a bad pid, or when ps fails or prints something else. */
export function processStartMs(pid: number): number | null {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return null;
  const ps = run('ps', ['-o', 'lstart=', '-p', String(pid)], { allowFail: true, env: { ...process.env, LC_ALL: 'C' }, timeoutMs: 5000 });
  const m = ps.ok ? LSTART.exec(ps.stdout) : null;
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** This process's start, taken once at load so a test that fakes Date.now later can't move it. */
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

/** What a lock's holder writes into `<lockDir>/holder.json` straight after its mkdir. */
export interface LockHolder {
  v: 1;
  pid: number;
  startedAt: string;
  host: string;
  token: string;
}

/** A lock dir with no parseable holder.json (an older Forge's, or one caught between mkdir and write) is broken only past this mtime age. */
const LEGACY_LOCK_MS = 60_000;
/** A waiter asks ps about one holder token at most this often. */
const PROBE_EVERY_MS = 1000;
const HOLDER_MAX_BYTES = 4096;
const NOFOLLOW_FLAG = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK_FLAG = fs.constants.O_NONBLOCK ?? 0;

/**
 * The holder a lock dir names, or null for anything else: missing, oversized, not a regular file,
 * or not the v1 shape. The dir is writable by whoever can write its parent (a job dir's agents,
 * say), so a planted file is read without following links or blocking, and garbage only ever gets
 * the slow legacy rule.
 */
export function readLockHolder(lockDir: string): LockHolder | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path.join(lockDir, 'holder.json'), fs.constants.O_RDONLY | NOFOLLOW_FLAG | NONBLOCK_FLAG);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > HOLDER_MAX_BYTES) return null;
    const h = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!h || typeof h !== 'object' || h.v !== 1) return null;
    if (!Number.isInteger(h.pid) || h.pid <= 0 || typeof h.host !== 'string' || typeof h.token !== 'string' || !h.token || h.token.length > 100) return null;
    if (typeof h.startedAt !== 'string' || !Number.isFinite(Date.parse(h.startedAt))) return null;
    return { v: 1, pid: h.pid, startedAt: h.startedAt, host: h.host, token: h.token };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** One waiter's memory across its polls: when it last asked ps about each holder token, and the answer. */
interface LockWait {
  probes: Map<string, { at: number; dead: boolean }>;
  holder: LockHolder | null;
}

const newWait = (): LockWait => ({ probes: new Map(), holder: null });

/**
 * Whether a parseable holder is provably gone: on this host, and its pid is gone (pidGone) or (ps
 * permitting) belongs to a process that started at another time, so the pid was reused. Another
 * host, a matching start time, or a ps that fails all count as alive: age never does.
 */
function holderDead(h: LockHolder, w: LockWait): boolean {
  if (h.host !== os.hostname()) return false;
  if (pidGone(h.pid)) return true;
  if (process.platform === 'win32') return false;
  const seen = w.probes.get(h.token);
  if (seen && Math.abs(Date.now() - seen.at) < PROBE_EVERY_MS) return seen.dead;
  const started = processStartMs(h.pid);
  const dead = started !== null && Math.abs(started - Date.parse(h.startedAt)) > START_SLACK_MS;
  w.probes.set(h.token, { at: Date.now(), dead });
  return dead;
}

/** Renames a lock dir to a fresh grave beside it and removes that, so no waiter ever sees a half-removed lock. */
function bury(lockDir: string): boolean {
  const grave = `${lockDir}.dead-${crypto.randomUUID().slice(0, 8)}`;
  try {
    fs.renameSync(lockDir, grave);
  } catch {
    return false;
  }
  fs.rmSync(grave, { recursive: true, force: true });
  return true;
}

/**
 * Breaks a lock judged dead (holder `token`, or null for a legacy holder-less dir whose stat was
 * `judged`), one breaker at a time: the `breaking` marker excludes the others, and the re-read
 * proves the dir is still the one judged. A breaker that dies before the rename leaves the marker,
 * which wedges the lock rather than ever admitting a second holder. Returns whether the lock is gone.
 */
function breakLock(lockDir: string, token: string | null, judged?: fs.Stats): boolean {
  const marker = path.join(lockDir, 'breaking');
  try {
    fs.mkdirSync(marker);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT';
  }
  const now = readLockHolder(lockDir);
  // A legacy dir must be the very dir judged (a new holder's, made since, has another inode or birth
  // time even before it writes anything) and hold nothing but the marker and an unreadable holder.json.
  const same = token === null ? now === null && sameDir(lockDir, judged) && onlyMarker(lockDir) : now?.token === token;
  if (!same) {
    try {
      fs.rmdirSync(marker);
    } catch {}
    return false;
  }
  return bury(lockDir);
}

function sameDir(lockDir: string, judged: fs.Stats | undefined): boolean {
  if (!judged) return false;
  try {
    const st = fs.lstatSync(lockDir);
    return st.isDirectory() && st.dev === judged.dev && st.ino === judged.ino && st.birthtimeMs === judged.birthtimeMs;
  } catch {
    return false;
  }
}

function onlyMarker(lockDir: string): boolean {
  try {
    return fs.readdirSync(lockDir).every((n) => n === 'breaking' || n === 'holder.json');
  } catch {
    return false;
  }
}

/**
 * One try at the lock: mkdir, and on EEXIST at most one death-proof break followed by one more
 * mkdir. Returns the new holder's token, or null while someone else holds it.
 */
function attemptLock(lockDir: string, w: LockWait): string | null {
  for (let tries = 0; tries < 2; tries++) {
    try {
      fs.mkdirSync(lockDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (tries > 0) return null;
      let st: fs.Stats;
      try {
        st = fs.lstatSync(lockDir);
      } catch {
        continue;
      }
      // Not a directory (a planted symlink, say): wedged, never broken through into its target.
      if (!st.isDirectory()) return null;
      const holder = readLockHolder(lockDir);
      w.holder = holder;
      if (holder) {
        if (!holderDead(holder, w) || !breakLock(lockDir, holder.token)) return null;
      } else if (Date.now() - st.mtimeMs <= LEGACY_LOCK_MS || !breakLock(lockDir, null, st)) {
        // The only place a lock's age counts.
        return null;
      }
      continue;
    }
    const token = crypto.randomUUID();
    try {
      writeJsonAtomic(path.join(lockDir, 'holder.json'), { v: 1, pid: process.pid, startedAt: PROCESS_STARTED_AT, host: os.hostname(), token } satisfies LockHolder);
    } catch (e) {
      fs.rmSync(lockDir, { recursive: true, force: true });
      throw e;
    }
    return token;
  }
  return null;
}

/** Removes the lock only while it is still this holder's: a dir another holder now owns is left alone. */
function releaseLock(lockDir: string, token: string): void {
  if (readLockHolder(lockDir)?.token === token) bury(lockDir);
}

function lockTimeout(lockDir: string, w: LockWait): ForgeError {
  return new ForgeError(`timed out waiting for lock ${lockDir} (${w.holder ? `held by pid ${w.holder.pid}` : 'holder unknown'})`);
}

/**
 * mkdir is atomic on every filesystem we care about, which makes it a portable lock primitive
 * across concurrent Forge sessions on one machine. A lock is never broken for its age, only when
 * its holder is provably dead (holderDead), so a long section keeps it and needs no refresh.
 */
export function withLock<T>(lockDir: string, fn: () => T, opts: { timeoutMs?: number } = {}): T {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const start = Date.now();
  const w = newWait();
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  let token: string | null;
  while ((token = attemptLock(lockDir, w)) === null) {
    if (Date.now() - start > timeoutMs) throw lockTimeout(lockDir, w);
    sleepSync(50);
  }
  try {
    return fn();
  } finally {
    releaseLock(lockDir, token);
  }
}

/** withLock for async work: the same mkdir lock, waiting without blocking the event loop. */
export async function withLockAsync<T>(lockDir: string, fn: () => Promise<T>, opts: { timeoutMs?: number } = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const start = Date.now();
  const w = newWait();
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  let token: string | null;
  while ((token = attemptLock(lockDir, w)) === null) {
    if (Date.now() - start > timeoutMs) throw lockTimeout(lockDir, w);
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    return await fn();
  } finally {
    releaseLock(lockDir, token);
  }
}

/**
 * Whether a live holder has the lock, judged without touching it: a probe that must not hold the
 * lock even for an instant (another start would then be refused). A holder-less dir counts as held
 * while it is young, and a lock path that is not a directory as held, as attemptLock treats them.
 */
export function lockHeld(lockDir: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(lockDir);
  } catch {
    return false;
  }
  if (!st.isDirectory()) return true;
  const holder = readLockHolder(lockDir);
  if (holder) return !holderDead(holder, newWait());
  return Date.now() - st.mtimeMs <= LEGACY_LOCK_MS;
}

/**
 * One attempt at a lock to hold for a long time (`forge dash`'s daemon lock), with the death-proof
 * break applied once. The holder is null-valued when the dir names none (a legacy or mid-write lock).
 */
export function tryLock(lockDir: string): { release: () => void } | { holder: { pid: number | null; host: string | null } } {
  const w = newWait();
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const token = attemptLock(lockDir, w);
  if (token === null) {
    // A holder that won the mkdir a moment ago may not have written holder.json yet: give it a beat, so the refusal can name it.
    for (let i = 0; i < 20 && !w.holder; i++) {
      sleepSync(10);
      w.holder = readLockHolder(lockDir);
    }
    return { holder: { pid: w.holder?.pid ?? null, host: w.holder?.host ?? null } };
  }
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      releaseLock(lockDir, token);
    },
  };
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

/**
 * `forge run`'s extra arguments as shell words, each in single quotes. A quote, backslash or control
 * character is refused rather than escaped: without them a single-quoted word is literal in sh,
 * bash, zsh and fish alike (fish reads \' and \\ inside them), whatever $SHELL is.
 */
export function shellArgs(args: string[]): string {
  args.forEach((a, i) => {
    if (/['\\\x00-\x1f\x7f]/.test(a)) throw new ForgeError(`forge run: argument ${i + 1} contains a quote, backslash or control character (got ${JSON.stringify(a)})`);
  });
  return args.map((a) => `'${a}'`).join(' ');
}

/**
 * A component's path becomes the cwd of its shell commands (path.join(worktree, path)), so it must
 * stay inside the checkout: no absolute path, drive letter or `..` segment on either separator.
 * Here rather than in components.ts so config-sinks.ts can use it without a cycle.
 */
export function isInsidePath(p: unknown): p is string {
  if (typeof p !== 'string' || !p.trim()) return false;
  if (path.isAbsolute(p) || /^[/\\]/.test(p) || /^[A-Za-z]:/.test(p)) return false;
  return !p.split(/[/\\]/).includes('..');
}

export function fill(template: string, vars: Record<string, string | number>): string {
  // Dotted keys for `{endpoint.<component>}` and `{backing.<name>.port}` (lib/endpoints.ts).
  return template.replace(/\{([\w./-]+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
}

/** A fence longer than any backtick run inside the text, at least three, so the text can't close it. */
export function fenced(text: string, lang = 'text'): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

export function tail(text: string, n: number): string {
  const lines = text.trimEnd().split('\n');
  return lines.slice(-n).join('\n');
}
