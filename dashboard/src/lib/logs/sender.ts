// Who a Thread message or a session log line comes from, and how it shows at a glance: the log's faint tint, and each
// Thread sender's own colour and icon. Pure, so node:test can pin it. Colour is never the only cue: the Thread names the
// sender beside its icon and the log tags each line.
import type { IconName } from '../ui/icons.ts';
import type { ItemKind } from './session-parse.ts';
import type { ThreadFrom } from '../jobs/thread.ts';

/** A log line's sender. cli: the CLI, the supervisor and plumbing; agent: Claude. */
export type Sender = 'cli' | 'agent';

/** Whole literals, so Tailwind sees them. */
export const TINT: Record<Sender, string> = { cli: 'tint cli', agent: 'tint agent' };

/** A log line's sender: Claude's text, thinking, tool calls and subagents are the agent's; the rest is plumbing. */
export function logSender(kind: ItemKind): Sender {
  switch (kind) {
    case 'text':
    case 'thinking':
    case 'tool':
    case 'subagent':
      return 'agent';
    case 'supervisor':
    case 'init':
    case 'result':
    case 'task':
    case 'stderr':
    case 'raw':
    case 'truncated':
    case 'rate-limit':
    case 'denied':
    case 'hook':
    case 'other':
    case 'turn':
      return 'cli';
    default: {
      // A new log kind fails the type check here until it is classified.
      const never: never = kind;
      return never;
    }
  }
}

/**
 * A Thread sender's mark: its icon and its `who` class (style.css), one colour per sender that never changes with the
 * message. You are gleam, the CLI is the muted steel of a terminal, Forge is the ember of its fire, and a tracker has its
 * own hue. Whole literals, so Tailwind sees them.
 */
export const WHO: Record<ThreadFrom, { icon: IconName; cls: string }> = {
  you: { icon: 'agents', cls: 'who you' },
  cli: { icon: 'terminal', cls: 'who cli' },
  forge: { icon: 'anvil', cls: 'who forge' },
  tracker: { icon: 'tracker', cls: 'who tracker' },
};
