// `forge chat list|show|brief`: the owner's chats with the Foreman, read-only. Only the dashboard server
// writes a chat (lib/server/routes/chats.ts); these read its files (lib/office/chat/store.ts) and build the
// brief a chat session reads first (lib/office/chat/brief.ts). docs/architecture/daemon.md › Chats.
import { ForgeError } from '#core/errors.ts';
import { chatBrief } from '#office/chat/brief.ts';
import { listChats, pageArgs, readChat, readChatLog } from '#office/chat/store.ts';
import { usageError } from './args.ts';
import type { CliContext, Dispatched, HelpGroup } from '../types.ts';

const DOCS: [string, string] = ['Daemon', 'docs/architecture/daemon.md'];

const CHAT: HelpGroup = {
  name: 'chat',
  summary: "the owner's chats with the Foreman in .forge/runtime/chats/, read-only",
  commands: [
    {
      command: 'chat list',
      args: '[--all]',
      summary: 'the chats, newest first ({chats})',
      flags: [['--all', 'archived chats too']],
      docs: DOCS,
    },
    {
      command: 'chat show',
      args: '<id> [--after N] [--limit M]',
      summary: "a chat and a page of its log, unredacted ({chat, entries, more}): the entries with index n > N, oldest first; a malformed line is skipped but keeps its index",
      flags: [
        ['--after N', 'the last index already read (default -1: from the start)'],
        ['--limit M', 'at most M entries, 1-1000 (default 500)'],
      ],
      exits: [[1, 'no such chat, or its files cannot be read safely']],
      docs: DOCS,
    },
    {
      command: 'chat brief',
      args: '',
      summary: "what a chat session reads before its first reply ({chat, procedure, brief}): the chat id in a chat session (else null), the procedure file, and at most 32 KiB of board and mandates, fenced as data",
      docs: DOCS,
    },
  ],
};

export const HELP: HelpGroup[] = [CHAT];

/** A paging flag: absent, or an integer as text; anything else is NaN, which pageArgs refuses. */
const intFlag = (v: unknown): number | undefined => (v === undefined ? undefined : /^-?\d{1,15}$/.test(String(v)) ? Number(v) : NaN);

export function chatCmd(ctx: CliContext, sub: string | undefined, rest: string[], flags: Record<string, unknown>): Dispatched {
  const { root, config } = ctx;
  if (sub === 'list') {
    if (rest.length) throw usageError(CHAT, sub);
    const chats = listChats(root);
    return { data: { chats: flags.all === true ? chats : chats.filter((c) => c.state === 'active') }, exitCode: 0 };
  }
  if (sub === 'show') {
    if (rest.length !== 1) throw usageError(CHAT, sub);
    const id = rest[0]!;
    const args = pageArgs(intFlag(flags.after), intFlag(flags.limit));
    const chat = readChat(root, id);
    const page = chat ? readChatLog(root, id, args) : null;
    if (!chat || !page) throw new ForgeError(`no chat ${id.slice(0, 60)}`, 1);
    return { data: { chat, entries: page.entries, more: page.more }, exitCode: 0 };
  }
  if (sub === 'brief') {
    if (rest.length) throw usageError(CHAT, sub);
    return { data: chatBrief(root, config), exitCode: 0 };
  }
  throw usageError(CHAT);
}
