// The chat files through the store's own functions, over a scratch repo: chat.json's shape and its writes,
// the append-only log and its pages, the confined reads that refuse a link in place of a dir or a file, and
// the 64 MiB cap. The recorder rows drive it with the pool's own event shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { CHAT_ID } from '#core/job/requests.ts';
import { paths } from '#core/paths.ts';
import { CHAT_LINE_MAX, createChatRecorder } from './recorder.ts';
import { CHAT_LOG_FULL, CHAT_LOG_MAX, appendChatEntry, archiveChat, chatLogFull, createChat, listChats, readChat, readChatLog, renameChat, setChatSession, touchChat } from './store.ts';

/** A symlink, or false where the platform refuses to make one (Windows without the privilege). */
function link(target: string, p: string): boolean {
  try {
    fs.symlinkSync(target, p, fs.statSync(target).isDirectory() ? 'dir' : 'file');
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw e;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('chat files: create, rename, archive, append, page and confined reads', async (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  const root = r.dir;
  assert.deepEqual(listChats(root), [], 'no chats dir yet');

  const a = createChat(root, { title: '  Plan the\nrelease  ' });
  assert.match(a.id, CHAT_ID);
  assert.deepEqual({ ...a, id: 'x', createdAt: 'x', updatedAt: 'x' }, { schemaVersion: 1, id: 'x', title: 'Plan the release', state: 'active', createdAt: 'x', updatedAt: 'x', sessionId: null });
  assert.equal(a.createdAt, a.updatedAt);
  const file = path.join(paths(root).chats, a.id, 'chat.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), a, 'chat.json holds the shape');
  assert.deepEqual(readChat(root, a.id), a);
  assert.equal(createChat(root, { title: '   ' }).title, null, 'an empty title is null');
  assert.equal(createChat(root, { title: 'x'.repeat(300) }).title, 'x'.repeat(120));
  assert.throws(() => createChat(root, { title: 7 }), /title must be a string or null/);
  await tick();

  const b = createChat(root, {});
  assert.equal(listChats(root)[0].id, b.id, 'newest first');
  await tick();
  const renamed = renameChat(root, a.id, 'Release\tplan');
  assert.equal(renamed?.title, 'Release plan');
  assert.ok(renamed!.updatedAt > a.updatedAt);
  assert.equal(listChats(root)[0].id, a.id, 'a rename bumps it to the top');
  assert.equal(archiveChat(root, a.id)?.state, 'archived');
  assert.equal(readChat(root, a.id)?.state, 'archived');
  assert.equal(setChatSession(root, b.id, '11111111-2222-4333-8444-555555555555')?.sessionId, '11111111-2222-4333-8444-555555555555');
  assert.equal(readChat(root, b.id)?.sessionId, '11111111-2222-4333-8444-555555555555');
  assert.ok(touchChat(root, b.id));
  for (const missing of ['ffffffffffff', 'NOTANID', '../x']) {
    assert.equal(readChat(root, missing), null, missing);
    assert.equal(renameChat(root, 'ffffffffffff', 'x'), null);
  }

  // The log: each line stamped with v and at, earlier lines never touched, paged by index.
  const log = path.join(paths(root).chats, b.id, 'log.jsonl');
  const first = appendChatEntry(root, b.id, { kind: 'owner', text: 'hello\nthere' });
  assert.deepEqual([first.v, typeof first.at], [1, 'string']);
  const before = fs.readFileSync(log);
  appendChatEntry(root, b.id, { kind: 'undelivered', reason: 'start the daemon first' });
  fs.appendFileSync(log, '{not json\n');
  appendChatEntry(root, b.id, { kind: 'session', line: '{"type":"assistant"}' });
  assert.ok(fs.readFileSync(log).subarray(0, before.length).equals(before), 'the earlier line is unchanged');
  fs.appendFileSync(log, '{"v":1,"at":"2026-10-26T00:00:00.000Z","kind":"owner","text":"half');
  const all = readChatLog(root, b.id)!;
  assert.deepEqual(all.entries.map((e) => [e.n, e.kind]), [[0, 'owner'], [1, 'undelivered'], [3, 'session']], 'the malformed line keeps index 2; the unfinished one is no line yet');
  assert.equal(all.more, false);
  assert.equal((all.entries[0] as { text: string }).text, 'hello\nthere');
  const page = readChatLog(root, b.id, { after: 0, limit: 1 })!;
  assert.deepEqual([page.entries.map((e) => e.n), page.more], [[1], true]);
  assert.deepEqual(readChatLog(root, b.id, { after: 3 }), { entries: [], more: false });
  for (const bad of [{ after: -2 }, { after: 1.5 }, { limit: 0 }, { limit: 1001 }]) assert.throws(() => readChatLog(root, b.id, bad), /after must|limit must/, JSON.stringify(bad));
  assert.equal(readChatLog(root, 'ffffffffffff'), null);
  assert.deepEqual(readChatLog(root, a.id), { entries: [], more: false }, 'a chat with no log yet');
  assert.throws(() => appendChatEntry(root, 'ffffffffffff', { kind: 'owner', text: 'x' }), /no chat/);
  assert.equal(fs.existsSync(path.join(paths(root).chats, 'ffffffffffff')), false, 'an append never makes a chat');

  // The cap: an append that would pass 64 MiB writes nothing.
  const full = createChat(root, {});
  const fullLog = path.join(paths(root).chats, full.id, 'log.jsonl');
  fs.writeFileSync(fullLog, '');
  fs.truncateSync(fullLog, CHAT_LOG_MAX - 10);
  assert.equal(chatLogFull(root, full.id), true);
  assert.equal(chatLogFull(root, b.id), false);
  assert.throws(() => appendChatEntry(root, full.id, { kind: 'session', line: 'x'.repeat(20) }), new RegExp(CHAT_LOG_FULL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.statSync(fullLog).size, CHAT_LOG_MAX - 10);

  // Links in place of the log, chat.json, the chat's dir or chats/ are refused, never followed.
  const elsewhere = fs.mkdtempSync(path.join(path.dirname(root), 'forge-chat-elsewhere-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  const victim = path.join(elsewhere, 'victim.txt');
  fs.writeFileSync(victim, 'untouched\n');
  const c = createChat(root, { title: 'linked' });
  const cDir = path.join(paths(root).chats, c.id);
  if (link(victim, path.join(cDir, 'log.jsonl'))) {
    assert.throws(() => appendChatEntry(root, c.id, { kind: 'owner', text: 'x' }));
    assert.throws(() => readChatLog(root, c.id), /not a regular file/);
    assert.equal(chatLogFull(root, c.id), true, 'a log that cannot be appended counts as full');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched\n');
    fs.rmSync(path.join(cDir, 'log.jsonl'));
    fs.copyFileSync(path.join(cDir, 'chat.json'), path.join(elsewhere, 'chat.json'));
    fs.rmSync(path.join(cDir, 'chat.json'));
    assert.ok(link(path.join(elsewhere, 'chat.json'), path.join(cDir, 'chat.json')));
    assert.equal(readChat(root, c.id), null, 'a linked chat.json');
    assert.ok(!listChats(root).some((x) => x.id === c.id));

    const d = createChat(root, { title: 'moved' });
    const dDir = path.join(paths(root).chats, d.id);
    fs.renameSync(dDir, path.join(elsewhere, d.id));
    assert.ok(link(path.join(elsewhere, d.id), dDir));
    assert.equal(readChat(root, d.id), null, "a linked chat's dir");
    assert.throws(() => appendChatEntry(root, d.id, { kind: 'owner', text: 'x' }), /no chat/);
    assert.equal(fs.existsSync(path.join(elsewhere, d.id, 'log.jsonl')), false);

    const chats = paths(root).chats;
    fs.renameSync(chats, path.join(elsewhere, 'chats'));
    assert.ok(link(path.join(elsewhere, 'chats'), chats));
    assert.deepEqual(listChats(root), [], 'a linked chats/ dir');
    assert.equal(readChat(root, b.id), null);
    assert.throws(() => appendChatEntry(root, b.id, { kind: 'owner', text: 'x' }), /no chat/);
    assert.throws(() => createChat(root, {}), /not a real directory/);
  }
});

test("the recorder writes a chat session's lines and session ids, and nothing else", (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  const root = r.dir;
  const chat = createChat(root, {});
  const scope = `_chat-${chat.id}`;
  const reported: string[] = [];
  const record = createChatRecorder(root, (m) => void reported.push(m));
  const state = (s: string, sessionId: string | null) => ({ kind: 'state' as const, scope: s, state: { scope: s, sessionId } as never });
  record({ kind: 'line', scope, offset: 0, line: '{"type":"forge-daemon","event":"spawn"}' });
  record({ kind: 'line', scope, offset: 1, line: JSON.stringify({ type: 'assistant', text: 'y'.repeat(CHAT_LINE_MAX) }) });
  record({ kind: 'line', scope: '_inbox', offset: 0, line: '{"type":"inbox"}' });
  record({ kind: 'line', scope: 'j-1', offset: 0, line: '{"type":"job"}' });
  record(state(scope, '11111111-2222-4333-8444-555555555555'));
  record(state(scope, '11111111-2222-4333-8444-555555555555'));
  const lines = readChatLog(root, chat.id)!.entries.map((e) => (e.kind === 'session' ? JSON.parse(e.line) : e));
  assert.deepEqual(lines[0], { type: 'forge-daemon', event: 'spawn' });
  assert.deepEqual({ ...lines[1], bytes: typeof lines[1].bytes }, { type: 'forge-truncated', originalType: 'assistant', bytes: 'number' });
  assert.equal(lines.length, 2, "only this chat's lines");
  assert.equal(readChat(root, chat.id)?.sessionId, '11111111-2222-4333-8444-555555555555');
  // An event for a chat with no files is reported once, never thrown, and makes nothing.
  const ghost = '_chat-ffffffffffff';
  record({ kind: 'line', scope: ghost, offset: 0, line: '{}' });
  record({ kind: 'line', scope: ghost, offset: 1, line: '{}' });
  assert.deepEqual(reported, ['chat log (ffffffffffff): no chat ffffffffffff\n']);
  assert.equal(fs.existsSync(path.join(paths(root).chats, 'ffffffffffff')), false);
});
