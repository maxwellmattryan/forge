# lib/office/chat/

The owner's chats with the Foreman: each chat's files in `.forge/runtime/chats/<id>/`, the one path an owner's message takes to its chat session, what a chat may not decide, and the brief a chat session reads first.

- Only the dashboard server writes a chat's files (`lib/server/routes/chats.ts` and `recorder.ts`, which `lib/server/machine.ts` calls on every pool event); `forge chat` (`lib/cli/commands/chat.ts`) only reads them. `store.ts` is the only reader and writer: a chat id is checked against `CHAT_ID` before any path is built, and a link or FIFO in place of `chats/`, `<id>/`, `chat.json` or `log.jsonl` is refused, never followed.
- `send.ts` is the only caller of `Session.writeChat`, the one free-text stdin write, and it refuses every scope that is not a chat's. A chat session spawns only through `startWork` (`lib/office/slots.ts`); never add a second spawn site or another caller of `writeChat`.
- `authority.ts` holds the refusal `forge job human` and `forge job set` give a chat on a reserved gate. Add a new decision a chat could make to it before the CLI writes.
- Board and mandate text reaches `brief.ts`'s output only fenced (`fenced`, `mandateGuidance`, `mandateGoal`), under its data line.
- `chat.json` and log lines are versioned in `lib/core/versions/chat.ts`.
- Design: [Daemon](../../../docs/architecture/daemon.md), [Daemon security](../../../docs/architecture/daemon-security.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `authority.ts` | What a chat session may not decide for the owner: a gate foreman.reserved keeps with a person, by class (`gate:<class>`) or by a reserved pattern in the job, its decision.md or the note, and any accept past a security review that didn't pass. |
| `brief.ts` | `forge chat brief`: what a chat session reads before its first reply, at most 32 KiB of Markdown. |
| `recorder.ts` | The chat log's writer for what a chat session says: the machine dashboard calls it on every pool event (lib/server/machine.ts) before the SSE broadcast. |
| `send.ts` | How an owner's message reaches its chat session: the pool's sendChat checks the pool, then startChat spawns the chat's session through startWork (lib/office/slots.ts, the one spawn site) and writes the message with Session.writeChat. |
| `store.ts` | Chat files: `.forge/runtime/chats/<id>/chat.json` (the chat, at CHAT_SCHEMA_VERSION) and `log.jsonl` (its history, append-only, never rotated). |
<!-- forge:map:end -->
