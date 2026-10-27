// The chat routes over the machine server with fake claude children: a message reaches its chat's own
// session and the chat log records it and what followed, in order; the messages route's refusals append
// nothing; a chat's permission prompt is answered from the dashboard; and a chat resumes its Claude
// session after a restart. Nothing real is spawned or signalled.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fakeClaude, serveProjects, tempRepo, type FakeClaudeChild } from '../../helpers.ts';
import * as yaml from '#core/format/yaml.ts';
import { CONFIG_SCHEMA_VERSION } from '#core/job/schema.ts';
import { paths } from '#core/paths.ts';
import type { ClaudeEvent } from '#integrations/claude/types.ts';
import type { ServedProjects } from '../../support/machine-server.ts';

const P = '/api/p/a';

function chatRepo(daemon: Record<string, unknown> = {}): ReturnType<typeof tempRepo> {
  const r = tempRepo();
  fs.mkdirSync(path.join(r.dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, daemon: { enabled: true, command: 'claude {session}', ...daemon } }));
  return r;
}

function call(port: number, method: string, p: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** One served project `a` over fake children, and calls that carry its page token. */
async function serve(root: string) {
  const fake = fakeClaude();
  const s: ServedProjects = await serveProjects([{ dir: root, name: 'a' }], { daemon: { claude: fake.adapter, pollMs: 3_600_000, syncMs: 0, reconcileMs: 0, graceMs: 50 } });
  const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await call(s.port, 'GET', '/', {})).body)![1]!;
  const headers = { 'x-forge-token': token, origin: `http://127.0.0.1:${s.port}`, 'content-type': 'application/json' };
  const post = (p: string, body: unknown) => call(s.port, 'POST', `${P}${p}`, headers, typeof body === 'string' ? body : JSON.stringify(body));
  const get = (p: string) => call(s.port, 'GET', `${P}${p}`, { 'x-forge-token': token });
  const of = (scope: string) => fake.children.filter((c) => c.scope === scope);
  return { s, post, get, of, children: fake.children };
}

const logFile = (root: string, id: string) => path.join(paths(root).chats, id, 'log.jsonl');
const logBytes = (root: string, id: string) => (fs.existsSync(logFile(root, id)) ? fs.readFileSync(logFile(root, id), 'utf8') : '');
const line = (o: unknown): ClaudeEvent => ({ kind: 'log', stream: 'stdout', line: JSON.stringify(o) });

test('a message reaches its chat session and the log records it in order', async (t) => {
  const r = chatRepo();
  t.after(r.cleanup);
  const k = await serve(r.dir);
  t.after(() => k.s.cleanup());
  const created = await k.post('/chats', { title: 'Status' });
  assert.equal(created.status, 200);
  const { id } = created.body.chat;
  const scope = `_chat-${id}`;
  const sent = await k.post(`/chats/${id}/messages`, { text: 'what is waiting on me?' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.session.status, 'busy');
  const [child] = k.of(scope) as [FakeClaudeChild];
  assert.deepEqual([child.messages, child.turns], [['what is waiting on me?'], 0], 'exactly one user line, no fixed turn');
  for (const other of k.children.filter((c) => c !== child)) assert.deepEqual(other.messages, [], `${other.scope} took no text`);

  const sid = crypto.randomUUID();
  child.emit({ kind: 'session-id', id: sid });
  child.emit(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Two jobs wait on you.' }] } }));
  child.emit({ kind: 'turn-ended', ok: true });

  const page = await k.get(`/chats/${id}/log`);
  assert.equal(page.status, 200);
  const entries = page.body.entries as { n: number; kind: string; text?: string; line?: string }[];
  assert.deepEqual([entries[0]!.n, entries[0]!.kind, entries[0]!.text], [0, 'owner', 'what is waiting on me?'], 'the owner entry first');
  const lines = entries.slice(1).map((e) => (assert.equal(e.kind, 'session'), JSON.parse(e.line!)));
  const at = (pred: (l: any) => boolean) => lines.findIndex(pred);
  const turn = at((l) => l.type === 'forge-daemon' && l.event === 'turn');
  const reply = at((l) => l.type === 'assistant');
  const result = at((l) => l.type === 'forge-daemon' && l.event === 'result');
  assert.ok(at((l) => l.event === 'spawn') >= 0 && at((l) => l.event === 'spawn') < turn, 'the spawn, then the turn');
  assert.ok(turn >= 0 && turn < reply && reply < result, `turn, reply and result in order: ${[turn, reply, result]}`);
  assert.equal(lines[turn].chat, true);
  assert.deepEqual(entries.map((e) => e.n), entries.map((_, i) => i), 'indexes in order');
  const detail = await k.get(`/chats/${id}`);
  assert.deepEqual([detail.body.chat.sessionId, detail.body.session.status], [sid, 'idle'], "chat.json follows the session's id");
  const list = await k.get('/chats');
  assert.deepEqual(list.body.chats.map((c: { id: string }) => c.id), [id]);
  assert.equal((await k.get(`/chats/${id}/log?after=0&limit=1`)).body.entries[0].n, 1);
  for (const q of ['after=x', 'after=-2', 'limit=0', 'limit=1001', 'after=1.5']) assert.equal((await k.get(`/chats/${id}/log?${q}`)).status, 400, q);
  assert.equal((await k.get('/chats/ffffffffffff/log')).status, 404);
  assert.equal((await k.get('/chats/FFFFFFFFFFFF')).status, 404, 'an id outside the pattern is no route');
});

test('the messages route refuses bad text, unknown, archived, unstarted and busy chats', async (t) => {
  const r = chatRepo({ dailyUsd: { inbox: null, office: null, chat: 25 } });
  t.after(r.cleanup);
  const k = await serve(r.dir);
  t.after(() => k.s.cleanup());
  const id = (await k.post('/chats', {})).body.chat.id;
  const unchanged = async (what: string, body: unknown, status: number, error?: RegExp | string, chat = id) => {
    const before = logBytes(r.dir, chat);
    const got = await k.post(`/chats/${chat}/messages`, body);
    assert.equal(got.status, status, `${what}: ${JSON.stringify(got.body)}`);
    if (typeof error === 'string') assert.equal(got.body.error, error, what);
    else if (error) assert.match(got.body.error, error, what);
    assert.equal(logBytes(r.dir, chat), before, `${what}: the log is unchanged`);
  };
  for (const [what, body] of [
    ['missing', {}],
    ['empty', { text: '' }],
    ['whitespace', { text: ' \n\t ' }],
    ['not a string', { text: 42 }],
    ['8001 characters', { text: 'x'.repeat(8001) }],
  ] as const)
    await unchanged(what, body, 400, /text must be/);
  await unchanged('not JSON', '{"text":', 400);
  await unchanged('unknown chat', { text: 'hi' }, 404, 'no chat ffffffffffff', 'ffffffffffff');

  // Busy: the first message's turn has no result yet.
  assert.equal((await k.post(`/chats/${id}/messages`, { text: 'first' })).status, 200);
  await unchanged('busy', { text: 'second' }, 409, 'the Foreman is still replying in this chat');
  k.of(`_chat-${id}`)[0]!.emit({ kind: 'turn-ended', ok: true });

  // Not started: the pool was stopped.
  const stop = await k.post('/daemon', { action: 'stop' });
  assert.equal(stop.status, 200);
  await unchanged('unstarted', { text: 'hi' }, 409, 'start the daemon first');
  assert.equal((await k.post('/daemon', { action: 'start' })).status, 200);

  // Archived: and its session is stopped and dropped.
  const archived = (await k.post('/chats', {})).body.chat.id;
  assert.equal((await k.post(`/chats/${archived}/messages`, { text: 'hi' })).status, 200);
  const before = k.of(`_chat-${archived}`)[0]!;
  assert.equal((await k.post(`/chats/${archived}/archive`, {})).body.chat.state, 'archived');
  assert.equal(before.exited, true, "the archived chat's child is stopped");
  await unchanged('archived', { text: 'again' }, 409, `chat ${archived} is archived`, archived);

  // A spawn the pool refuses (the chats' daily cap) leaves the owner entry and an undelivered one.
  const zero = chatRepo({ dailyUsd: { inbox: null, office: null, chat: 0 } });
  t.after(zero.cleanup);
  const z = await serve(zero.dir);
  t.after(() => z.s.cleanup());
  const capped = (await z.post('/chats', {})).body.chat.id;
  const refused = await z.post(`/chats/${capped}/messages`, { text: 'are you there?' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /daily cap \(daemon\.dailyUsd\.chat\)/);
  const entries = (await z.get(`/chats/${capped}/log`)).body.entries.filter((e: { kind: string }) => e.kind !== 'session');
  assert.deepEqual(entries.map((e: { kind: string; text?: string; reason?: string }) => [e.kind, e.text ?? e.reason]), [
    ['owner', 'are you there?'],
    ['undelivered', refused.body.error],
  ]);
  assert.equal(z.of(`_chat-${capped}`).length, 0, 'nothing spawned');
});

test("a chat's permission prompt is answered from the dashboard", async (t) => {
  const r = chatRepo();
  t.after(r.cleanup);
  const k = await serve(r.dir);
  t.after(() => k.s.cleanup());
  const id = (await k.post('/chats', {})).body.chat.id;
  const scope = `_chat-${id}`;
  await k.post(`/chats/${id}/messages`, { text: 'list the jobs' });
  const child = k.of(scope)[0]!;
  child.emit({ kind: 'permission-asked', requestId: 'req-1', tool: 'Bash', input: JSON.stringify({ command: 'forge job list' }), description: 'list', agentId: null, blockedPath: null, rules: [], dirs: [] });
  const prompts = (await k.get(`/chats/${id}`)).body.session.permissions as { id: string; tool: string }[];
  assert.deepEqual(prompts.map((p) => p.tool), ['Bash']);
  const answered = await k.post('/daemon/permission', { scope, id: prompts[0]!.id, decision: 'allow' });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.deepEqual(child.answers, [{ requestId: 'req-1', decision: 'allow' }]);
  assert.deepEqual((await k.get(`/chats/${id}`)).body.session.permissions, []);

  assert.deepEqual(await k.post('/daemon/mode', { scope: '_chat-ffffffffffff', mode: 'auto' }), { status: 404, body: { error: 'no chat ffffffffffff' } });
  assert.equal((await k.post('/daemon/mode', { scope, mode: 'auto' })).status, 200);
  assert.deepEqual(child.modes.map((m) => m.mode), ['auto'], 'the running chat switches now');
  const start = await k.post('/daemon', { action: 'start', scope });
  assert.deepEqual([start.status, start.body.error], [409, 'a chat session starts when the owner sends it a message']);
  assert.equal((await k.post('/daemon', { action: 'start', scope: '_chat-ffffffffffff' })).status, 404);
  assert.equal((await k.get(`/events?session=_chat-NOPE`)).status, 400);
  assert.equal((await k.post('/daemon', { action: 'stop', scope })).status, 200);
  assert.equal(child.exited, true, 'a scoped stop stops the chat');
});

test('a chat resumes its Claude session after a dashboard restart', async (t) => {
  const r = chatRepo();
  t.after(r.cleanup);
  const first = await serve(r.dir);
  const id = (await first.post('/chats', {})).body.chat.id;
  const scope = `_chat-${id}`;
  await first.post(`/chats/${id}/messages`, { text: 'hello' });
  const child = first.of(scope)[0]!;
  assert.ok(!child.argv.includes('--resume'), 'a fresh conversation');
  const sid = crypto.randomUUID();
  child.emit({ kind: 'session-id', id: sid });
  child.emit(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi.' }] } }));
  child.emit({ kind: 'turn-ended', ok: true });
  child.exit(0, null);
  await first.s.cleanup();

  const second = await serve(r.dir);
  t.after(() => second.s.cleanup());
  const sent = await second.post(`/chats/${id}/messages`, { text: 'still there?' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const next = second.of(scope)[0]!;
  assert.equal(next.argv[next.argv.indexOf('--resume') + 1], sid, 'its next message resumes that session');
  assert.deepEqual(next.messages, ['still there?']);
  const kinds = (await second.get(`/chats/${id}/log`)).body.entries.filter((e: { kind: string }) => e.kind === 'owner').map((e: { text: string }) => e.text);
  assert.deepEqual(kinds, ['hello', 'still there?'], 'the history survives the restart');
});
