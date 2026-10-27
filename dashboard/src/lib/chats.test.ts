// The Chats panel's model: the chat log as owner, note and reply blocks, the forge CLI calls in a reply, each block's
// and item's Copy text, which chat opens, the /api/chats helpers' requests, and the chat scopes the engine also checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveChat, buildChatView, cliAction, copyText, createChat, fetchChat, fetchChatLog, listChats, pickChat, renameChat, sendChatMessage, type ChatEntry } from './chats.ts';
import { setProject } from './project.ts';
import { CHAT_MESSAGE_MAX, CHAT_SCOPE_PREFIX, chatScope, isChatScope, sharedScope } from './types.ts';
import type { Item } from './session-parse.ts';
import type { Chat } from './types.ts';

setProject('web');

const at = (s: number): string => `2026-10-26T10:00:${String(s).padStart(2, '0')}.000Z`;
const owner = (n: number, text: string): ChatEntry => ({ v: 1, n, at: at(n), kind: 'owner', text });
const note = (n: number, reason: string): ChatEntry => ({ v: 1, n, at: at(n), kind: 'undelivered', reason });
const session = (n: number, line: unknown): ChatEntry => ({ v: 1, n, at: at(n), kind: 'session', line: typeof line === 'string' ? line : JSON.stringify(line) });
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({ type: 'assistant', message: { content }, ...extra });
const toolResult = (id: string, content: string, extra: Record<string, unknown> = {}, isError = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, ...extra });

test('buildChatView orders owner messages, notes and replies', () => {
  assert.deepEqual(buildChatView([]), []);
  const entries = [
    owner(0, 'What is waiting on me?'),
    session(1, assistant([{ type: 'thinking', thinking: 'let me look' }, { type: 'text', text: 'Checking the board.' }])),
    session(2, assistant([{ type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'Explore', description: 'look', prompt: 'Look around' } }], { timestamp: '2026-10-26T09:00:00.000Z' })),
    session(3, assistant([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'forge run job test' } }], { parent_tool_use_id: 'a1' })),
    session(4, toolResult('b1', 'ok', { parent_tool_use_id: 'a1' })),
    session(5, toolResult('a1', 'all good')),
    session(6, 'not json {'),
    session(7, { type: 'result', subtype: 'success', num_turns: 1 }),
    owner(8, 'Thanks'),
    note(9, 'start the daemon first'),
    session(10, assistant([{ type: 'text', text: 'Again' }])),
  ];
  const blocks = buildChatView(entries);
  assert.deepEqual(
    blocks.map((b) => [b.kind, b.n, b.at]),
    [
      ['owner', 0, at(0)],
      ['reply', 1, at(1)],
      ['owner', 8, at(8)],
      ['note', 9, at(9)],
      ['reply', 10, at(10)],
    ],
  );
  assert.deepEqual(blocks[0], { kind: 'owner', n: 0, at: at(0), text: 'What is waiting on me?' });
  assert.deepEqual(blocks[3], { kind: 'note', n: 9, at: at(9), reason: 'start the daemon first' });
  const reply = blocks[1]!;
  assert.ok(reply.kind === 'reply');
  // Thinking is left out; the malformed line is a raw item in its place; the turn headers are gone.
  assert.deepEqual(
    reply.items.map((it) => [it.kind, it.offset, it.at]),
    [
      ['text', 1, at(1)],
      ['subagent', 2, '2026-10-26T09:00:00.000Z'],
      ['raw', 6, at(6)],
      ['result', 7, at(7)],
    ],
  );
  const sub = reply.items[1]!;
  assert.ok(sub.kind === 'subagent');
  assert.equal(sub.result?.full, 'all good');
  // A nested item with no `at` takes its own entry's.
  assert.deepEqual(
    sub.items.map((it) => [it.kind, it.offset, it.at, it.kind === 'tool' ? it.result?.full : null]),
    [['tool', 3, at(3), 'ok']],
  );
  // Nothing in the input is changed, and a rebuild gives the same blocks.
  assert.deepEqual(buildChatView(entries), blocks);
});

const tool = (command: unknown, result: { full: string; isError?: boolean } | null, name = 'Bash'): Item => ({
  kind: 'tool',
  offset: 1,
  at: null,
  tone: null,
  id: 't1',
  name,
  summary: typeof command === 'string' ? command.split('\n')[0]! : '',
  input: JSON.stringify(command === undefined ? {} : { command }, null, 2),
  result: result ? { isError: result.isError === true, preview: result.full.slice(0, 300), full: result.full, more: result.full.length > 300 } : null,
  task: null,
});

test('cliAction finds forge commands and their effect', () => {
  assert.deepEqual(cliAction(tool('forge job show 7', { full: '\n  \n  stage: build\nmore' })), { command: 'forge job show 7', effect: 'stage: build', isError: false });
  assert.deepEqual(cliAction(tool('  forge status  ', null)), { command: 'forge status', effect: null, isError: false });
  assert.deepEqual(cliAction(tool('forge run x test', { full: 'boom', isError: true })), { command: 'forge run x test', effect: 'boom', isError: true });
  const long = `${'x'.repeat(300)}\nsecond`;
  assert.equal(cliAction(tool('forge chat brief', { full: long }))?.effect, 'x'.repeat(120));
  for (const other of ['git status', 'forgery x', 'echo forge x', 'forge', 'Forge status']) assert.equal(cliAction(tool(other, { full: 'x' })), null, other);
  assert.equal(cliAction(tool('forge status', { full: 'x' }, 'Read')), null, 'another tool');
  assert.equal(cliAction({ kind: 'text', offset: 1, at: null, tone: null, text: 'forge status', long: false }), null);
  // An input that doesn't parse falls back to the summary.
  assert.equal(cliAction({ ...(tool('x', null) as Item & { kind: 'tool' }), input: '{not json', summary: 'forge doctor' })?.command, 'forge doctor');
});

test('copyText is each item\'s plain text', () => {
  const base = { offset: 1, at: null, tone: null };
  const text: Item = { ...base, kind: 'text', text: 'Hello **there**', long: false };
  const subagent: Item = { ...base, kind: 'subagent', id: 'a', role: 'Explore', description: 'd', summary: 's', input: '{}', prompt: 'Look around', items: [], result: null, known: true, hidden: 0, task: null };
  const rows: [Parameters<typeof copyText>[0], string][] = [
    [{ kind: 'owner', n: 0, at: at(0), text: 'Owner <b>text</b>' }, 'Owner <b>text</b>'],
    [{ kind: 'note', n: 1, at: at(1), reason: 'busy' }, 'busy'],
    [text, 'Hello **there**'],
    [{ ...base, kind: 'thinking', text: 'hmm' }, 'hmm'],
    [tool('forge status', null), '{\n  "command": "forge status"\n}'],
    [tool('forge status', { full: 'all\nfine' }), '{\n  "command": "forge status"\n}\n\nall\nfine'],
    [subagent, 'Look around'],
    [{ ...subagent, result: { isError: false, preview: 'done', full: 'done in full', more: false } }, 'done in full'],
    [{ ...base, kind: 'init', model: 'claude-opus', session: 'abcd1234' }, 'claude-opus · abcd1234'],
    [{ ...base, kind: 'init', model: '', session: 'abcd1234' }, 'abcd1234'],
    [{ ...base, kind: 'result', text: 'success · 1 turns', costUsd: null }, 'success · 1 turns'],
    [{ ...base, kind: 'supervisor', event: 'spawn', text: 'spawned' }, 'spawned'],
    [{ ...base, kind: 'raw', text: 'not json {' }, 'not json {'],
    [{ kind: 'reply', n: 2, at: at(2), items: [text, { ...base, kind: 'raw', text: 'raw' }] }, 'Hello **there**\n\nraw'],
  ];
  for (const [x, want] of rows) assert.equal(copyText(x), want, x.kind);
});

const chat = (id: string, state: Chat['state'] = 'active'): Chat => ({ schemaVersion: 1, id, title: null, state, createdAt: at(0), updatedAt: at(0), sessionId: null });

test('pickChat keeps the saved chat or falls back', () => {
  const list = [chat('aaaaaaaaaaaa', 'archived'), chat('bbbbbbbbbbbb'), chat('cccccccccccc')];
  assert.equal(pickChat(list, 'cccccccccccc'), 'cccccccccccc');
  assert.equal(pickChat(list, 'aaaaaaaaaaaa'), 'aaaaaaaaaaaa', 'an archived chat opens read-only');
  assert.equal(pickChat(list, '0123456789ab'), 'bbbbbbbbbbbb', 'gone: the first active chat');
  for (const bad of ['', null, undefined, 'BBBBBBBBBBBB', '../x', 'bbbbbbbbbbb']) assert.equal(pickChat(list, bad), 'bbbbbbbbbbbb', String(bad));
  assert.equal(pickChat([chat('aaaaaaaaaaaa', 'archived')], ''), null);
  assert.equal(pickChat([], 'aaaaaaaaaaaa'), null);
  assert.equal(pickChat([chat('nope'), chat('dddddddddddd')], ''), 'dddddddddddd', 'a malformed id is never picked');
});

test('chat API helpers send the token and refuse bad ids', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let reply: { status: number; body: string } = { status: 200, body: '{"ok":true}' };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(reply.body, { status: reply.status, statusText: 'Nope' });
  }) as typeof fetch;
  const id = '0123456789ab';
  const rows: [() => Promise<unknown>, string, string | null, unknown][] = [
    [() => listChats('tok', fetchImpl), '/api/p/web/chats', null, null],
    [() => createChat('tok', fetchImpl), '/api/p/web/chats', 'POST', {}],
    [() => renameChat(id, '  New name ', 'tok', fetchImpl), `/api/p/web/chats/${id}/rename`, 'POST', { title: 'New name' }],
    [() => renameChat(id, '   ', 'tok', fetchImpl), `/api/p/web/chats/${id}/rename`, 'POST', { title: null }],
    [() => archiveChat(id, 'tok', fetchImpl), `/api/p/web/chats/${id}/archive`, 'POST', {}],
    [() => sendChatMessage(id, '  as typed\n', 'tok', fetchImpl), `/api/p/web/chats/${id}/messages`, 'POST', { text: '  as typed\n' }],
    [() => fetchChat(id, 'tok', fetchImpl), `/api/p/web/chats/${id}`, null, null],
    [() => fetchChatLog(id, -1, 'tok', fetchImpl), `/api/p/web/chats/${id}/log?after=-1&limit=1000`, null, null],
    [() => fetchChatLog(id, 41, 'tok', fetchImpl), `/api/p/web/chats/${id}/log?after=41&limit=1000`, null, null],
  ];
  for (const [call, url, method, body] of rows) {
    calls.length = 0;
    assert.deepEqual(await call(), { ok: true }, url);
    assert.equal(calls.length, 1);
    const { url: got, init } = calls[0]!;
    assert.equal(got, url);
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers['x-forge-token'], 'tok', url);
    if (method) {
      assert.equal(init?.method, method);
      assert.equal(headers['content-type'], 'application/json');
      assert.deepEqual(JSON.parse(String(init?.body)), body);
    } else assert.equal(init?.method, undefined, `${url} is a GET`);
  }
  // A non-2xx throws the server's error, else its text, else the status text.
  for (const [body, want] of [['{"error":"chat 0123456789ab is archived"}', 'chat 0123456789ab is archived'], ['plain text', 'plain text'], ['', 'Nope']]) {
    reply = { status: 409, body };
    await assert.rejects(sendChatMessage(id, 'hi', 'tok', fetchImpl), { message: want });
    await assert.rejects(fetchChat(id, 'tok', fetchImpl), { message: want });
  }
  // A bad id throws before anything is fetched.
  calls.length = 0;
  for (const bad of ['', '0123456789AB', '0123456789a', '0123456789abc', '../chats', 'x/../../y']) {
    await assert.rejects(renameChat(bad, 't', 'tok', fetchImpl), /no chat/);
    await assert.rejects(archiveChat(bad, 'tok', fetchImpl), /no chat/);
    await assert.rejects(sendChatMessage(bad, 't', 'tok', fetchImpl), /no chat/);
    await assert.rejects(fetchChat(bad, 'tok', fetchImpl), /no chat/);
    await assert.rejects(fetchChatLog(bad, 0, 'tok', fetchImpl), /no chat/);
  }
  await assert.rejects(fetchChatLog(id, 1.5, 'tok', fetchImpl), /cursor/);
  assert.equal(calls.length, 0);
});

test('chat scopes match the engine', () => {
  assert.equal(CHAT_SCOPE_PREFIX, '_chat-');
  assert.equal(CHAT_MESSAGE_MAX, 8000);
  assert.ok(isChatScope('_chat-0123456789ab'));
  for (const bad of ['_chat-', '_chat-0123456789AB', '_chat-0123456789a', '_chat-0123456789abc', '_chats', '_chats0123456789ab', '_chat-0123456789ab\n', 7, null, undefined, {}]) {
    assert.equal(isChatScope(bad), false, String(bad));
  }
  assert.equal(chatScope('0123456789ab'), '_chat-0123456789ab');
  for (const bad of ['', 'ABCDEF012345', '0123456789a', '../x']) assert.throws(() => chatScope(bad), /no chat/, bad);
  assert.ok(sharedScope('_chat-0123456789ab'));
  assert.ok(!sharedScope('_chat-nope'));
  assert.ok(sharedScope('_inbox') && sharedScope('_office') && !sharedScope('_assistant-2') && !sharedScope('some-job'));
});
