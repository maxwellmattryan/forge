// Agents that read untrusted text keep their tool limits: the disallowedTools frontmatter of
// agents/assistant.md and agents/triage.md, which Claude Code enforces and no Forge function reads.
// Kept through the test rewrite (docs/test-rewrite/README.md; docs/TESTING.md › Allowed source-text
// tests, entry 9).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from '../helpers.ts';
import { defaults } from '#core/config/load.ts';
import { roster } from '#engine/pipeline/roster.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

test('assistant agent has no Bash', () => {
  const front = fs.readFileSync(path.join(ROOT, 'agents', 'assistant.md'), 'utf8').split('---')[1];
  assert.match(front, /^disallowedTools: Bash, Edit, NotebookEdit$/m, 'no Bash: injected text reaches the CLI only through the one-line verdict');
});

test('triage agent runs on haiku without a config key', () => {
  const repo = tempRepo();
  try {
    const cfg = defaults();
    assert.equal(cfg.runtime.models.triage, undefined, 'no config key');
    const row = roster(repo.dir, cfg).agents.find((a) => a.role === 'triage');
    assert.ok(row);
    assert.equal(row.model, 'haiku');
    // Triage reads tracker text, so its tool list is a security property no public function exposes
    // (docs/TESTING.md exception): the frontmatter is the only place it lives.
    const text = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'agents', 'triage.md'), 'utf8');
    const front = text.match(/^---\n([\s\S]*?)\n---\n/)![1];
    assert.match(front, /^disallowedTools: Bash, Edit, NotebookEdit$/m);
    assert.match(front, /^tools: Read, Write$/m, 'an allowlist: no WebFetch, WebSearch, Glob or Grep');
  } finally {
    repo.cleanup();
  }
});
