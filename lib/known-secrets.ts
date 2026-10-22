// Known values (docs/CONFIG.md "Secret references"): every secret value a job's sink renders has
// resolved, kept in the 0600 `<jobDir>/known-secrets.json`, plus its job database passwords. Forge
// replaces them with `[redacted]` wherever it writes or serves text. The record is agent-writable:
// it is read without following a link or blocking on a FIFO, a bad one counts as empty, and write-
// time redaction also uses the values the rendering process holds in memory. jobs.ts imports this
// module, so neither it nor backing-db.ts imports jobs.ts.
import fs from 'node:fs';
import path from 'node:path';
import { jobDbPasswords } from './backing-db.ts';
import { paths } from './paths.ts';
import type { Config } from './types.ts';
import { REDACTED, redact, withLock, writeJsonPrivate } from './util.ts';

/** Below this a value can't be redacted reliably: it would match ordinary text. */
export const MIN_SECRET = 8;
const MAX_RECORD = 1024 * 1024;
const JOB_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

/** Job files that hold credentials: never served, listed or bundled. */
export const PRIVATE_JOB_FILES: ReadonlySet<string> = new Set(['known-secrets.json', 'backing-db.json']);

/** Whether a file name is a private job file's, in any case: the default macOS volume ignores case. */
export const isPrivateName = (name: string): boolean => PRIVATE_JOB_FILES.has(name.toLowerCase());

/** Whether `file`, by its own name or the name a link in its path resolves to, is a private job file. */
export function isPrivateJobFile(file: string): boolean {
  if (isPrivateName(path.basename(file))) return true;
  try {
    return isPrivateName(path.basename(fs.realpathSync(file)));
  } catch {
    return false;
  }
}

export const knownFile = (root: string, id: string): string => path.join(paths(root).job(id), 'known-secrets.json');

/** The forms a value takes in text Forge writes: raw, and escaped inside a JSON string when that differs. */
function forms(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (v.length < MIN_SECRET) continue;
    out.push(v);
    const escaped = JSON.stringify(v).slice(1, -1);
    if (escaped !== v) out.push(escaped);
  }
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

/** `text` with every known value, raw or JSON-escaped, replaced by `[redacted]`. */
export function redactKnown(text: string, values: readonly string[]): string {
  return values.length ? redact(text, forms(values)) : text;
}

/** `value` with every string leaf redacted, as fresh objects; `value` itself when there is nothing to redact. */
export function redactDeep<T>(value: T, values: readonly string[]): T {
  if (!values.length) return value;
  const f = forms(values);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redact(v, f);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

const cache = new Map<string, { mtimeMs: number; size: number; ino: number; values: Record<string, string> }>();

/** The record's values, read through one descriptor that follows no link and never blocks; {} on any failure. */
function readRecord(file: string): Record<string, string> {
  let fd: number | undefined;
  try {
    const link = fs.lstatSync(file);
    if (!link.isFile() || link.size > MAX_RECORD) return {};
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === link.mtimeMs && hit.size === link.size && hit.ino === link.ino) return hit.values;
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_RECORD || st.dev !== link.dev || st.ino !== link.ino) return {};
    const raw = JSON.parse(fs.readFileSync(fd, 'utf8'));
    const values: Record<string, string> = {};
    if (raw && typeof raw === 'object' && raw.v === 1 && raw.values && typeof raw.values === 'object' && !Array.isArray(raw.values))
      for (const [k, v] of Object.entries(raw.values)) if (typeof v === 'string' && v.length >= MIN_SECRET) values[k] = v;
    cache.set(file, { mtimeMs: link.mtimeMs, size: link.size, ino: link.ino, values });
    return values;
  } catch {
    return {};
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Merges `values` into the job's record by name, rewriting it (0600, through a rename that replaces
 * whatever sits at the path) only when something changed.
 */
export function recordKnown(root: string, id: string, values: Record<string, string>): void {
  if (!JOB_ID.test(id)) return;
  const file = knownFile(root, id);
  withLock(path.join(paths(root).job(id), '.known-secrets.lock'), () => {
    const current = readRecord(file);
    const next = { ...current, ...values };
    let same = Object.keys(next).length === Object.keys(current).length;
    for (const [k, v] of Object.entries(values)) if (current[k] !== v) same = false;
    // A link or junk at the path reads as {}: rewrite it, so the rename replaces it.
    let regular = false;
    try {
      regular = fs.lstatSync(file).isFile();
    } catch {}
    if (same && regular) return;
    writeJsonPrivate(file, { v: 1, values: next });
  });
}

/** The recorded values of one job (no database passwords: logEvent has no config). */
export function knownRecordValues(root: string, id: string): string[] {
  if (!JOB_ID.test(id)) return [];
  return Object.values(readRecord(knownFile(root, id)));
}

const ordered = (values: string[]): string[] => [...new Set(values.filter((v) => v.length >= MIN_SECRET))].sort((a, b) => b.length - a.length);

/** A job's known values: its record plus its job database passwords, deduped, longest first. */
export function knownValues(root: string, id: string, config: Config): string[] {
  if (!JOB_ID.test(id)) return [];
  let db: string[] = [];
  try {
    db = jobDbPasswords(root, id, config);
  } catch {}
  return ordered([...knownRecordValues(root, id), ...db]);
}

/** Every job's known values: what a response that spans jobs (/api/state, the inbox log) redacts. */
export function allKnownValues(root: string, config: Config): string[] {
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(paths(root).jobs).filter((id) => JOB_ID.test(id));
  } catch {
    return [];
  }
  return ordered(ids.flatMap((id) => knownValues(root, id, config)));
}

/** A daemon scope's known values: a job scope's own, every job's for `_inbox` and `_office` (no job id starts with `_`). */
export function scopeKnownValues(root: string, scope: string, config: Config): string[] {
  return JOB_ID.test(scope) ? knownValues(root, scope, config) : allKnownValues(root, config);
}

/** Deletes the job's record (`forge worktree remove`). */
export function removeKnown(root: string, id: string): void {
  if (!JOB_ID.test(id)) return;
  fs.rmSync(knownFile(root, id), { force: true });
  cache.delete(knownFile(root, id));
}
