// The Findings addressed example agents/builder.md teaches is the format parseAddressed reads. Kept
// through the test rewrite (docs/test-rewrite/README.md): docs stay in sync with code (docs/TESTING.md ›
// Allowed source-text tests, entry 6).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseAddressed } from '#engine/pipeline/findings.ts';

test('builder prompt example parses', () => {
  const prompt = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'agents', 'builder.md'), 'utf8');
  const examples: string[] = [];
  let fenced = false;
  for (const line of prompt.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    else if (fenced && line.trim().startsWith('- ') && line.includes('→')) examples.push(line.trim());
  }
  assert.equal(examples.length, 3, prompt);
  assert.deepEqual(parseAddressed(['## Round 2', 'Findings addressed:', ...examples].join('\n')), [
    { round: 1, lens: 'code', severity: 'major', path: 'lib/engine/metrics/stats.ts', outcome: 'fixed' },
    { round: 1, lens: 'security', severity: 'minor', path: 'lib/engine/evals/retro.ts', outcome: 'disputed' },
    { round: 1, lens: 'docs', severity: 'nit', path: null, outcome: 'fixed' },
  ]);
});
