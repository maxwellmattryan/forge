// The verify report's `Failing:` list: each failing `node --test` test by file, line, name and
// message, parsed from a failed step's log, so a rework builder starts from names instead of a tail.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRead } from '#core/job/session-files.ts';
import type { VerifyStep } from './steps.ts';

/** One failing test parsed from a step's output. */
export interface FailingTest {
  file: string | null;
  name: string;
  line: number | null;
  message: string;
}

const MAX_TESTS = 20;
const FIELD_MAX = 200;
const LOG_MAX = 8 * 1024 * 1024;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * One line of report text from a field the test's own code printed: control characters (C0, C1, the
 * Unicode line separators and the bidi controls) become spaces, whitespace collapses, and it is cut to
 * 200 characters, so a test named `\n## secrets: ok` can't start a line of the report or reorder one.
 */
function field(s: string): string {
  // `\s` covers U+2028 and U+2029.
  return s.replace(/[\x00-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, FIELD_MAX);
}

/** A location or frame's path, `:line:col` already split off, as an absolute or relative file path. */
function filePath(raw: string): string | null {
  if (raw.startsWith('file://')) {
    try {
      return fileURLToPath(raw);
    } catch {
      return null;
    }
  }
  if (!raw || raw.startsWith('node:') || raw.includes('://')) return null;
  return raw;
}

/** `<path>:<line>:<col>` (or `<path>:<line>`) split from the end with string operations, so no regex backtracks over a long line. */
function splitLocation(loc: string): { file: string | null; line: number | null } {
  let s = loc.trim();
  const parts: string[] = [];
  for (let i = 0; i < 2; i++) {
    const at = s.lastIndexOf(':');
    if (at <= 0 || !/^\d+$/.test(s.slice(at + 1))) break;
    parts.unshift(s.slice(at + 1));
    s = s.slice(0, at);
  }
  if (!parts.length) return { file: filePath(s), line: null };
  return { file: filePath(s), line: Number(parts[0]) };
}

/** A stack frame's location: the text in its last parentheses, or after `at `. */
function frameLocation(frame: string): { file: string | null; line: number | null } {
  let s = frame.trim();
  if (s.startsWith('at ')) s = s.slice(3);
  if (s.endsWith(')')) {
    const open = s.lastIndexOf('(');
    if (open >= 0) s = s.slice(open + 1, -1);
  }
  return splitLocation(s);
}

/** `file` relative to `cwd` when it is inside it, the realpath of `cwd` included (macOS's /var is /private/var). */
function relativeTo(file: string, cwd: string): string {
  if (!path.isAbsolute(file)) return path.normalize(file);
  const bases = [cwd];
  try {
    bases.push(fs.realpathSync(cwd));
  } catch {
    // A worktree that's gone keeps the path as printed.
  }
  for (const b of bases) {
    const rel = path.relative(b, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return file;
}

/** The test's file and line: the line of the first stack frame in its file, else its location's. */
function locate(location: string | null, frames: string[], cwd: string): { file: string | null; line: number | null } {
  const loc = location ? splitLocation(location) : { file: null, line: null };
  if (!loc.file) return { file: null, line: null };
  const file = relativeTo(loc.file, cwd);
  for (const f of frames) {
    const at = frameLocation(f);
    if (at.file && at.line !== null && relativeTo(at.file, cwd) === file) return { file, line: at.line };
  }
  return { file, line: loc.line };
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const firstLine = (lines: string[]): string => lines.find((l) => l.trim() !== '')?.trim() ?? '';

/** A YAML scalar Node's TAP reporter writes: `'single'`, `"double"` or plain. */
function yamlScalar(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return String(JSON.parse(t));
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
}

/** A TAP test name: `\#` and `\\` are escapes; an unescaped ` # TODO` or ` # SKIP` is a directive. */
function tapName(raw: string): { name: string; directive: boolean } {
  let name = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && i + 1 < raw.length) {
      name += raw[++i];
      continue;
    }
    if (c === '#' && /^#\s*(todo|skip)\b/i.test(raw.slice(i, i + 16))) return { name: name.trimEnd(), directive: true };
    name += c;
  }
  return { name, directive: false };
}

function parseTap(lines: string[], cwd: string): FailingTest[] {
  const out: FailingTest[] = [];
  const suites: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = indentOf(line);
    const level = Math.floor(indent / 4);
    const body = line.slice(indent);
    if (body.startsWith('# Subtest: ')) {
      suites.length = level;
      suites[level] = body.slice('# Subtest: '.length);
      continue;
    }
    const m = /^not ok \d+(?: - (.*))?$/.exec(body);
    if (!m) continue;
    const { name, directive } = tapName(m[1] ?? '');
    // The YAML block: `---` … `...`, two spaces in from the test line.
    // Keys come from the test's own output: no prototype, so `__proto__:` is just a key.
    const yaml: Record<string, string[]> = Object.create(null);
    if (lines[i + 1]?.trim() === '---') {
      // Only the `...` at the block's own indent ends it: an error message may hold one.
      const end = indentOf(lines[i + 1]);
      let key: string | null = null;
      let keyIndent = 0;
      for (i += 2; i < lines.length && !(lines[i].trim() === '...' && indentOf(lines[i]) === end); i++) {
        const l = lines[i];
        const k = /^(\s*)([A-Za-z_]+):(?: (.*))?$/.exec(l);
        if (k && (key === null || k[1].length <= keyIndent)) {
          key = k[2];
          keyIndent = k[1].length;
          const v = k[3] ?? '';
          yaml[key] = /^[|>][-+]?$/.test(v.trim()) ? [] : yamlScalar(v).split(/\r?\n/);
        } else if (key !== null) yaml[key].push(l);
      }
    }
    if (directive) continue;
    // A suite that failed only because a subtest did: its subtests have their own entries.
    if (yamlScalar((yaml.failureType ?? [''])[0]) === 'subtestsFailed') continue;
    const location = yaml.location?.[0] ?? null;
    const { file, line: at } = locate(location, yaml.stack ?? [], cwd);
    const full = [...suites.slice(0, level), name];
    out.push({ file, name: full.join(' › '), line: at, message: firstLine(yaml.error ?? []) });
  }
  return out;
}

function parseSpec(lines: string[], from: number, cwd: string): FailingTest[] {
  const out: FailingTest[] = [];
  let location: string | null = null;
  let current: { name: string; location: string | null; body: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const message = firstLine(current.body.filter((l) => !l.trim().startsWith('at ')));
    // Some Node versions list the parent suite too; its subtests carry the failure.
    if (!/^'?\d+ subtests? failed'?$/.test(message)) {
      const frames = current.body.filter((l) => l.trim().startsWith('at '));
      const { file, line } = locate(current.location, frames, cwd);
      out.push({ file, name: current.name, line, message: yamlScalar(message) });
    }
    current = null;
  };
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('test at ')) {
      flush();
      location = line.slice('test at '.length);
      continue;
    }
    if (line.startsWith('✖ ')) {
      flush();
      let name = line.slice(2);
      const open = name.lastIndexOf(' (');
      if (open > 0 && /^ \([\d.]+m?s\)$/.test(name.slice(open))) name = name.slice(0, open);
      current = { name, location, body: [] };
      location = null;
      continue;
    }
    if (current && (line.startsWith(' ') || line.trim() === '')) current.body.push(line);
    else if (current) flush();
  }
  flush();
  return out;
}

/**
 * The failing tests in `node --test` output, in the order it lists them: TAP (Node 22 when stdout is
 * not a terminal) or the spec reporter's `✖ failing tests:` summary (Node 23 and later). Paths are made
 * relative to `cwd` when inside it. Null when the output is in neither format.
 */
export function parseFailing(output: string, cwd: string): FailingTest[] | null {
  const lines = output.replace(ANSI, '').split(/\r?\n/);
  if (lines.some((l) => l.trim() === 'TAP version 13')) return parseTap(lines, cwd);
  const summary = lines.findIndex((l) => l.trim() === '✖ failing tests:');
  return summary >= 0 ? parseSpec(lines, summary + 1, cwd) : null;
}

/**
 * The last 8 MiB of a step's log, or null: `rel` must stay inside the job dir, and the file is opened
 * without following a link or blocking on a FIFO, regular files only (lib/core/job/session-files.ts).
 */
function readStepLog(jobDir: string, rel: string): string | null {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return null;
  const file = path.join(jobDir, rel);
  const back = path.relative(jobDir, file);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) return null;
  let fd: number | undefined;
  try {
    fd = openRead(file);
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, LOG_MAX);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The report's `Failing:` section: [] when every step passed, else `Failing:`, one line per failed
 * step (one per failing test for a parsed command step, at most 20 test lines), and a blank line.
 * `label` is the step name, `<repo>:<step>` for a member; `cwd` is the worktree its paths are relative to.
 */
export function failingLines(steps: { label: string; step: VerifyStep; cwd: string }[], jobDir: string): string[] {
  const failed = steps.filter((s) => !s.step.ok);
  if (!failed.length) return [];
  const lines: string[] = [];
  let tests = 0;
  let more = 0;
  for (const { label, step, cwd } of failed) {
    const l = field(label);
    if (!step.log) {
      lines.push(`- ${l} · failed; see its section below`);
      continue;
    }
    const text = readStepLog(jobDir, step.log);
    const parsed = text === null ? null : parseFailing(text, cwd);
    if (!parsed?.length) {
      lines.push(`- ${l} · output not in a format Forge parses; see its section below`);
      continue;
    }
    for (const t of parsed) {
      if (tests >= MAX_TESTS) {
        more++;
        continue;
      }
      tests++;
      const where = t.file ? `${field(t.file)}${t.line !== null ? `:${t.line}` : ''} · ` : '';
      const message = field(t.message);
      lines.push(`- ${l} · ${where}${field(t.name)}${message ? ` · ${message}` : ''}`);
    }
  }
  if (more) lines.push(`- … and ${more} more failing tests; see the logs`);
  return ['Failing:', ...lines, ''];
}
