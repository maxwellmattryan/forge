// One session log line, parsed: the supervisor's own events render their keys as text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEntry } from './session-parse.ts';

test('a supervisor waiting line names its cap', () => {
  const parsed = parseEntry({ offset: 0, line: '{"type":"forge-daemon","at":"2026-10-31T00:00:00Z","event":"waiting","cap":"machine","maxConcurrent":2}' });
  const items = parsed.flatMap((p) => (p.kind === 'item' && p.item.kind === 'supervisor' ? [p.item] : []));
  assert.equal(items.length, 1);
  assert.deepEqual([items[0]!.text, items[0]!.tone], ['waiting maxConcurrent=2 cap=machine', 'warn']);
});
