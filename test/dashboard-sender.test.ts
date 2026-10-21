// dashboard/src/lib/sender.ts: who a Thread message or a session log line comes from, and its tint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TINT, logSender, threadSender, type Sender } from '../dashboard/src/lib/sender.ts';
import type { ItemKind } from '../dashboard/src/lib/session-log.ts';
import type { ThreadFrom } from '../dashboard/src/lib/thread.ts';

test('senders map log kinds and thread origins to tints', () => {
  assert.deepEqual(TINT, { you: '', cli: 'tint cli', agent: 'tint agent', forge: 'tint forge' } satisfies Record<Sender, string>);
  // Every ItemKind: the Record type makes typecheck fail when a new kind is missing from the table.
  const want: Record<ItemKind, 'agent' | 'cli'> = {
    text: 'agent', thinking: 'agent', tool: 'agent', subagent: 'agent',
    supervisor: 'cli', init: 'cli', result: 'cli', task: 'cli', stderr: 'cli', raw: 'cli', truncated: 'cli', 'rate-limit': 'cli', denied: 'cli', hook: 'cli', other: 'cli', turn: 'cli',
  };
  for (const [kind, sender] of Object.entries(want)) assert.equal(logSender(kind as ItemKind), sender, kind);
  // Every ThreadFrom, held complete by the Record type the same way.
  const wantFrom: Record<ThreadFrom, Sender> = { you: 'you', tracker: 'you', cli: 'cli', forge: 'forge' };
  for (const [from, sender] of Object.entries(wantFrom)) assert.equal(threadSender(from as ThreadFrom), sender, from);
  // People keep the plain plate; the rest tint.
  assert.equal(TINT[threadSender('you')], '');
  assert.equal(TINT[threadSender('tracker')], '');
  assert.equal(TINT[logSender('text')], 'tint agent');
  assert.equal(TINT[logSender('supervisor')], 'tint cli');
  assert.equal(TINT[threadSender('forge')], 'tint forge');
});
