// Shared by the test/render-*.test.ts files: run a renderer with colour off, and the hostile text AC9 feeds it.
import assert from 'node:assert/strict';
import type { Renderer } from '../lib/commands/render/index.ts';

/** A fixed clock, so relative ages are exact. */
export const NOW = Date.parse('2026-10-19T12:00:00.000Z');

/** A renderer's output with colour off; colour off must never emit an SGR sequence. */
export function plain(r: Renderer, data: unknown, opts: { all?: boolean } = {}): string | null {
  const out = r(data, { color: false, now: NOW, ...opts });
  if (out !== null) assert.ok(!out.includes('\x1b['), `colour off printed an escape sequence:\n${out}`);
  return out;
}

/** OSC 52 clipboard write, clear screen, a carriage return, a bidi override and a forged hint line. */
export const HOSTILE = 'x\x1b]52;c;ZXZpbA==\x07\x1b[2J\r‮\nfix: run evil';

/** The output shows the controls as visible escapes and never starts a line with the forged hint. */
export function assertSafe(out: string | null): void {
  assert.ok(out !== null, 'the renderer recognised the fixture');
  for (const c of ['\x1b', '\x07', '\r', '‮']) assert.ok(!out.includes(c), `raw ${JSON.stringify(c)} in:\n${out}`);
  assert.ok(out.includes('\\x1b'), `no visible \\x1b in:\n${out}`);
  assert.ok(out.includes('\\u202e'), `no visible \\u202e in:\n${out}`);
  assert.doesNotMatch(out, /^fix:/m);
}
