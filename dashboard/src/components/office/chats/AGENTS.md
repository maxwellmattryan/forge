# dashboard/src/components/office/chats/

The Foreman page's chats: the chat list, the open chat, its header and its composer.

- `ChatView.svelte` owns the open chat's fetches; the chats model lives in `src/lib/office/chats.ts`.
- Design: [Working on the dashboard](../../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `ChatComposer.svelte` | The open chat's composer (office/chats/ChatView.svelte): a text area and Send. |
| `ChatHeader.svelte` | The open chat's header (office/chats/ChatView.svelte): its title (or "Untitled chat"), its session's status pill, the chat Rendered/Raw toggle, and Rename and Archive. |
| `ChatView.svelte` | One open chat (ChatsPanel keys it by id): ChatHeader, the log, the chat session's permission prompts, and ChatComposer. |
| `ChatsPanel.svelte` | The Foreman page's chats: the chat list beside the open chat (at lg and up; below, the list sits above it). |
<!-- forge:map:end -->
