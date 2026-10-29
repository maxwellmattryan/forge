// The runs panel's model: each agent run's billing split and context composition as bar segments, and its duration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { billingParts, compositionParts, runDuration, runsTotal, type BarPart } from './agent-runs.ts';
import type { ContextComposition } from '../core/types.ts';

const SERIES = /^series-([1-6]|rest)$/;

/** The parts' tokens sum to `total`, their shares to 1, and every series is a whole literal. */
function assertBar(parts: BarPart[], total: number): void {
  assert.equal(parts.reduce((n, p) => n + p.tokens, 0), total, 'the segments sum to the total');
  assert.ok(Math.abs(parts.reduce((n, p) => n + p.share, 0) - 1) < 1e-9, 'the shares sum to 1');
  for (const p of parts) {
    assert.ok(p.tokens > 0, `${p.key} is not a zero segment`);
    assert.match(p.series, SERIES);
  }
}

test('billingParts', async (t) => {
  await t.test('the split in order, the remainder as unsplit, zeros left out', () => {
    const parts = billingParts({ input: 30, output: 20, cacheRead: 900, cacheWrite: 0, totalTokens: 1000 });
    assert.deepEqual(
      parts.map((p) => [p.key, p.tokens]),
      [
        ['cacheRead', 900],
        ['input', 30],
        ['output', 20],
        ['unsplit', 50],
      ],
    );
    assertBar(parts, 1000);
  });
  await t.test('no unsplit part when the split is the whole total', () => {
    const parts = billingParts({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 });
    assert.deepEqual(parts.map((p) => p.key), ['cacheRead', 'cacheWrite', 'input', 'output']);
    assertBar(parts, 10);
  });
  await t.test('a self-reported run is one unsplit segment', () => {
    const parts = billingParts({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 500 });
    assert.deepEqual(parts.map((p) => [p.key, p.share]), [['unsplit', 1]]);
    assertBar(parts, 500);
  });
  await t.test('null usage, or a zero total, is no bar', () => {
    assert.deepEqual(billingParts(null), []);
    assert.deepEqual(billingParts({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }), []);
  });
});

test('compositionParts', async (t) => {
  const c: ContextComposition = {
    total: 1000,
    forgePrompt: 100,
    harness: 600,
    carried: 0,
    tools: [
      { name: 'Read', tokens: 120 },
      { name: 'mcp:github', tokens: 50 },
      { name: '__proto__', tokens: 10 },
      { name: 'other', tokens: 20 },
    ],
    assistant: 70,
    user: 30,
  };
  await t.test('the prefix, the tools in order, then the messages, with zeros left out', () => {
    const parts = compositionParts(c);
    assert.deepEqual(
      parts.map((p) => [p.key, p.name, p.tokens]),
      [
        ['forgePrompt', null, 100],
        ['harness', null, 600],
        ['tool', 'Read', 120],
        ['mcp', 'github', 50],
        ['tool', '__proto__', 10],
        ['otherTools', null, 20],
        ['assistant', null, 70],
        ['user', null, 30],
      ],
    );
    assertBar(parts, 1000);
  });
  await t.test('earlier runs get their own segment', () => {
    const parts = compositionParts({ ...c, harness: 500, carried: 100 });
    assert.equal(parts[2]!.key, 'carried');
    assertBar(parts, 1000);
  });
  await t.test('null is no bar', () => assert.deepEqual(compositionParts(null), []));
});

test('runsTotal', () => {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 500 };
  assert.equal(runsTotal([{ usage }, { usage: null }, { usage: { ...usage, totalTokens: 70 } }]), 570);
  assert.equal(runsTotal([{ usage: null }]), null);
  assert.equal(runsTotal([]), null);
});

test('runDuration', () => {
  assert.equal(runDuration({ startedAt: '2026-10-02T10:00:00.000Z', endedAt: '2026-10-02T10:01:30.000Z' }), 90_000);
  assert.equal(runDuration({ startedAt: null, endedAt: '2026-10-02T10:01:30.000Z' }), null);
  assert.equal(runDuration({ startedAt: '2026-10-02T10:00:00.000Z', endedAt: 'never' }), null);
});
