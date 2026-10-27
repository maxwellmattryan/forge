// The Foreman page's chats model: a chat log as owner, note and reply blocks, the forge CLI calls in a reply,
// each block's and item's plain text for Copy, which chat to open, and the GETs and POSTs of /api/chats
// (lib/server/routes/chats.ts). Owner text, titles, reasons and session lines are untrusted: this returns plain strings,
// and the components render them as text or through md(). Plain TS, so a test can pin it. No user-facing text lives here.
import { post } from './focus.ts';
import { projectApi } from './project.ts';
import { DEFAULT_FILTERS, buildSessionView } from './session-log.ts';
import type { Entry, Item } from './session-parse.ts';
import type { Chat, ChatDetail, ChatList, ChatLogEntry, ChatLogPage } from './types.ts';

/** A chat's id, as lib/core/job/requests.ts CHAT_ID: anything else is never put in a URL or a scope. */
export const CHAT_ID = /^[0-9a-f]{12}$/;
export const isChatId = (v: unknown): v is string => typeof v === 'string' && CHAT_ID.test(v);

/** One entry of a chat's log as GET /api/chats/<id>/log pages it: its index `n` is its place in log.jsonl. */
export type ChatEntry = ChatLogEntry & { n: number };

/** What the chat log shows: a message the owner sent, the reason one was not delivered, or the session's reply in between. */
export type ChatBlock =
  | { kind: 'owner'; n: number; at: string; text: string }
  | { kind: 'note'; n: number; at: string; reason: string }
  | { kind: 'reply'; n: number; at: string; items: Item[] };

/**
 * The session-log Entry for a chat entry, one object per entry, so parseEntry's per-entry cache holds across rebuilds
 * and a growing log is not re-parsed on every line.
 */
const asEntry = new WeakMap<ChatEntry, Entry>();
const entryOf = (e: ChatEntry & { kind: 'session' }): Entry => {
  let x = asEntry.get(e);
  if (!x) asEntry.set(e, (x = { offset: e.n, line: e.line }));
  return x;
};

/** A copy of `it` (and of its nested sub-agent items) with each missing `at` taken from its entry's. */
function withAt(it: Item, atOf: ReadonlyMap<number, string>): Item {
  const at = it.at ?? atOf.get(it.offset) ?? null;
  if (it.kind === 'subagent') return { ...it, at, items: it.items.map((c) => withAt(c, atOf)) };
  return { ...it, at };
}

/**
 * The chat log as blocks, in `n` order: each owner entry an owner block, each `undelivered` entry a note, and each run of
 * session entries between them one reply, whose items are the session view's turn items flattened (the owner message
 * stands in for the turn headers), filtered as the session log's defaults are, so thinking is left out. The server
 * refuses a message while the session is busy, so a call and its result fall in one run.
 */
export function buildChatView(entries: readonly ChatEntry[]): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  let run: (ChatEntry & { kind: 'session' })[] = [];
  const flush = (): void => {
    const first = run[0];
    if (!first) return;
    const atOf = new Map(run.map((e) => [e.n, e.at]));
    const view = buildSessionView(run.map(entryOf), DEFAULT_FILTERS);
    blocks.push({ kind: 'reply', n: first.n, at: first.at, items: view.turns.flatMap((t) => t.items).map((it) => withAt(it, atOf)) });
    run = [];
  };
  for (const e of entries) {
    if (e.kind === 'session') {
      run.push(e);
      continue;
    }
    flush();
    if (e.kind === 'owner') blocks.push({ kind: 'owner', n: e.n, at: e.at, text: e.text });
    else if (e.kind === 'undelivered') blocks.push({ kind: 'note', n: e.n, at: e.at, reason: e.reason });
  }
  flush();
  return blocks;
}

/** How long a CLI action's effect may be on its collapsed row. */
export const EFFECT_CHARS = 120;

/** A Bash call's command: the `command` of its input JSON, else its one-line summary. */
function bashCommand(it: Item & { kind: 'tool' }): string {
  try {
    const v: unknown = JSON.parse(it.input);
    const c = v && typeof v === 'object' ? (v as { command?: unknown }).command : undefined;
    if (typeof c === 'string') return c;
  } catch {}
  return it.summary;
}

/**
 * A Bash call to the forge CLI: its command (trimmed, starting `forge `), its effect (the first non-empty line of the full
 * result, cut to EFFECT_CHARS; null while no result has come) and whether the result is an error. Null for anything else.
 */
export function cliAction(it: Item): { command: string; effect: string | null; isError: boolean } | null {
  if (it.kind !== 'tool' || it.name !== 'Bash') return null;
  const command = bashCommand(it).trim();
  if (!command.startsWith('forge ')) return null;
  const r = it.result;
  const effect = r ? (r.full.split('\n').find((l) => l.trim() !== '') ?? '').trim().slice(0, EFFECT_CHARS) : null;
  return { command, effect, isError: r?.isError === true };
}

/** What Copy puts on the clipboard: a block's or an item's plain text, as the log shows it. */
export function copyText(x: ChatBlock | Item): string {
  switch (x.kind) {
    case 'owner':
      return x.text;
    case 'note':
      return x.reason;
    case 'reply':
      return x.items.map(copyText).join('\n\n');
    case 'tool':
      return x.result ? `${x.input}\n\n${x.result.full}` : x.input;
    case 'subagent':
      return x.result?.full || x.prompt;
    case 'init':
      return [x.model, x.session].filter(Boolean).join(' · ');
    default:
      return x.text;
  }
}

/** The chat to open: `saved` while it is in the list, else the first active chat, else none. A malformed id is never one. */
export function pickChat(chats: readonly Pick<Chat, 'id' | 'state'>[], saved: string | null | undefined): string | null {
  if (isChatId(saved) && chats.some((c) => c.id === saved)) return saved;
  return chats.find((c) => c.state === 'active' && isChatId(c.id))?.id ?? null;
}

// ---------- the API ----------

/** `/api/chats/<id>`, or a throw before anything is fetched when `id` is not a chat id. */
function chatPath(id: string): string {
  if (!isChatId(id)) throw new Error(`no chat ${JSON.stringify(String(id).slice(0, 40))}`);
  return `/api/chats/${id}`;
}

/** A GET to this page's project with the token; throws with the server's `error` field, else its text, else the status text (as post). */
async function getJson<T>(url: string, token: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(projectApi(url), { headers: { 'x-forge-token': token } });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  const error = parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string' ? (parsed as { error: string }).error : '';
  if (!res.ok) throw new Error(error || text || res.statusText);
  return parsed as T;
}

/** GET /api/chats: every chat, newest updatedAt first. */
export const listChats = (token: string, fetchImpl: typeof fetch = fetch): Promise<ChatList> => getJson<ChatList>('/api/chats', token, fetchImpl);

/** POST /api/chats `{}`: a new, untitled chat. */
export const createChat = (token: string, fetchImpl: typeof fetch = fetch): Promise<{ chat: Chat }> => post<{ chat: Chat }>('/api/chats', {}, token, fetchImpl);

/** POST /api/chats/<id>/rename: the title trimmed, an empty one as null (untitled); the server makes it one line. */
export async function renameChat(id: string, title: string | null, token: string, fetchImpl: typeof fetch = fetch): Promise<{ chat: Chat }> {
  return post<{ chat: Chat }>(`${chatPath(id)}/rename`, { title: title?.trim() || null }, token, fetchImpl);
}

/** POST /api/chats/<id>/archive `{}`: archived for good, its session stopped. */
export async function archiveChat(id: string, token: string, fetchImpl: typeof fetch = fetch): Promise<{ chat: Chat }> {
  return post<{ chat: Chat }>(`${chatPath(id)}/archive`, {}, token, fetchImpl);
}

/** POST /api/chats/<id>/messages `{ text }`, the text as typed: the chat and its session's state after the hand-off. */
export async function sendChatMessage(id: string, text: string, token: string, fetchImpl: typeof fetch = fetch): Promise<ChatDetail> {
  return post<ChatDetail>(`${chatPath(id)}/messages`, { text }, token, fetchImpl);
}

/** GET /api/chats/<id>: the chat and its session's state. */
export async function fetchChat(id: string, token: string, fetchImpl: typeof fetch = fetch): Promise<ChatDetail> {
  return getJson<ChatDetail>(chatPath(id), token, fetchImpl);
}

/** How many entries one log page asks for. */
export const CHAT_PAGE = 1000;

/** GET /api/chats/<id>/log?after=<after>&limit=CHAT_PAGE: the entries after index `after` (-1 for the start), oldest first. */
export async function fetchChatLog(id: string, after: number, token: string, fetchImpl: typeof fetch = fetch): Promise<ChatLogPage> {
  const path = chatPath(id);
  if (!Number.isInteger(after) || after < -1) throw new Error(`bad log cursor ${after}`);
  return getJson<ChatLogPage>(`${path}/log?after=${after}&limit=${CHAT_PAGE}`, token, fetchImpl);
}
