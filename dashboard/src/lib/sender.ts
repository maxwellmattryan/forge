// Who a Thread message or a session log line comes from, and the faint tint that shows it at a glance. Pure, so node:test
// can pin it. The tint is never the only cue: the Thread names the sender and the log tags each line.
import type { ItemKind } from './session-parse.ts';
import type { ThreadFrom } from './thread.ts';

/** you: a person (the dashboard or the tracker); cli: the CLI, the supervisor and plumbing; agent: Claude; forge: Forge itself. */
export type Sender = 'you' | 'cli' | 'agent' | 'forge';

/** Whole literals, so Tailwind sees them; `you` keeps the plain plate. */
export const TINT: Record<Sender, string> = { you: '', cli: 'tint cli', agent: 'tint agent', forge: 'tint forge' };

/** A log line's sender: Claude's text, thinking, tool calls and subagents are the agent's; the rest is plumbing. */
export function logSender(kind: ItemKind): 'agent' | 'cli' {
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

/** A Thread message's sender: the dashboard and the tracker are a person, the CLI is plumbing, a daemon session is Forge. */
export function threadSender(from: ThreadFrom): Sender {
  switch (from) {
    case 'you':
    case 'tracker':
      return 'you';
    case 'cli':
      return 'cli';
    case 'forge':
      return 'forge';
    default: {
      const never: never = from;
      return never;
    }
  }
}
