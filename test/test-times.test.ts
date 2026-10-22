import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { timeLines } from '../scripts/test-times.ts';

test('sums top-level durations per file, slowest first', async () => {
  const cwd = path.resolve('/repo');
  const a = path.join(cwd, 'test', 'a.test.ts');
  const b = path.join(cwd, 'test', 'b.test.ts');
  const ev = (type: string, file: string, nesting: number, ms: number) => ({ type, data: { file, nesting, details: { duration_ms: ms } } });
  async function* events() {
    yield { type: 'test:start', data: { file: a, nesting: 0 } };
    yield ev('test:pass', a, 1, 900); // nested: already inside its parent's time
    yield ev('test:pass', a, 0, 1000);
    yield ev('test:pass', b, 0, 1500);
    yield ev('test:fail', a, 0, 1200); // a failure still took its time
    yield { type: 'test:diagnostic', data: { message: 'tests 4' } };
  }
  const lines: string[] = [];
  for await (const line of timeLines(events(), cwd)) lines.push(line);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\s*2\.2 s {2}test\/a\.test\.ts\n$/);
  assert.match(lines[1], /^\s*1\.5 s {2}test\/b\.test\.ts\n$/);
  assert.match(lines[2], /^files 2 · wall \d+\.\d s\n$/);
});
