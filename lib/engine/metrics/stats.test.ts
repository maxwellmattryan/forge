import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentStartSeconds, computeStats, statsFrom } from './stats.ts';
import type { StatsSource } from './stats.ts';
import { normalizeJob } from '#core/job/schema.ts';
import { projectSlug } from '#integrations/claude/transcripts.ts';
import type { Job, JobEvent, JobUsage } from '#core/types.ts';
import type { JobFindings } from '#core/job/types.ts';

/** A `verifiers` record event for round `round`. */
const record = (round: number, outcome: 'PASS' | 'CHANGES', results: unknown[]): JobEvent => ({
  v: 1,
  ts: '2026-10-01T10:00:00.000Z',
  type: 'verifiers',
  phase: 'record',
  round,
  outcome,
  results,
});
const RESULTS = [{ name: 'cli-help', mode: 'block', answer: 'no' }];

/** A job with no verdicts, so stats never reads its findings. */
const source = (id: string, events: JobEvent[], job: Record<string, unknown> = {}): StatsSource => ({
  job: normalizeJob({ id, ...job }),
  events: () => events,
  findings: () => {
    throw new Error('a job without verdicts has no findings to read');
  },
  archived: false,
});

test("verifierFirstRoundBlockRate counts each job's first round-1 verifiers record", () => {
  assert.equal(statsFrom([]).quality.verifierFirstRoundBlockRate, null, 'no jobs');
  const five = [
    source('blocked', [record(1, 'CHANGES', RESULTS)]),
    source('passed', [record(1, 'PASS', [{ name: 'cli-help', mode: 'block', answer: 'yes' }])]),
    source('no-results', [record(1, 'PASS', [])]),
    source('round-2-only', [record(2, 'CHANGES', RESULTS)]),
    source('rerun', [record(1, 'PASS', RESULTS), record(1, 'CHANGES', RESULTS), record(2, 'CHANGES', RESULTS)]),
  ];
  assert.equal(statsFrom(five).quality.verifierFirstRoundBlockRate, 0.333, '1 blocked of 3 counted');
  assert.equal(statsFrom([five[0]]).quality.verifierFirstRoundBlockRate, 1);
  assert.equal(statsFrom([five[2], five[3]]).quality.verifierFirstRoundBlockRate, null, 'no job counts');
});

type Lens = JobFindings['byLens'][string];
const lens = (more: Partial<Lens> = {}): Lens => ({ raised: 0, fixed: 0, disputed: 0, recurring: 0, ...more });
/** A reviewed job: its verdicts by round, and its findings record. */
const reviewed = (id: string, verdicts: Record<number, Record<string, string>>, byLens: JobFindings['byLens'] = {}, totals: Partial<JobFindings['totals']> = {}, archived = false): StatsSource => ({
  job: normalizeJob({ id, verdicts }),
  events: () => [],
  findings: () => ({ rounds: [], byLens, totals: { raised: 0, fixed: 0, disputed: 0, recurring: 0, ...totals }, recurring: [], disputed: [] }),
  archived,
});

test('per-lens review figures: blockers, sole CHANGES and reopens, narrowed and archived', () => {
  const live = reviewed(
    'live',
    { 1: { code: 'PASS', security: 'CHANGES' }, 2: { security: 'CHANGES', docs: 'CHANGES' }, 3: { security: 'PASS' } },
    { security: lens({ raised: 3, severity: { blocker: 2, major: 1, minor: 0, nit: 0 } }), docs: lens({ raised: 1, severity: { blocker: 0, major: 0, minor: 1, nit: 0 } }) },
    { carried: 3, new: 1 },
  );
  const s = statsFrom([live]).reviewers;
  assert.deepEqual([s.security.blockers, s.security.soleChanges, s.docs.soleChanges, s.code.soleChanges], [2, 1, 0, 0]);
  assert.deepEqual([s.security.reopened, s.docs.reopened], [0, 0], 'CHANGES after CHANGES, or after no verdict, is no reopen');

  // Round 2 ran only security (review.onRework: narrow): code's previous verdict is round 1's PASS.
  const narrowed = { 1: { code: 'PASS', security: 'CHANGES' }, 2: { security: 'PASS' }, 3: { security: 'CHANGES', code: 'CHANGES' } };
  const n = statsFrom([reviewed('narrowed', narrowed)]).reviewers;
  assert.deepEqual([n.code.reopened, n.security.reopened, n.security.soleChanges, n.code.soleChanges], [1, 1, 1, 0]);

  // An archived record's verdicts count the same; its findings carry no severity and no carried/new.
  const archived = reviewed('archived', narrowed, { security: lens({ raised: 4 }) }, {}, true);
  const all = statsFrom([live, reviewed('narrowed', narrowed), archived]);
  assert.deepEqual([all.reviewers.security.blockers, all.reviewers.security.soleChanges, all.reviewers.security.reopened, all.reviewers.code.reopened], [2, 3, 2, 2]);
  assert.deepEqual([all.quality.findingsCarried, all.quality.findingsNew], [3, 1]);
  assert.equal(all.counts.archived, 1);

  const empty = statsFrom([]);
  assert.deepEqual([empty.quality.findingsCarried, empty.quality.findingsNew, empty.speed.timedJobs, empty.speed.medianHandoffMinutes], [0, 0, 0, null]);
  assert.deepEqual([empty.speed.stageMinutes, empty.speed.waitingMinutes], [{}, {}]);
});

test('cacheReadShare per role', () => {
  const bucket = (input: unknown, cacheRead: unknown, cacheWrite: unknown) => ({ tokens: 1, input, output: 0, cacheRead, cacheWrite, toolUses: 0, durationMs: 0, runs: 1, estCostUsd: 0 });
  const withUsage = (id: string, byRole: Record<string, unknown>): StatsSource => {
    const src = source(id, []);
    src.job.usage = { ...src.job.usage, byRole: byRole as JobUsage['byRole'], byModel: { 'claude-x': bucket(1, 1, 1) as JobUsage['byModel'][string] } };
    return src;
  };
  const s = statsFrom([
    withUsage('a', { builder: bucket(100, 800, 100), reviewer: bucket(0, 0, 0) }),
    // A field that is not a number reads as 0.
    withUsage('b', { builder: bucket(50, 'x', 50) }),
  ]);
  assert.equal(s.cost.byRole.builder.cacheReadShare, 0.727);
  assert.equal(s.cost.byRole.reviewer.cacheReadShare, null, 'null at 0');
  assert.ok(!('cacheReadShare' in s.cost.byModel['claude-x']), 'byRole rows only');
});

test('a __proto__ key in job.json or a findings record never reaches Object.prototype', (t) => {
  const polluted = ['read', 'all', 'reviews', 'changes', 'blockers', 'soleChanges', 'reopened', 'findings', 'tokens', 'runs', 'estCostUsd'];
  t.after(() => {
    for (const k of polluted) delete (Object.prototype as Record<string, unknown>)[k];
  });
  const bucket = '{"tokens":1,"input":1,"output":0,"cacheRead":1,"cacheWrite":0,"toolUses":0,"durationMs":0,"runs":1,"estCostUsd":1}';
  const src = reviewed('hostile', {}, JSON.parse('{"__proto__":{"raised":1,"fixed":0,"disputed":0,"recurring":0,"severity":{"blocker":1}}}'));
  // JSON.parse makes `__proto__` an own key, as job.json and an archive record can.
  src.job.verdicts = JSON.parse('{"1":{"__proto__":"CHANGES","code":"CHANGES"}}');
  src.job.usage = { ...src.job.usage, byRole: JSON.parse(`{"__proto__":${bucket}}`), byModel: JSON.parse(`{"__proto__":${bucket}}`) };
  const s = statsFrom([src]);
  for (const k of polluted) assert.equal(Object.hasOwn(Object.prototype, k), false, k);
  assert.deepEqual(Object.keys(s.reviewers), ['code'], 'the hostile lens name is skipped');
  assert.deepEqual([s.reviewers.code.soleChanges, Object.keys(s.cost.byRole), Object.keys(s.cost.byModel)], [1, [], []]);
});

test('a shelved job counts as shelved, not waiting', () => {
  const s = statsFrom([
    source('shelved', [], { state: 'waiting', waitingOn: 'shelved' }),
    source('escalated', [], { state: 'waiting', waitingOn: 'escalation' }),
    source('queued', [], { state: 'queued' }),
  ]);
  assert.deepEqual([s.counts.active, s.counts.waiting, s.counts.shelved], [3, 1, 1]);
  assert.deepEqual(s.waitingOn, { escalation: 1 });
});

// Agent start: real transcript files under a temp projects dir, never process.env.
const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const MIN = 60_000;
const DRIVER = '44444444-4444-4444-8444-444444444444';
const iso = (ms: number): string => new Date(ms).toISOString();
const run = (role: string, start: number, end: number, agentId: string): JobEvent[] => [
  { v: 1, ts: iso(T0 + start * MIN), type: 'agent-start', role },
  { v: 1, ts: iso(T0 + end * MIN), type: 'agent-end', role, agentId },
];
/** A transcript whose first tool call comes `sec` seconds after the run's start, `attached` bytes into the file. */
const transcript = (startMin: number, sec: number, attached = 0): string =>
  [
    // Claude Code writes its large attachment lines (skills, tools, instructions) before the first turn.
    { type: 'attachment', timestamp: iso(T0 + startMin * MIN), content: 'x'.repeat(attached) },
    { type: 'user', timestamp: iso(T0 + startMin * MIN), message: { content: [{ type: 'text', text: 'brief' }] } },
    { type: 'assistant', timestamp: iso(T0 + startMin * MIN + sec * 1000), message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } },
  ]
    .map((o) => JSON.stringify(o))
    .join('\n') + '\n';

function transcripts(t: test.TestContext) {
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
  return { real, root, worktrees, projects, subagents, plant, job };
}

test('seconds from agent start to first tool call, foreground and background', (t) => {
  const { root, worktrees, projects, plant, job } = transcripts(t);
  // a1's first tool call sits 200 KB in, past a first 64 KiB read, as in a real transcript.
  plant('a1', transcript(1, 12, 200 * 1024));
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
  const { real, root, worktrees, projects, subagents, plant, job } = transcripts(t);
  plant('ok', transcript(1, 10));
  // A traversal id: a file planted where its path would land is never opened.
  plant('../x', transcript(10, 3));
  // A link to a transcript outside the projects dir.
  fs.writeFileSync(path.join(real, 'outside.jsonl'), transcript(20, 5));
  fs.symlinkSync(path.join(real, 'outside.jsonl'), path.join(subagents, 'agent-l1.jsonl'));
  const src = job('J1', [...run('builder', 1, 5, 'ok'), ...run('reviewer:code', 10, 15, '../x'), ...run('reviewer:docs', 20, 25, 'l1')]);
  assert.deepEqual(agentStartSeconds(root, [src], { projects, worktrees }), {
    foreground: { median: 10, p90: 10, n: 1 },
    background: { median: null, p90: null, n: 0 },
  });
});
