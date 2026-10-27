// One agent run's friction, counted from its Claude Code transcript: turns, tool calls and errors, the same
// failing command run again, permission denials, re-reads and refused forge calls, plus a condensed one-line
// log of the run for a digest agent. A transcript is text agents and the programs they ran wrote, so only
// counts, hashes and charset-limited keys leave this module for transcripts.json, and every log line is made
// one safe line here: the caller fences it. Reading is bounded by a line cap, a byte cap and a log cap.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { safeText, visibleText } from '#core/text.ts';
import { UNATTENDED_DENIED } from './stream.ts';
import { PATH_KEYS, TARGET_KEYS, relativeTo, transcriptBases } from './transcripts.ts';
import type { RunCounts } from './types.ts';

/** One event of a run's condensed log: already one line, visible and backtick-free. */
export interface LogLine {
  turn: number;
  kind: 'tool' | 'error' | 'denied' | 'text';
  text: string;
}

const MiB = 1024 * 1024;
const CHUNK_BYTES = MiB;
const MAX_BYTES = 64 * MiB;
const MAX_LINE = 8 * MiB;
/** The most entries each list in a run's counts keeps. */
const LIST_CAP = 10;
/** How much of one text is cleaned for a log line or a key: more than any cap needs. */
const TEXT_SCAN = 16 * 1024;
const TOOL_NAME = /^[A-Za-z0-9_:.-]{1,64}$/;
const ENV_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;
const KEY_WORD = /^[A-Za-z0-9._/:@+][A-Za-z0-9._/:@+-]{0,39}$/;
const FORGE_WORD = /^[a-z][a-z-]{0,30}$/;
const SAFE_FILE = /^[A-Za-z0-9._/@+-]{1,160}$/;
const EXIT_CODE = /^Exit code (\d{1,5})\b/;
const TAG = /<[^<>]*>/g;
const LINE_BREAK = /\r\n|[\n\r\u{2028}\u{2029}\x85]/u;
// Whitespace and every C0/C1 control, so CR, U+2028, U+2029 and NEL can't break a log line.
const BREAKS = /[\s\x00-\x1f\x7f-\x9f]+/gu;
/** The texts a denied tool call returns: Claude Code's own and the first sentence of Forge's unattended deny. */
const DENIAL_TEXTS = [
  'Permission for this action was denied',
  'Permission to use ',
  "The user doesn't want to proceed with this tool use",
  UNATTENDED_DENIED.slice(0, UNATTENDED_DENIED.indexOf('. ') + 1),
];

const sha8 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const isMap = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const firstLine = (text: string): string => text.slice(0, TEXT_SCAN).split(LINE_BREAK).find((l) => l.trim()) ?? '';
const untagged = (line: string): string => line.replace(TAG, '').trim();

/** Transcript text as one log line: visible characters only, every break and control one space, no backticks, at most `max` characters. */
function oneLine(text: string, max: number): string {
  return safeText(visibleText(text.slice(0, TEXT_SCAN)).text.replace(BREAKS, ' ').trim(), max);
}

/** A command's words after its leading `NAME=value` words and one leading `cd <dir> &&`. */
function commandWords(command: string): string[] {
  const words = collapse(command).split(' ').filter(Boolean);
  let i = 0;
  while (i < words.length && ENV_WORD.test(words[i])) i++;
  if (words[i] === 'cd' && words[i + 2] === '&&') i += 3;
  return words.slice(i);
}

/**
 * A command's key and hash: the key is at most its first 3 plain words, stopping at a flag or any other
 * word outside the charset (`(command)` when none qualify), so no argument, env value or free text is
 * in it; the hash (8 hex of sha256) is over the whole command past its env words and `cd … &&`.
 */
export function commandKey(command: string): { key: string; hash: string } {
  const words = commandWords(String(command));
  const key: string[] = [];
  for (const w of words) {
    if (key.length === 3 || !KEY_WORD.test(w)) break;
    key.push(w);
  }
  return { key: key.join(' ') || '(command)', hash: sha8(words.join(' ')) };
}

/**
 * An error's key: the first 5 `[a-z]+` words of its first non-empty line, tags removed and lower-cased, each
 * cut to 20 letters so a key stays short; `(empty)` with none.
 */
export function errorKey(text: string): string {
  const line = String(text).slice(0, TEXT_SCAN).split(LINE_BREAK).map(untagged).find(Boolean) ?? '';
  const words = (line.toLowerCase().match(/[a-z]+/g) ?? []).slice(0, 5).map((w) => w.slice(0, 20));
  return words.length ? words.join(' ') : '(empty)';
}

/** A file's key: its path relative to the first of `bases` it sits under, or `#<8 hex of sha256>` when that is outside the charset or has a `..` segment. */
export function fileKey(p: string, bases: string[]): string {
  const rel = relativeTo(String(p), bases);
  return SAFE_FILE.test(rel) && !rel.split('/').includes('..') ? rel : `#${sha8(String(p))}`;
}

/** The `forge` key of a command's words, `forge` plus up to 2 subcommand words, or null when it is no forge call. */
function forgeKey(words: string[]): string | null {
  const head = words[0];
  if (head !== 'forge' && !head?.endsWith('/forge')) return null;
  const key = ['forge'];
  for (const w of words.slice(1)) {
    if (key.length === 3 || !FORGE_WORD.test(w)) break;
    key.push(w);
  }
  return key.join(' ');
}

/** What a tool call acts on, in TARGET_KEYS order: the first line of its command, a file key, or its pattern, url, query, description or skill. */
function target(input: Record<string, unknown>, bases: string[]): string {
  for (const k of TARGET_KEYS) {
    const v = input[k];
    if (typeof v !== 'string' || !v.trim()) continue;
    if (k === 'command') return firstLine(v);
    return PATH_KEYS.has(k) ? fileKey(v, bases) : v;
  }
  return '';
}

/** A tool result's text: a string, or its text blocks joined. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => isMap(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => (b as { text: string }).text)
    .join('\n');
}

/**
 * Calls `onLine` with each whole line of the file's first `maxBytes`, read through `fd` in 1 MiB chunks; a
 * line longer than `maxLine` bytes is skipped unread, and a last line cut by the byte cap is dropped.
 * Returns whether the cap stopped the read.
 */
function eachLine(fd: number, size: number, maxBytes: number, maxLine: number, onLine: (line: string) => void): boolean {
  const cap = Math.min(size, maxBytes);
  const chunk = Buffer.alloc(Math.max(1, Math.min(CHUNK_BYTES, cap)));
  // The bytes of the current line from earlier chunks (copied: the chunk buffer is reused).
  let parts: Buffer[] = [];
  let partLen = 0;
  let skipping = false;
  let pos = 0;
  while (pos < cap) {
    const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, cap - pos), pos);
    if (read <= 0) break;
    pos += read;
    const buf = chunk.subarray(0, read);
    let start = 0;
    for (let nl = buf.indexOf(0x0a, start); nl >= 0; nl = buf.indexOf(0x0a, start)) {
      const piece = buf.subarray(start, nl);
      if (!skipping && partLen + piece.length <= maxLine) onLine((parts.length ? Buffer.concat([...parts, piece]) : piece).toString('utf8'));
      parts = [];
      partLen = 0;
      skipping = false;
      start = nl + 1;
    }
    const rest = buf.subarray(start);
    if (skipping || !rest.length) continue;
    if (partLen + rest.length > maxLine) {
      skipping = true;
      parts = [];
      partLen = 0;
    } else {
      parts.push(Buffer.from(rest));
      partLen += rest.length;
    }
  }
  const truncated = size > maxBytes;
  if (!truncated && !skipping && partLen) onLine(Buffer.concat(parts).toString('utf8'));
  return truncated;
}

const bump = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Call {
  name: string;
  input: Record<string, unknown>;
  turn: number;
}

/**
 * A run's friction from its transcript (`fd`, `size` bytes), per the counting rules in docs/IMPROVEMENT.md
 * "Agent transcripts". Blank, unparseable and non-object lines are skipped. `worktree` and `root` are the
 * bases file keys are relative to. With `log`, also the condensed log, one entry per tool call, errored
 * result and assistant text, in turn order.
 */
export function runFriction(
  fd: number,
  size: number,
  opts: { worktree?: string | null; root?: string | null; log?: boolean; maxBytes?: number; maxLine?: number } = {},
): RunCounts & { log?: LogLine[] } {
  const bases = transcriptBases(opts);
  const turns = new Map<string, number>();
  const calls = new Map<string, Call>();
  const results = new Set<string>();
  const errByTool = new Map<string, number>();
  const errByPrefix = new Map<string, number>();
  const denByTool = new Map<string, number>();
  const failures = new Map<string, { key: string; hash: string; count: number; turns: [number, number] }>();
  const ranges = new Map<string, number>();
  const rereads = new Map<string, number>();
  const exits = new Map<string, { key: string; code: number; count: number }>();
  const log: LogLine[] | null = opts.log ? [] : null;
  let errors = 0;
  let denials = 0;
  let lineNo = 0;
  let lastTurn = 0;

  const assistant = (o: Record<string, any>): void => {
    const msg = isMap(o.message) ? o.message : {};
    const id = typeof msg.id === 'string' && msg.id ? `m:${msg.id}` : typeof o.uuid === 'string' && o.uuid ? `u:${o.uuid}` : `l:${lineNo}`;
    let turn = turns.get(id);
    if (turn === undefined) turns.set(id, (turn = turns.size + 1));
    lastTurn = turn;
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (!isMap(b)) continue;
      if (b.type === 'tool_use' && typeof b.id === 'string' && !calls.has(b.id)) {
        const name = typeof b.name === 'string' && TOOL_NAME.test(b.name) ? b.name : 'other';
        const input = isMap(b.input) ? b.input : {};
        calls.set(b.id, { name, input, turn });
        if (name === 'Read' && typeof input.file_path === 'string') {
          const file = fileKey(input.file_path, bases);
          const range = JSON.stringify([file, input.offset ?? 0, input.limit ?? null]);
          const n = (ranges.get(range) ?? 0) + 1;
          ranges.set(range, n);
          rereads.set(file, Math.max(rereads.get(file) ?? 0, n));
        }
        log?.push({ turn, kind: 'tool', text: oneLine(`${name} ${target(input, bases)}`, 160) });
      } else if (b.type === 'text' && typeof b.text === 'string' && log) {
        const first = firstLine(b.text);
        if (first) log.push({ turn, kind: 'text', text: oneLine(first, 160) });
      }
    }
  };

  const user = (o: Record<string, any>): void => {
    const content = isMap(o.message) ? o.message.content : undefined;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (!isMap(b) || b.type !== 'tool_result' || b.is_error !== true) continue;
      const useId = typeof b.tool_use_id === 'string' ? b.tool_use_id : null;
      if (useId) {
        if (results.has(useId)) continue;
        results.add(useId);
      }
      const call = useId ? calls.get(useId) : undefined;
      const name = call?.name ?? 'other';
      const text = resultText(b.content);
      const head = untagged(firstLine(text));
      const denied =
        (typeof o.toolDenialKind === 'string' && o.toolDenialKind !== 'interrupted') ||
        (isMap(o.permissionDecision) && o.permissionDecision.decision === 'reject') ||
        DENIAL_TEXTS.some((t) => head.startsWith(t));
      errors++;
      bump(errByTool, name);
      bump(errByPrefix, errorKey(text));
      if (denied) {
        denials++;
        bump(denByTool, name);
      }
      const turn = call?.turn ?? lastTurn;
      if (call?.name === 'Bash' && typeof call.input.command === 'string') {
        const { key, hash } = commandKey(call.input.command);
        const f = failures.get(hash);
        if (f) {
          f.count++;
          f.turns[1] = turn;
        } else failures.set(hash, { key, hash, count: 1, turns: [turn, turn] });
        const forge = forgeKey(commandWords(call.input.command));
        const code = forge ? Number(EXIT_CODE.exec(head)?.[1] ?? 0) : 0;
        if (forge && code !== 0) {
          const k = `${forge}\0${code}`;
          const e = exits.get(k);
          if (e) e.count++;
          else exits.set(k, { key: forge, code, count: 1 });
        }
      }
      log?.push({ turn, kind: denied ? 'denied' : 'error', text: oneLine(text, 200) });
    }
  };

  const truncated = eachLine(fd, size, opts.maxBytes ?? MAX_BYTES, opts.maxLine ?? MAX_LINE, (line) => {
    lineNo++;
    // Most lines are neither an assistant turn nor a tool result: parse only the ones that could be.
    if (!line.includes('"assistant"') && !line.includes('"tool_result"')) return;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (!isMap(o)) return;
    if (o.type === 'assistant') assistant(o);
    else if (o.type === 'user') user(o);
  });

  const counts: RunCounts = {
    turns: turns.size,
    toolCalls: calls.size,
    toolErrors: { total: errors, byTool: Object.fromEntries(errByTool), byPrefix: Object.fromEntries(errByPrefix) },
    repeatedFailures: [...failures.values()]
      .filter((f) => f.count >= 2)
      .sort((a, b) => b.count - a.count || cmp(a.key, b.key) || cmp(a.hash, b.hash))
      .slice(0, LIST_CAP),
    permissionDenials: { total: denials, byTool: Object.fromEntries(denByTool) },
    rereads: [...rereads]
      .filter(([, n]) => n >= 3)
      .map(([file, reads]) => ({ file, reads }))
      .sort((a, b) => b.reads - a.reads || cmp(a.file, b.file))
      .slice(0, LIST_CAP),
    forgeExits: [...exits.values()].sort((a, b) => b.count - a.count || cmp(a.key, b.key) || a.code - b.code).slice(0, LIST_CAP),
    truncated,
  };
  return log ? { ...counts, log } : counts;
}

const EDGE_LINES = 40;
/** Room for one `… <n> lines omitted (T<a>–T<b>)` line. */
const OMIT_BYTES = 64;
const MARK: Record<LogLine['kind'], string> = { tool: '', error: '! ', denied: '! denied: ', text: '» ' };
const bytes = (lines: string[]): number => lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);

/**
 * A run's log as `T<n> …` lines, unfenced (the caller fences it). Over `maxBytes`, the first and last 40
 * lines stay, and in between every errored result and the tool call just before it, as many as fit; each
 * dropped stretch becomes one `… <count> lines omitted (T<a>–T<b>)` line.
 */
export function renderLog(log: LogLine[], maxBytes = 96 * 1024): string {
  const lines = log.map((l) => `T${l.turn} ${MARK[l.kind]}${l.text}`);
  if (bytes(lines) <= maxBytes) return lines.join('\n');
  const n = lines.length;
  const edge = (i: number): boolean => i < EDGE_LINES || i >= n - EDGE_LINES;
  const keep = lines.map((_, i) => edge(i));
  log.forEach((l, i) => {
    if (l.kind !== 'error' && l.kind !== 'denied') return;
    keep[i] = true;
    if (i > 0 && log[i - 1].kind === 'tool') keep[i - 1] = true;
  });
  const render = (): string => {
    const out: string[] = [];
    for (let i = 0; i < n; ) {
      if (keep[i]) {
        out.push(lines[i++]);
        continue;
      }
      let j = i;
      while (j < n && !keep[j]) j++;
      out.push(`… ${j - i} lines omitted (T${log[i].turn}–T${log[j - 1].turn})`);
      i = j;
    }
    return out.join('\n');
  };
  const all = render();
  if (Buffer.byteLength(all) < maxBytes) return all;
  // Too many errors to keep them all: the middle keeps the first ones that fit, each with room for a gap before it.
  let budget = maxBytes - bytes(lines.filter((_, i) => edge(i))) - 2 * OMIT_BYTES;
  for (let i = EDGE_LINES; i < n - EDGE_LINES; i++) {
    if (!keep[i]) continue;
    const cost = Buffer.byteLength(lines[i]) + 1 + OMIT_BYTES;
    if (cost > budget) {
      for (let k = i; k < n - EDGE_LINES; k++) keep[k] = false;
      break;
    }
    budget -= cost;
  }
  return render();
}
