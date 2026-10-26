// The chat log's writer for what a chat session says: the machine dashboard calls it on every pool event
// (lib/server/machine.ts) before the SSE broadcast. Each line a `_chat-<id>` session logs becomes a `session`
// entry, exactly as `daemons/_chat-<id>.log` has it (already redacted), cut to the replay ring's marker past
// 256 KiB; each new Claude session id the session reports goes into chat.json. Every other scope is ignored.
import { chatIdOf } from '#core/job/requests.ts';
import { capLine } from '../session/log.ts';
import type { SessionEvent } from '../session/contract.ts';
import { appendChatEntry, setChatSession } from './store.ts';

/** The longest session line a chat log keeps as it is. */
export const CHAT_LINE_MAX = 256 * 1024;

/**
 * A pool subscriber for one project's chats. It never throws: a failed write is reported once per chat and
 * distinct message through `report` (stderr by default), never as a session log line, which would itself be
 * recorded back into the chat.
 */
export function createChatRecorder(root: string, report: (message: string) => void = (m) => void process.stderr.write(m)): (e: SessionEvent) => void {
  const sessions = new Map<string, string>();
  const said = new Set<string>();
  const fail = (id: string, e: unknown) => {
    const message = `chat log (${id}): ${(e as Error)?.message ?? String(e)}\n`;
    if (said.has(message)) return;
    said.add(message);
    try {
      report(message);
    } catch {}
  };
  return (e) => {
    const id = chatIdOf(e.scope);
    if (id === null) return;
    try {
      if (e.kind === 'line') appendChatEntry(root, id, { kind: 'session', line: capLine(e.line, CHAT_LINE_MAX) });
      else {
        const sid = e.state.sessionId;
        if (typeof sid !== 'string' || sessions.get(id) === sid) return;
        setChatSession(root, id, sid);
        sessions.set(id, sid);
      }
    } catch (err) {
      fail(id, err);
    }
  };
}
