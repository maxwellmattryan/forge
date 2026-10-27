// Seconds from agent start to first tool call, read from real transcript files under a temp
// projects dir: foreground and background runs, missing transcripts, the run cap, and the refusals
// that keep a planted agent id or link from reaching a file outside the projects dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentStartSeconds } from './agent-start.ts';
import { computeStats, statsFrom } from './stats.ts';
import type { StatsSource } from './types.ts';
import { projectSlug } from '#integrations/claude/transcripts.ts';
import { normalizeJob } from '#core/job/schema.ts';
import type { Job, JobEvent } from '#core/types.ts';

const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const MIN = 60_000;
const DRIVER = '44444444-4444-4444-8444-444444444444';
const iso = (ms: number): string => new Date(ms).toISOString();
const run = (role: string, start: number, end: number, agentId: string): JobEvent[] => [
  { v: 1, ts: iso(T0 + start * MIN), type: 'agent-start', role },
  { v: 1, ts: iso(T0 + end * MIN), type: 'agent-end', role, agentId },
];
/** A transcript whose first tool call comes `sec` seconds after the run's start. */
const transcript = (startMin: number, sec: number): string =>
  [
    { type: 'user', timestamp: iso(T0 + startMin * MIN), message: { content: [{ type: 'text', text: 'brief' }] } },
    { type: 'assistant', timestamp: iso(T0 + startMin * MIN + sec * 1000), message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } },
  ]
    .map((o) => JSON.stringify(o))
    .join('\n') + '\n';

function setup(t: test.TestContext) {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-start-')));
  t.after(() => fs.rmSync(real, { recursive: true, force: true }));
  const root = path.join(real, 'repo');
  const worktrees = path.join(real, 'repo.worktrees');
  const projects = path.join(real, 'projects');
  for (const d of [root, path.join(worktrees, 'J1'), projects]) fs.mkdirSync(d, { recursive: true });
  const subagents = path.join(projects, projectSlug(root), DRIVER, 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  const plant = (agentId: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(subagents, `agent-${agentId}.jsonl`)), { recursive: true });
    fs.writeFileSync(path.join(subagents, `agent-${agentId}.jsonl`), text);
  };
  const job = (id: string, events: JobEvent[], more: Record<string, unknown> = {}): StatsSource => {
    const j = normalizeJob({ id, stage: 'done', state: 'done', createdAt: iso(T0), finishedAt: iso(T0 + 60 * MIN), worktree: path.join(worktrees, id), ...more }) as Job;
    j.lease = { driver: DRIVER } as Job['lease'];
    return { job: j, events: () => events, findings: () => ({ rounds: [], byLens: {}, totals: { raised: 0, fixed: 0, disputed: 0, recurring: 0 }, recurring: [], disputed: [] }), archived: false };
  };
  return { real, root, worktrees, projects, plant, job };
}

test('seconds from agent start to first tool call, foreground and background', (t) => {
  const { root, worktrees, projects, plant, job } = setup(t);
  plant('a1', transcript(1, 12));
  plant('b1', transcript(10, 4));
  plant('b2', transcript(12, 6));
  // c1 has no transcript, and the running job's is never read.
  plant('r1', transcript(2, 1));
  const done = job('J1', [...run('builder', 1, 5, 'a1'), ...run('reviewer:code', 10, 20, 'b1'), ...run('reviewer:docs', 12, 18, 'b2'), ...run('verifier', 30, 35, 'c1')]);
  const running = job('J2', run('builder', 2, 3, 'r1'), { state: 'running' });
  const opts = { projects, worktrees };
  assert.deepEqual(agentStartSeconds(root, [done, running], opts), {
    foreground: { median: 12, p90: 12, n: 1 },
    background: { median: 5, p90: 6, n: 2 },
  });
  // The newest three runs by start: c1 (no transcript), b2, b1.
  assert.deepEqual(agentStartSeconds(root, [done], { ...opts, maxRuns: 3 }), {
    foreground: { median: null, p90: null, n: 0 },
    background: { median: 5, p90: 6, n: 2 },
  });
  // Over a given job list, and in statsFrom, no transcript is read.
  const none = { foreground: { median: null, p90: null, n: 0 }, background: { median: null, p90: null, n: 0 } };
  assert.deepEqual(statsFrom([done]).speed.agentStartSeconds, none);
  assert.deepEqual(computeStats(root, { jobs: [done.job] }).speed.agentStartSeconds, none);
});

test('an agent id or transcript link outside the projects dir is never read', (t) => {
  const { real, root, worktrees, projects, plant, job } = setup(t);
  plant('ok', transcript(1, 10));
  // A traversal id: a file planted where its path would land is never opened.
  plant('../x', transcript(10, 3));
  // A link to a transcript outside the projects dir.
  fs.writeFileSync(path.join(real, 'outside.jsonl'), transcript(20, 5));
  const subagents = path.join(projects, projectSlug(root), DRIVER, 'subagents');
  fs.symlinkSync(path.join(real, 'outside.jsonl'), path.join(subagents, 'agent-l1.jsonl'));
  const src = job('J1', [...run('builder', 1, 5, 'ok'), ...run('reviewer:code', 10, 15, '../x'), ...run('reviewer:docs', 20, 25, 'l1')]);
  assert.deepEqual(agentStartSeconds(root, [src], { projects, worktrees }), {
    foreground: { median: 10, p90: 10, n: 1 },
    background: { median: null, p90: null, n: 0 },
  });
});
