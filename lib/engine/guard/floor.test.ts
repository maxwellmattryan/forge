// The escalate floor: the paths no unattended merge lands, whatever the protected-paths policy says.
import test from 'node:test';
import assert from 'node:assert/strict';
import { floorHits } from './floor.ts';
import type { DiffEntry } from './protected.ts';

const M = 'm'.repeat(40);
const H = 'h'.repeat(40);
const entry = (p: string, status = 'M'): DiffEntry => ({ path: p, status, oldMode: '100644', newMode: '100644', oldBlob: null, newBlob: null });

test('the escalate floor', () => {
  const pkg = (scripts: Record<string, string>, version: string) => JSON.stringify({ name: 'x', version, scripts });
  const blobs: Record<string, string> = {
    [`${M}:package.json`]: pkg({ test: 'node --test' }, '1.0.0'),
    [`${H}:package.json`]: pkg({ test: 'node --test' }, '1.0.1'),
    [`${M}:app/package.json`]: pkg({ test: 'node --test' }, '1.0.0'),
    [`${H}:app/package.json`]: pkg({ test: 'true' }, '1.0.0'),
  };
  const inputs = { instructions: ['AGENTS.md', 'docs/RULES.md'], sources: ['scripts/test.sh'], read: (rev: string, p: string | null) => (p ? (blobs[`${rev}:${p}`] ?? null) : null), mergeBase: M, head: H };
  const rows: [string, string, boolean][] = [
    ["Forge's own config", '.forge/config.yml', true],
    ['a case variant of .forge/', '.Forge/x', true],
    ['a path named in project.instructions', 'docs/RULES.md', true],
    ['an instruction file in another case', 'agents.md', true],
    ['a package.json whose scripts changed', 'app/package.json', true],
    ['a script a commands entry runs', 'scripts/test.sh', true],
    ['a CI workflow', '.github/workflows/ci.yml', true],
    ['a test runner config', 'jest.config.js', true],
    ['a package.json whose only change is version', 'package.json', false],
    ['a doc', 'docs/x.md', false],
  ];
  for (const [name, p, want] of rows) assert.deepEqual(floorHits([entry(p)], inputs), want ? [p] : [], name);
  // A rename shows both sides (no renames in the diff): the deleted side alone still hits.
  assert.deepEqual(floorHits([entry('.forge/notes/x.md', 'D'), entry('docs/x.md', 'A')], inputs), ['.forge/notes/x.md']);
});
