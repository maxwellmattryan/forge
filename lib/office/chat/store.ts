// Chat files: `.forge/runtime/chats/<id>/chat.json` (the chat, at CHAT_SCHEMA_VERSION) and `log.jsonl` (its
// history, append-only, never rotated). Only the dashboard server writes them (lib/server/routes/chats.ts and
// the recorder, ./recorder.ts); `forge chat` only reads them, and no session's file tools reach
// `.forge/runtime/`. An id is checked against CHAT_ID before any path is built; `chats/` and `<id>/` must be
// real directories, and chat.json and log.jsonl regular files, all read and appended without following a
// link or blocking on a FIFO. docs/architecture/daemon.md › Chats.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ForgeError } from '#core/errors.ts';
import { CHAT_ID } from '#core/job/requests.ts';
import { openAppend } from '#core/job/session-files.ts';
import { confinedDir, readRegular, writeJsonAtomic } from '#core/os/fs.ts';
import { withLock } from '#core/os/lock.ts';
import { paths } from '#core/paths.ts';
import { oneLineTitle } from '#core/text.ts';
import { now } from '#core/utils.ts';
import { runSteps } from '#core/versions/steps.ts';
import { CHAT_LOG_STEPS, CHAT_LOG_VERSION, CHAT_SCHEMA_VERSION, CHAT_STEPS } from '#core/versions/chat.ts';
import type { Chat, ChatLogEntry } from '#core/types.ts';

/** A chat.json is a handful of short fields: anything larger is not one. */
const CHAT_JSON_MAX = 64 * 1024;
/** Where a chat's log stops taking lines: the owner starts a new chat. */
export const CHAT_LOG_MAX = 64 * 1024 * 1024;
/** Room an owner entry needs: CHAT_MESSAGE_MAX characters, every one escaped as JSON can, plus its fields. */
const OWNER_ROOM = 8000 * 6 + 1024;
export const CHAT_LOG_FULL = "this chat's log is full; start a new chat";
export const TITLE_MAX = 120;
export const PAGE_DEFAULT = 500;
export const PAGE_MAX = 1000;
const READ_CHUNK = 1024 * 1024;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

/** What a log line takes in: one of the three kinds, before `v` and `at` are added. */
export type ChatEntryInput = { kind: 'owner'; text: string } | { kind: 'undelivered'; reason: string } | { kind: 'session'; line: string };

const noChat = (id: unknown): ForgeError => new ForgeError(`no chat ${String(id).slice(0, 40)}`, 1);

/** `<chats>/<id>`, for a valid id only. */
function dirOf(root: string, id: string): string {
  if (typeof id !== 'string' || !CHAT_ID.test(id)) throw noChat(id);
  return path.join(paths(root).chats, id);
}

/** Missing, a real directory, or refused (a link, a file or anything else in its place). */
function dirState(p: string): 'missing' | 'dir' | 'refused' {
  try {
    return fs.lstatSync(p).isDirectory() ? 'dir' : 'refused';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'refused';
  }
}

/** A chat's dir when both it and `chats/` are real directories; null when either is missing or refused. */
function realChatDir(root: string, id: string): string | null {
  const dir = dirOf(root, id);
  return dirState(paths(root).chats) === 'dir' && dirState(dir) === 'dir' ? dir : null;
}

const files = (dir: string) => ({ chat: path.join(dir, 'chat.json'), log: path.join(dir, 'log.jsonl') });

/** A title as a chat stores it: oneLineTitle, trimmed, at most TITLE_MAX characters; empty or null is null. */
export function cleanTitle(title: unknown): string | null {
  if (title === null || title === undefined) return null;
  if (typeof title !== 'string') throw new ForgeError('title must be a string or null', 'usage');
  return oneLineTitle(title).slice(0, TITLE_MAX).trim() || null;
}

const isTime = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));

/** A parsed chat.json as a Chat at this version, or null when it is not one (a newer version included). */
function storedChat(raw: unknown, id: string): Chat | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > CHAT_SCHEMA_VERSION) return null;
  const c = runSteps(CHAT_STEPS, raw, v as number);
  if (c.id !== id || (c.title !== null && (typeof c.title !== 'string' || c.title.length > TITLE_MAX))) return null;
  if (c.state !== 'active' && c.state !== 'archived') return null;
  if (!isTime(c.createdAt) || !isTime(c.updatedAt)) return null;
  if (c.sessionId !== null && (typeof c.sessionId !== 'string' || c.sessionId.length > 100)) return null;
  return { schemaVersion: CHAT_SCHEMA_VERSION, id, title: c.title, state: c.state, createdAt: c.createdAt, updatedAt: c.updatedAt, sessionId: c.sessionId };
}

/** Chat `id`, or null when its id is invalid, it has no chat.json, or that file or a dir above it can't be read safely. */
export function readChat(root: string, id: string): Chat | null {
  if (typeof id !== 'string' || !CHAT_ID.test(id)) return null;
  const dir = realChatDir(root, id);
  if (!dir) return null;
  const bytes = readRegular(files(dir).chat, CHAT_JSON_MAX);
  if (typeof bytes === 'string') return null;
  try {
    return storedChat(JSON.parse(bytes.toString('utf8')), id);
  } catch {
    return null;
  }
}

/** Every readable chat, newest updatedAt first; names that are not chat ids, and unreadable chats, are skipped. */
export function listChats(root: string): Chat[] {
  if (dirState(paths(root).chats) !== 'dir') return [];
  let names: string[];
  try {
    names = fs.readdirSync(paths(root).chats);
  } catch {
    return [];
  }
  return names
    .filter((n) => CHAT_ID.test(n))
    .map((n) => readChat(root, n))
    .filter((c): c is Chat => c !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

const withChatsLock = <T>(root: string, fn: () => T): T => withLock(path.join(paths(root).locks, 'chats'), fn);

/** A new active chat with a fresh id, its dirs made real directories below the checkout (confinedDir). */
export function createChat(root: string, opts: { title?: unknown } = {}): Chat {
  const title = cleanTitle(opts.title);
  return withChatsLock(root, () => {
    for (let i = 0; i < 5; i++) {
      const id = crypto.randomBytes(6).toString('hex');
      const dir = dirOf(root, id);
      if (dirState(dir) !== 'missing') continue;
      confinedDir(root, dir);
      const at = now();
      const chat: Chat = { schemaVersion: CHAT_SCHEMA_VERSION, id, title, state: 'active', createdAt: at, updatedAt: at, sessionId: null };
      writeJsonAtomic(files(dir).chat, chat, { root });
      return chat;
    }
    throw new ForgeError('could not pick a fresh chat id');
  });
}

/** The one write path for an existing chat: `fn` gets it under the lock and returns the next one, or null to write nothing. */
function updateChat(root: string, id: string, fn: (c: Chat) => Chat | null): Chat | null {
  return withChatsLock(root, () => {
    const cur = readChat(root, id);
    if (!cur) return null;
    const next = fn(cur);
    if (!next) return cur;
    writeJsonAtomic(files(dirOf(root, id)).chat, next, { root });
    return next;
  });
}

/** Renames a chat (cleanTitle), bumping updatedAt; null when there is no such chat. */
export const renameChat = (root: string, id: string, title: unknown): Chat | null => {
  const t = cleanTitle(title);
  return updateChat(root, id, (c) => ({ ...c, title: t, updatedAt: now() }));
};

/** Archives a chat, bumping updatedAt; null when there is no such chat. */
export const archiveChat = (root: string, id: string): Chat | null => updateChat(root, id, (c) => ({ ...c, state: 'archived', updatedAt: now() }));

/** Bumps updatedAt for a message; null when there is no such chat. */
export const touchChat = (root: string, id: string): Chat | null => updateChat(root, id, (c) => ({ ...c, updatedAt: now() }));

/** Records the chat session's Claude session id; a write only when it changed. */
export const setChatSession = (root: string, id: string, sessionId: string): Chat | null =>
  updateChat(root, id, (c) => (c.sessionId === sessionId ? null : { ...c, sessionId }));

/** The size of a chat's log, 0 when it has none yet. Throws when the chat is missing or its log is no regular file. */
function logSize(root: string, id: string): number {
  const dir = realChatDir(root, id);
  if (!dir) throw noChat(id);
  try {
    const st = fs.lstatSync(files(dir).log);
    if (!st.isFile()) throw new ForgeError(`${files(dir).log} is not a regular file`);
    return st.size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
}

/** Whether a chat's log has no room left for an owner message (or can't be appended at all). */
export function chatLogFull(root: string, id: string): boolean {
  try {
    return logSize(root, id) + OWNER_ROOM > CHAT_LOG_MAX;
  } catch {
    return true;
  }
}

/**
 * Appends one entry, with `v` and `at`, as one write through a descriptor that follows no link and never
 * blocks on a FIFO. Earlier lines are never touched. Throws when the chat is missing, the log is no regular
 * file, or the line would take it past CHAT_LOG_MAX (CHAT_LOG_FULL), writing nothing.
 */
export function appendChatEntry(root: string, id: string, entry: ChatEntryInput): ChatLogEntry {
  // lstat first (logSize): where O_NOFOLLOW is 0 (Windows) the open alone would follow a planted link.
  logSize(root, id);
  const dir = dirOf(root, id);
  const rec = { v: CHAT_LOG_VERSION, at: now(), ...entry } as ChatLogEntry;
  const line = JSON.stringify(rec) + '\n';
  const fd = openAppend(files(dir).log);
  try {
    if (fs.fstatSync(fd).size + Buffer.byteLength(line) > CHAT_LOG_MAX) throw new ForgeError(CHAT_LOG_FULL, 1);
    fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
  return rec;
}

/** A parsed log line as an entry at this version, or null when it is not one. */
function storedEntry(raw: unknown): ChatLogEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = (raw as { v?: unknown }).v;
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > CHAT_LOG_VERSION) return null;
  const e = runSteps(CHAT_LOG_STEPS, raw, v as number);
  if (!isTime(e.at)) return null;
  const base = { v: CHAT_LOG_VERSION, at: e.at };
  if (e.kind === 'owner' && typeof e.text === 'string') return { ...base, kind: 'owner', text: e.text };
  if (e.kind === 'undelivered' && typeof e.reason === 'string') return { ...base, kind: 'undelivered', reason: e.reason };
  if (e.kind === 'session' && typeof e.line === 'string') return { ...base, kind: 'session', line: e.line };
  return null;
}

/** Checks a page's `after` (an index, -1 for the start) and `limit` (1 to PAGE_MAX); throws a usage error. */
export function pageArgs(after: unknown, limit: unknown): { after: number; limit: number } {
  const a = after === undefined ? -1 : after;
  const l = limit === undefined ? PAGE_DEFAULT : limit;
  if (!Number.isSafeInteger(a) || (a as number) < -1) throw new ForgeError('after must be a log index (-1 or more)', 'usage');
  if (!Number.isSafeInteger(l) || (l as number) < 1 || (l as number) > PAGE_MAX) throw new ForgeError(`limit must be 1 to ${PAGE_MAX}`, 'usage');
  return { after: a as number, limit: l as number };
}

/**
 * The entries with index `n > after`, at most `limit`, oldest first, and whether later lines exist. Index `n`
 * is the line's position in log.jsonl: a malformed line is skipped but keeps its index, and a last line with no
 * newline yet (an append in flight) is not a line. Read in chunks through a descriptor that follows no link,
 * so a full log never sits in memory. Null when there is no such chat; throws when the log can't be read safely.
 */
export function readChatLog(root: string, id: string, opts: { after?: number; limit?: number } = {}): { entries: (ChatLogEntry & { n: number })[]; more: boolean } | null {
  const { after, limit } = pageArgs(opts.after, opts.limit);
  if (!readChat(root, id)) return null;
  const file = files(dirOf(root, id)).log;
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], more: false };
    throw e;
  }
  if (!st.isFile()) throw new ForgeError(`${file} is not a regular file`);
  if (st.size > CHAT_LOG_MAX) throw new ForgeError(`${file} is over ${CHAT_LOG_MAX / 1024 / 1024} MiB`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  const entries: (ChatLogEntry & { n: number })[] = [];
  let more = false;
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile() || fst.ino !== st.ino) throw new ForgeError(`${file} changed while it was read`);
    const buf = Buffer.alloc(READ_CHUNK);
    let pos = 0;
    let n = 0;
    let rest: Buffer[] = [];
    const end = Math.min(fst.size, CHAT_LOG_MAX);
    outer: while (pos < end) {
      const got = fs.readSync(fd, buf, 0, Math.min(READ_CHUNK, end - pos), pos);
      if (got <= 0) break;
      pos += got;
      let start = 0;
      for (let nl = buf.indexOf(10, 0); nl !== -1 && nl < got; nl = buf.indexOf(10, start)) {
        const piece = buf.subarray(start, nl);
        start = nl + 1;
        const index = n++;
        if (index <= after) {
          rest = [];
          continue;
        }
        if (entries.length === limit) {
          more = true;
          break outer;
        }
        const text = Buffer.concat([...rest, piece]).toString('utf8');
        rest = [];
        let raw: unknown = null;
        try {
          raw = JSON.parse(text);
        } catch {}
        const entry = storedEntry(raw);
        if (entry) entries.push({ ...entry, n: index });
      }
      if (start < got) rest.push(Buffer.from(buf.subarray(start, got)));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { entries, more };
}
