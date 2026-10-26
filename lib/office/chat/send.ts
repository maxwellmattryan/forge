// How an owner's message reaches its chat session: the pool's sendChat checks the pool, then startChat
// spawns the chat's session through startWork (lib/office/slots.ts, the one spawn site) and writes the
// message with Session.writeChat. This is the only path owner text takes to any session's stdin, and it
// refuses every scope that is not a chat. docs/architecture/daemon-security.md › Chats.
import { isChatScope } from '#core/job/requests.ts';
import { startWork } from '../slots.ts';
import type { Session } from '../session/contract.ts';
import type { Config } from '#core/types.ts';

/** A chat whose session is mid-reply (or stopping) takes no message: one owner turn at a time. */
export const CHAT_BUSY = 'the Foreman is still replying in this chat';
/** What a scoped start of a chat session answers: only a message starts one. */
export const CHAT_START = 'a chat session starts when the owner sends it a message';
const NO_START = 'the chat session could not start';

/**
 * Spawns `s` when no child runs, then hands it `text` as one owner message. Refuses a session that is not a
 * chat's, and a busy or stopping one, before anything is spawned or written. A refused spawn answers the
 * session's own error, else a generic one.
 */
export function startChat(s: Session, c: Config, text: string): { error: string | null } {
  if (!isChatScope(s.scope)) return { error: `${s.scope} is not a chat session` };
  if (s.status === 'busy' || s.status === 'stopping') return { error: CHAT_BUSY };
  if (!startWork(s, c, 'chat', null)) return { error: s.lastError ?? NO_START };
  try {
    s.writeChat(text);
  } catch (e) {
    return { error: (e as Error).message };
  }
  return { error: null };
}

/** What sendChat needs of its pool. */
export interface ChatPool {
  /** The pool is started and not closing. */
  wanted(): boolean;
  /** The scope's session, created when the pool has none. */
  session(scope: string): Session;
  /** Reads `.forge/config.yml`; throws when it can't be read. */
  config(): Config;
  /** The pool's last error: what a spawn refused repo-wide (trust, config, daily cap) says. */
  lastError(): string | null;
}

/**
 * The pool's sendChat: a chat scope, a wanted pool, then startChat. A message is the owner's start, so a
 * chat session that stopped wanting itself (a daily cap, failed starts) is reset first.
 */
export function sendChat(pool: ChatPool, scope: string, text: string): { error: string | null } {
  if (!isChatScope(scope)) return { error: 'invalid chat scope' };
  if (!pool.wanted()) return { error: 'start the daemon first' };
  const s = pool.session(scope);
  if (!s.wanted) s.reset();
  let c: Config;
  try {
    c = pool.config();
  } catch (e) {
    return { error: `cannot start daemon: ${(e as Error).message}` };
  }
  const r = startChat(s, c, text);
  // A repo-wide refusal (trust, config) is the pool's error, not the session's.
  return r.error === NO_START && pool.lastError() ? { error: pool.lastError() } : r;
}
