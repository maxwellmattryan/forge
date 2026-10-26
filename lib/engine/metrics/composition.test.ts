// composeContext: what filled a run's context at its last request, from a transcript's parsed lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { IMAGE_CHARS, MAX_TOOL_PARTS, composeContext } from './composition.ts';
import type { ContextComposition } from '#core/types.ts';

const FIXTURES = path.resolve(import.meta.dirname, '..', '..', '..', 'test', 'fixtures');
const readLines = (name: string): unknown[] =>
  fs
    .readFileSync(path.join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

/** Every part is ≥ 0 and the parts sum to the total. */
function assertSums(c: ContextComposition): void {
  const parts = [c.forgePrompt, c.harness, c.carried, c.assistant, c.user, ...c.tools.map((p) => p.tokens)];
  for (const p of parts) assert.ok(Number.isInteger(p) && p >= 0, `part ${p} is a whole number ≥ 0`);
  assert.equal(parts.reduce((a, b) => a + b, 0), c.total, 'the parts sum to the total');
}

/** An assistant line whose request had `input` tokens in all, split as fresh, cache read and cache write. */
const assistant = (id: string, input: number, content: unknown[], timestamp?: string) => ({
  type: 'assistant',
  uuid: `u-${id}`,
  ...(timestamp ? { timestamp } : {}),
  message: { id, role: 'assistant', content, usage: { input_tokens: 1, cache_read_input_tokens: input - 3, cache_creation_input_tokens: 2, output_tokens: 1 } },
});
const user = (content: unknown, timestamp?: string) => ({ type: 'user', ...(timestamp ? { timestamp } : {}), message: { role: 'user', content } });
const use = (id: string, name: string, input: unknown = {}) => ({ type: 'tool_use', id, name, input });
const result = (id: string, content: unknown) => ({ type: 'tool_result', tool_use_id: id, content });
const text = (s: string) => ({ type: 'text', text: s });

test("composes the fixture transcript's context", () => {
  const c = composeContext(readLines('transcript-composition.jsonl'), { promptChars: 7000 });
  // Worked out by hand from the fixture:
  // - prefix P = msg_1's input: 10 + 20000 + 10000 = 30010; total C = msg_4's: 2 + 30817 + 700 = 31519.
  // - the brief (u1) is 102 chars: forgePrompt = min(30010, ceil((7000 + 102) / 3.5)) = ceil(2029.14) = 2030,
  //   harness = 30010 − 2030 = 27980.
  // - messages M = 31519 − 30010 = 1509 tokens, shared over the chars from msg_1 up to msg_4 (u7 after it, and the
  //   top-level toolUseResult, are never counted):
  //   carried 0; Read 416 (u2); Bash 69 (u3's text block); mcp:github 86 + 64 = 150 (u4, u5); assistant 23 (a1's
  //   text) + 27 (Read + {"file_path":"spec.md"}) + 26 (Bash + {"command":"npm test"}) + 35 + 39 (the two
  //   mcp__github__* uses) = 150; user 20 (u6). Chars in all: 805.
  // - floors of 1509 × chars / 805: Read 779 (rem 649), Bash 129 (276), mcp:github 281 (145), assistant 281 (145),
  //   user 37 (395) = 1507; the 2 left go to the largest remainders, Read and user: Read 780, user 38.
  assert.deepEqual(c, {
    total: 31519,
    forgePrompt: 2030,
    harness: 27980,
    carried: 0,
    tools: [
      { name: 'Read', tokens: 780 },
      { name: 'mcp:github', tokens: 281 },
      { name: 'Bash', tokens: 129 },
    ],
    assistant: 281,
    user: 38,
  });
  assertSums(c!);
  // The prefix is the first request's whole input, and the Forge share is capped by it.
  assert.equal(c!.forgePrompt + c!.harness, 30010);
});

const many = Array.from({ length: 14 }, (_, i) => `Tool${String(i).padStart(2, '0')}`);

const ROWS: { name: string; lines: unknown[]; opts?: Parameters<typeof composeContext>[1]; check: (c: ContextComposition | null) => void }[] = [
  {
    name: '(a) a resumed transcript: the span starts at Rework round 2, round 1 is carried',
    lines: readLines('transcript-resumed.jsonl'),
    opts: { since: '2026-10-01T10:01:00.000Z' },
    check: (c) => {
      assert.ok(c);
      assert.equal(c.total, 5 + 1800 + 10, 'msg_r2b, the span’s last request');
      assert.ok(c.carried > 0, 'round 1 is carried');
      assert.ok(c.user > 0, 'the rework brief is a user turn');
      assert.deepEqual(c.tools.map((p) => p.name), ['Edit'], 'only the span’s tool results are grouped by tool');
      assertSums(c);
    },
  },
  {
    name: '(a) the same transcript without a cursor carries nothing',
    lines: readLines('transcript-resumed.jsonl'),
    check: (c) => {
      assert.equal(c?.carried, 0);
      assertSums(c!);
    },
  },
  {
    name: '(b) a Forge prompt estimate larger than the prefix is capped at it',
    lines: [user('x'.repeat(100)), assistant('m1', 100, [text('hi')]), user('go on'), assistant('m2', 200, [text('ok')])],
    opts: { promptChars: 10_000 },
    check: (c) => {
      assert.equal(c?.forgePrompt, 100);
      assert.equal(c?.harness, 0);
      assertSums(c!);
    },
  },
  {
    name: '(c) a compacted context: the last request is smaller than the first',
    lines: [assistant('m1', 1000, [text('long answer')]), user('more'), assistant('m2', 400, [text('ok')])],
    opts: { promptChars: 700 },
    check: (c) => {
      assert.ok(c);
      assert.equal(c.total, 400);
      assert.equal(c.forgePrompt, 200);
      assert.equal(c.forgePrompt + c.harness, 400);
      assert.deepEqual([c.carried, c.assistant, c.user, c.tools], [0, 0, 0, []]);
    },
  },
  {
    name: '(d) a span with no assistant message',
    lines: [assistant('m1', 100, [text('a')], '2026-10-01T10:00:00.000Z'), user('later', '2026-10-01T10:05:00.000Z')],
    opts: { since: '2026-10-01T10:01:00.000Z' },
    check: (c) => assert.equal(c, null),
  },
  {
    name: '(d) a file with no assistant request at all',
    lines: [user('brief'), { type: 'summary', summary: 'x' }],
    check: (c) => assert.equal(c, null),
  },
  {
    name: '(e) 14 distinct tools keep 12 named entries, largest first, and fold the rest into other',
    lines: [
      assistant('m1', 1000, many.map((n, i) => use(`t${i}`, n))),
      user(many.map((_, i) => result(`t${i}`, 'x'.repeat((i + 1) * 100)))),
      assistant('m2', 1000 + 10_500, [text('done')]),
    ],
    check: (c) => {
      assert.ok(c);
      assert.equal(c.tools.length, MAX_TOOL_PARTS + 1);
      const named = c.tools.slice(0, MAX_TOOL_PARTS);
      assert.deepEqual(named.map((p) => p.name), [...many].reverse().slice(0, MAX_TOOL_PARTS), 'the largest twelve, largest first');
      for (let i = 1; i < named.length; i++) assert.ok(named[i - 1]!.tokens >= named[i]!.tokens);
      assert.equal(c.tools.at(-1)!.name, 'other', 'the two smallest fold into one other entry');
      assert.ok(c.tools.at(-1)!.tokens > 0);
      assertSums(c);
    },
  },
  {
    name: '(f) names outside the charset count under other, and __proto__ stays an array entry',
    lines: [
      assistant('m1', 1000, [use('t1', 'bad name!'), use('t2', 'mcp__bad server__x'), use('t3', '__proto__'), use('t4', 'x'.repeat(65)), use('t5', 'mcp__docs__read')]),
      user([result('t1', 'a'.repeat(100)), result('t2', 'b'.repeat(100)), result('t3', 'c'.repeat(100)), result('t4', 'd'.repeat(100)), result('t5', 'e'.repeat(100)), result('unknown', 'f'.repeat(100))]),
      assistant('m2', 2000, [text('done')]),
    ],
    check: (c) => {
      assert.ok(c);
      assert.ok(Array.isArray(c.tools));
      assert.deepEqual(c.tools.map((p) => p.name).sort(), ['__proto__', 'mcp:docs', 'other']);
      const other = c.tools.find((p) => p.name === 'other')!;
      const proto = c.tools.find((p) => p.name === '__proto__')!;
      assert.ok(other.tokens > 3 * proto.tokens, 'four results of the same size went to other');
      assert.equal(Object.hasOwn(Object.prototype, 'tokens'), false);
      assertSums(c);
    },
  },
  {
    name: '(g) an image block counts as IMAGE_CHARS, not its base64 length',
    lines: [
      assistant('m1', 1000, [use('t1', 'Read', {})]),
      user([result('t1', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(200_000) } }])]),
      user('u'.repeat(IMAGE_CHARS)),
      assistant('m2', 3000, []),
    ],
    check: (c) => {
      assert.ok(c);
      const read = c.tools.find((p) => p.name === 'Read')!;
      assert.ok(Math.abs(read.tokens - c.user) <= 1, `the image (${read.tokens}) weighs as much as ${IMAGE_CHARS} chars of text (${c.user})`);
      assertSums(c);
    },
  },
];

test('composition edge cases', async (t) => {
  for (const row of ROWS) await t.test(row.name, () => row.check(composeContext(row.lines, row.opts)));
});
