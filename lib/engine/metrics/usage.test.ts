// Importing usage from a Claude Code transcript: a role run's own session file at the job's worktree
// slug, summed exactly, and a cursor that counts only the span after it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectSlug } from '#integrations/claude/transcripts.ts';
import { importClaudeCodeTranscript } from './usage.ts';

type JobRefs = NonNullable<Parameters<typeof importClaudeCodeTranscript>[1]>['job'];

test("a role run's session transcript is imported", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-usage-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // No config: worktrees.root is its default, ../<repo>.worktrees.
  const root = path.join(base, 'repo');
  const wt = path.join(base, 'repo.worktrees', 'J1');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  const projectsDir = path.join(base, 'projects');
  const id = '55555555-5555-4555-8555-555555555555';
  const dir = path.join(projectsDir, projectSlug(wt));
  fs.mkdirSync(dir, { recursive: true });
  const line = (at: string, msg: string, usage: Record<string, number>, content: unknown[]) =>
    JSON.stringify({ type: 'assistant', timestamp: at, message: { id: msg, model: 'claude-haiku-4-5', usage, content } });
  const T1 = '2026-10-26T10:00:00.000Z';
  const T2 = '2026-10-26T10:00:05.000Z';
  fs.writeFileSync(
    path.join(dir, `${id}.jsonl`),
    [
      JSON.stringify({ type: 'user', timestamp: '2026-10-26T09:59:59.000Z', message: { content: 'the brief' } }),
      line(T1, 'm1', { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20 }, [{ type: 'text', text: 'hi' }]),
      // The same message logged again, block by block: counted once.
      line(T1, 'm1', { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20 }, [{ type: 'text', text: 'there' }]),
      line(T2, 'm2', { input_tokens: 5, output_tokens: 40, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 }, [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } }]),
      '',
    ].join('\n'),
  );
  const job = { id: 'J1', worktree: wt, lease: { driver: null }, runs: [], agents: {} } as unknown as JobRefs;

  const all = importClaudeCodeTranscript(id, { root, job, projectsDir });
  assert.ok(all, 'found at the worktree slug');
  assert.deepEqual(
    { model: all.model, input: all.input, output: all.output, cacheRead: all.cacheRead, cacheWrite: all.cacheWrite, totalTokens: all.totalTokens, toolUses: all.toolUses, exact: all.exact, outputEstimated: all.outputEstimated, durationMs: all.durationMs, through: all.through },
    { model: 'claude-haiku-4-5', input: 15, output: 90, cacheRead: 3000, cacheWrite: 20, totalTokens: 3125, toolUses: 1, exact: true, outputEstimated: false, durationMs: 6000, through: T2 },
  );
  assert.equal(all.transcript, fs.realpathSync(path.join(dir, `${id}.jsonl`)));

  const later = importClaudeCodeTranscript(id, { root, job, projectsDir, since: T1 });
  assert.deepEqual([later?.input, later?.output, later?.cacheRead, later?.cacheWrite, later?.totalTokens, later?.through], [5, 40, 2000, 0, 2045, T2], 'since skips every line up to the cursor');
});
