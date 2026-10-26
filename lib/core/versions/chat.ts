// The chat version steps: a chat's chat.json `schemaVersion` (`.forge/runtime/chats/<id>/chat.json`) is
// CHAT_STEPS' length plus one, and a log.jsonl line's `v` is CHAT_LOG_STEPS' length plus one. Applied on
// read by lib/office/chat/store.ts (readChat, readChatLog); a chat.json is rewritten only by the server's
// next write, and log lines stay as written. Append only (AGENTS.md here): a new step goes at the end,
// with a row keyed by its id in test/schema.test.ts.
import { versionOf } from './steps.ts';
import type { Step } from './steps.ts';

export const CHAT_STEPS: readonly Step[] = [];

export const CHAT_SCHEMA_VERSION = versionOf(CHAT_STEPS);

export const CHAT_LOG_STEPS: readonly Step[] = [];

export const CHAT_LOG_VERSION = versionOf(CHAT_LOG_STEPS);
