// Chat routes: the owner's chats with the Foreman. List, create, rename and archive a chat, read its
// session's state and a page of its log, and send it a message, which the pool hands to the chat's own
// session (lib/office/chat/send.ts). The id is matched by the route pattern ([0-9a-f]{12}) before any
// path is built; the store (lib/office/chat/store.ts) checks it again. docs/architecture/dashboard-security.md.
import type http from 'node:http';
import { loadConfig } from '#core/config/load.ts';
import { CHAT_MESSAGE_MAX } from '#api/constants.ts';
import { chatScope } from '#core/job/requests.ts';
import { redactDeep, redactKnown, scopeKnownValues } from '#engine/guard/known-secrets.ts';
import { CHAT_BUSY } from '#office/chat/send.ts';
import { CHAT_LOG_FULL, appendChatEntry, archiveChat, chatLogFull, createChat, listChats, pageArgs, readChat, readChatLog, renameChat, touchChat } from '#office/chat/store.ts';
import { offState } from '#office/session/records.ts';
import type { Chat, ChatDetail, ChatList, ChatLogPage, DaemonSessionState } from '#core/types.ts';
import { json, jsonStatus, readBody } from '../http.ts';
import type { RouteMatch, ServerCtx } from '../types.ts';

/** The JSON object a POST carries, or null when it is not one (the caller answers 400). */
async function bodyObject(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    const body = JSON.parse((await readBody(req)) || '{}');
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

const notJson = (res: http.ServerResponse) => jsonStatus(res, 400, { error: 'body is not a JSON object' });
const noChat = (res: http.ServerResponse, id: string) => jsonStatus(res, 404, { error: `no chat ${id}` });
const isTitle = (v: unknown): boolean => v === null || typeof v === 'string';

/** The chat's session as the pool holds it, or the off state from its record; redacted like a state frame. */
function sessionOf(ctx: ServerCtx, scope: string): DaemonSessionState {
  const st = ctx.pool ? ctx.pool.sessionState(scope) : offState(ctx.root, scope);
  return redactDeep(st, scopeKnownValues(ctx.root, scope, loadConfig(ctx.root).config));
}

/** GET /chats: every chat, newest first. */
export function getChats(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse): void {
  json(res, { chats: listChats(ctx.root) } satisfies ChatList);
}

/** POST /chats `{ title? }`: a new active chat. */
export async function postChat(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const obj = await bodyObject(req);
  if (!obj) return notJson(res);
  if (obj.title !== undefined && !isTitle(obj.title)) return jsonStatus(res, 400, { error: 'title must be a string or null' });
  json(res, { chat: createChat(ctx.root, { title: obj.title ?? null }) } satisfies { chat: Chat });
}

/** GET /chats/<id>: the chat and its session's state. */
export function getChat(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): void {
  const id = match.params[0]!;
  const chat = readChat(ctx.root, id);
  if (!chat) return noChat(res, id);
  json(res, { chat, session: sessionOf(ctx, chatScope(id)) } satisfies ChatDetail);
}

/** An `after` or `limit` query value: absent, or an integer as text; NaN for anything else, which pageArgs refuses. */
const queryInt = (v: string | null): number | undefined => (v === null ? undefined : /^-?\d{1,15}$/.test(v) ? Number(v) : NaN);

/** GET /chats/<id>/log?after=N&limit=M: a page of the log, every owner text and session line redacted. */
export function getChatLog(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): void {
  const id = match.params[0]!;
  let args: { after: number; limit: number };
  try {
    args = pageArgs(queryInt(match.url.searchParams.get('after')), queryInt(match.url.searchParams.get('limit')));
  } catch (e) {
    return jsonStatus(res, 400, { error: (e as Error).message });
  }
  const page = readChatLog(ctx.root, id, args);
  if (!page) return noChat(res, id);
  const known = scopeKnownValues(ctx.root, chatScope(id), loadConfig(ctx.root).config);
  const entries = page.entries.map((e) => (e.kind === 'owner' ? { ...e, text: redactKnown(e.text, known) } : e.kind === 'session' ? { ...e, line: redactKnown(e.line, known) } : e));
  json(res, { id, entries, more: page.more } satisfies ChatLogPage);
}

/** POST /chats/<id>/rename `{ title }`. */
export async function postChatRename(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): Promise<void> {
  const id = match.params[0]!;
  const obj = await bodyObject(req);
  if (!obj) return notJson(res);
  if (!isTitle(obj.title)) return jsonStatus(res, 400, { error: 'title must be a string or null' });
  const chat = renameChat(ctx.root, id, obj.title);
  if (!chat) return noChat(res, id);
  json(res, { chat } satisfies { chat: Chat });
}

/** POST /chats/<id>/archive `{}`: archived for good, and its session stopped and dropped. */
export async function postChatArchive(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): Promise<void> {
  const id = match.params[0]!;
  if (!(await bodyObject(req))) return notJson(res);
  const chat = archiveChat(ctx.root, id);
  if (!chat) return noChat(res, id);
  await ctx.pool?.dropSession(chatScope(id));
  json(res, { chat } satisfies { chat: Chat });
}

/**
 * POST /chats/<id>/messages `{ text }`. Every check runs before the log is touched: the text, the chat, its
 * state, the pool, the session and the log's room. Then the owner entry, and the hand-off to the pool; a
 * hand-off the pool refuses leaves an `undelivered` entry after it and answers 409 with the pool's error.
 */
export async function postChatMessage(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): Promise<void> {
  const id = match.params[0]!;
  const obj = await bodyObject(req);
  if (!obj) return notJson(res);
  const text = obj.text;
  if (typeof text !== 'string' || !text.trim() || text.length > CHAT_MESSAGE_MAX) return jsonStatus(res, 400, { error: `text must be a non-empty string of at most ${CHAT_MESSAGE_MAX} characters` });
  const chat = readChat(ctx.root, id);
  if (!chat) return noChat(res, id);
  if (chat.state !== 'active') return jsonStatus(res, 409, { error: `chat ${id} is archived` });
  const pool = ctx.pool;
  if (!pool || !pool.state().wanted) return jsonStatus(res, 409, { error: 'start the daemon first' });
  const scope = chatScope(id);
  const status = pool.sessionState(scope).status;
  if (status === 'busy' || status === 'stopping') return jsonStatus(res, 409, { error: CHAT_BUSY });
  if (chatLogFull(ctx.root, id)) return jsonStatus(res, 409, { error: CHAT_LOG_FULL });
  appendChatEntry(ctx.root, id, { kind: 'owner', text });
  touchChat(ctx.root, id);
  const sent = pool.sendChat(scope, text);
  if (sent.error !== null) {
    try {
      appendChatEntry(ctx.root, id, { kind: 'undelivered', reason: sent.error });
    } catch {
      // The log that took the owner entry a moment ago refused this one; the 409 still says why.
    }
    return jsonStatus(res, 409, { error: sent.error });
  }
  json(res, { chat: readChat(ctx.root, id) ?? chat, session: sessionOf(ctx, scope) } satisfies ChatDetail);
}
