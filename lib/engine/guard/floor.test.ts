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
  // Claude Code reads these on its own, so they hit with project.instructions unset (the default), at any depth and in any case.
  const unset = { ...inputs, instructions: [] };
  const control: [string, string, boolean][] = [
    ['a settings file under .claude/', '.claude/settings.json', true],
    ['a .claude directory in a package', 'packages/web/.Claude/hooks/pre.sh', true],
    ['a symlink named .claude', '.claude', true],
    ['the root CLAUDE.md', 'CLAUDE.md', true],
    ['a nested CLAUDE.md', 'packages/web/CLAUDE.md', true],
    ['CLAUDE.local.md', 'CLAUDE.local.md', true],
    ['a nested AGENTS.md in another case', 'lib/Agents.md', true],
    ['the MCP server list', '.mcp.json', true],
    ['a doc that only mentions agents', 'docs/agents-guide.md', false],
    ['a directory that only starts with .claude', '.claudeish/x.md', false],
    ['a file named like claude.md.txt', 'docs/claude.md.txt', false],
  ];
  for (const [name, p, want] of control) assert.deepEqual(floorHits([entry(p)], unset), want ? [p] : [], name);
  // A rename shows both sides (no renames in the diff): the deleted side alone still hits.
  assert.deepEqual(floorHits([entry('.forge/notes/x.md', 'D'), entry('docs/x.md', 'A')], inputs), ['.forge/notes/x.md']);
});
