// dashboard/src/lib/sender.ts: who a Thread message or a session log line comes from, and its tint.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TINT, logSender, threadSender, type Sender } from '../dashboard/src/lib/sender.ts';
import type { ItemKind } from '../dashboard/src/lib/session-log.ts';
import type { ThreadFrom } from '../dashboard/src/lib/thread.ts';

const SRC = path.resolve(import.meta.dirname, '..', 'dashboard', 'src', 'lib');

test('senders map log kinds and thread origins to tints', () => {
  assert.deepEqual(TINT, { you: '', cli: 'tint cli', agent: 'tint agent', forge: 'tint forge' } satisfies Record<Sender, string>);
  // Every ItemKind, read from the union itself, so a new kind cannot slip past this table.
  const union = fs.readFileSync(path.join(SRC, 'session-log.ts'), 'utf8');
  const items = union.slice(union.indexOf('export type Item ='), union.indexOf('export type ItemKind'));
  const kinds = [...new Set([...items.matchAll(/kind: ([^;]+);/g)].flatMap((m) => [...m[1].matchAll(/'([\w-]+)'/g)].map((k) => k[1]))), 'turn'].sort();
  const want: Record<ItemKind, 'agent' | 'cli'> = {
    text: 'agent', thinking: 'agent', tool: 'agent', subagent: 'agent',
    supervisor: 'cli', init: 'cli', result: 'cli', task: 'cli', stderr: 'cli', raw: 'cli', truncated: 'cli', 'rate-limit': 'cli', denied: 'cli', hook: 'cli', other: 'cli', turn: 'cli',
  };
  assert.deepEqual(kinds, Object.keys(want).sort(), 'the table covers every ItemKind');
  for (const [kind, sender] of Object.entries(want)) assert.equal(logSender(kind as ItemKind), sender, kind);
  // Every ThreadFrom.
  const thread = fs.readFileSync(path.join(SRC, 'thread.ts'), 'utf8');
  const froms = [...(/export type ThreadFrom = ([^;]+);/.exec(thread)?.[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
  const wantFrom: Record<ThreadFrom, Sender> = { you: 'you', tracker: 'you', cli: 'cli', forge: 'forge' };
  assert.deepEqual(froms, Object.keys(wantFrom).sort(), 'the table covers every ThreadFrom');
  for (const [from, sender] of Object.entries(wantFrom)) assert.equal(threadSender(from as ThreadFrom), sender, from);
  // People keep the plain plate; the rest tint.
  assert.equal(TINT[threadSender('you')], '');
  assert.equal(TINT[threadSender('tracker')], '');
  assert.equal(TINT[logSender('text')], 'tint agent');
  assert.equal(TINT[logSender('supervisor')], 'tint cli');
  assert.equal(TINT[threadSender('forge')], 'tint forge');
});
