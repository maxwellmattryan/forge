// Agents keep their tool limits: every agent's `tools:` allowlist, read through agentTools (a role run's
// `--tools` comes from it, one list per agent, so one agent's children still share one cacheable prompt
// prefix), and the disallowedTools frontmatter of agents/assistant.md, agents/triage.md, agents/drafter.md,
// agents/reviewer.md and agents/digest.md, which Claude Code enforces and no Forge function reads.
// Kept through the test rewrite (docs/test-rewrite/README.md; docs/TESTING.md › Allowed source-text
// tests, entry 9).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from '../helpers.ts';
import { defaults } from '#core/config/load.ts';
import { agentTools, roster } from '#engine/pipeline/roster.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

test('every agent has a tools allowlist', () => {
  const roles = fs.readdirSync(path.join(ROOT, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  assert.ok(roles.length >= 15, roles.join(', '));
  const BROWSER = 'mcp__forge-browser__*';
  for (const role of roles) {
    const tools = agentTools(role);
    assert.ok(tools?.length, `${role}: a non-empty tools: list`);
    // Readers of builder-written diffs write one file and edit nothing.
    if (['reviewer', 'judge'].includes(role)) for (const t of ['Edit', 'MultiEdit', 'NotebookEdit']) assert.ok(!tools.includes(t), `${role}: no ${t}`);
    // Readers of tracker text, transcripts or hunks reach no shell.
    if (['assistant', 'drafter', 'triage', 'digest', 'verifier', 'surveyor'].includes(role)) assert.ok(!tools.includes('Bash'), `${role}: no Bash`);
    for (const t of ['Agent', 'WebFetch', 'WebSearch']) assert.ok(!tools.includes(t), `${role}: no ${t}`);
    assert.equal(tools.includes(BROWSER), ['builder', 'designer', 'reviewer'].includes(role), `${role}: the browser only for the roles that prove UI`);
    assert.deepEqual(tools.filter((t) => t.startsWith('mcp__') && t !== BROWSER), [], `${role}: no other MCP tool`);
  }
  for (const role of ['nope', '../agents/builder', 'Builder']) assert.equal(agentTools(role), null, role);
});

test('assistant agent has no Bash', () => {
  const front = fs.readFileSync(path.join(ROOT, 'agents', 'assistant.md'), 'utf8').split('---')[1];
  assert.match(front, /^disallowedTools: Bash, Edit, NotebookEdit$/m, 'no Bash: injected text reaches the CLI only through the one-line verdict');
});

test('drafter agent has no Bash or web tools', () => {
  // The drafter reads tracker titles and the owner's goal: it can only read the repo and write its staging file.
  const front = fs.readFileSync(path.join(ROOT, 'agents', 'drafter.md'), 'utf8').match(/^---\n([\s\S]*?)\n---\n/)![1];
  assert.match(front, /^tools: Read, Grep, Glob, Write$/m);
  assert.match(front, /^disallowedTools: Bash, Edit, NotebookEdit, WebFetch, WebSearch$/m);
});

test('reviewer agent has no Edit', () => {
  // A reviewer reads the branch's diff and build.md, both builder-written: it writes its one review file and edits nothing.
  const front = fs.readFileSync(path.join(ROOT, 'agents', 'reviewer.md'), 'utf8').match(/^---\n([\s\S]*?)\n---\n/)![1];
  assert.match(front, /^disallowedTools: Edit, NotebookEdit$/m);
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

test('digest agent runs on sonnet with only Read and Write', () => {
  const repo = tempRepo();
  try {
    const cfg = defaults();
    assert.equal(cfg.runtime.models.digest, undefined, 'no config key');
    assert.equal(roster(repo.dir, cfg).agents.find((a) => a.role === 'digest')?.model, 'sonnet');
    // The digest reads transcript logs agents and their programs wrote: it can only read its input and write its file.
    const front = fs.readFileSync(path.join(ROOT, 'agents', 'digest.md'), 'utf8').match(/^---\n([\s\S]*?)\n---\n/)![1];
    assert.match(front, /^tools: Read, Write$/m);
    assert.match(front, /^disallowedTools: Bash, Edit, NotebookEdit, WebFetch, WebSearch$/m);
  } finally {
    repo.cleanup();
  }
});
