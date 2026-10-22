import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evalScratch, forgeAsync } from './helpers.ts';
import { aggregateTasks, jobTiming, stat } from '../lib/eval-stats.ts';
import { compareRuns, listRuns, pluginHash, summarize } from '../lib/evals.ts';
import { loadJob } from '../lib/core/job/store.ts';
import { PLUGIN_ROOT } from '../lib/core/paths.ts';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const ev = (min: number, type: string, extra: Record<string, unknown> = {}) => ({ v: 1, ts: at(min), type, ...extra });
const side = (stage: string) => ({ stage, state: 'running', waitingOn: null });
const move = (min: number, from: string, to: string) => ev(min, 'transition', { from: side(from), to: side(to) });
const agent = (min: number, phase: 'start' | 'end', role: string) => ev(min, `agent-${phase}`, { role });

/** A graded result with only the fields the aggregates read. */
function result(over: Record<string, any> = {}) {
  return {
    check: { ran: true, pass: true, tail: null },
    judge: null,
    decision: 'APPROVE',
    rounds: 1,
    firstPass: true,
    verifyFirstPass: true,
    tokens: 100,
    estCostUsd: 1,
    minutes: 10,
    gradedAt: 'x',
    ...over,
  };
}

const entry = (task: string, res: any, repeat = 1) => ({ task, job: `${task}-${repeat}`, worktreeOk: true, result: res, repeat });

/** A temp dir holding only the run files compareRuns and listRuns read. */
function runsRoot(runs: Record<string, any>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-evalab-')));
  const dir = path.join(root, '.forge', 'evals', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, r] of Object.entries(runs)) fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, ...r }));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const v1Run = (id: string, tasks: any[], extra: Record<string, any> = {}) => ({
  schemaVersion: 1, // old-version fixture: an eval run record, not a config or job
  id,
  label: null,
  forgeVersion: '0.16.0',
  configHash: 'abcdef0123',
  models: {},
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: null,
  status: 'running',
  tasks,
  ...extra,
});

/** Nothing on disk says a run started: no job dir, no clone, no run file. */
function assertNothingCreated(dir: string) {
  const list = (p: string) => (fs.existsSync(p) ? fs.readdirSync(p) : []);
  assert.deepEqual(list(path.join(dir, '.forge', 'jobs')), []);
  assert.deepEqual(list(path.join(dir, '.forge', 'evals', 'runs')), []);
  assert.equal(fs.existsSync(`${dir}.wt`), false);
}

test('pluginHash covers prompts, checklists, the skill, step and brief only', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plugin-')));
  const files: Record<string, string> = {
    'agents/builder.md': 'build',
    'agents/sub/x.md': 'nested',
    'agents/notes.txt': 'not markdown',
    'reviewers/code.md': 'code lens',
    'skills/forge/SKILL.md': 'skill',
    'skills/forge/reference/evals.md': 'evals',
    'lib/step.ts': 'step',
    'lib/step/stages/build.ts': 'build stage',
    'lib/brief.ts': 'brief',
    'lib/evals.ts': 'evals engine',
    'README.md': 'readme',
  };
  const put = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  try {
    for (const [rel, text] of Object.entries(files)) put(rel, text);
    const h0 = pluginHash(root);
    assert.match(h0, /^[0-9a-f]{10}$/);
    assert.equal(pluginHash(root), h0, 'stable');

    const changes = (label: string, change: () => void, undo: () => void, changed: boolean) => {
      change();
      assert.equal(pluginHash(root) !== h0, changed, label);
      undo();
      assert.equal(pluginHash(root), h0, `${label}: undone`);
    };
    for (const rel of ['agents/builder.md', 'reviewers/code.md', 'skills/forge/SKILL.md', 'skills/forge/reference/evals.md', 'lib/step.ts', 'lib/step/stages/build.ts', 'lib/brief.ts'])
      changes(`edit ${rel}`, () => put(rel, 'changed'), () => put(rel, files[rel]), true);
    changes('add an agent', () => put('agents/new.md', 'new'), () => fs.rmSync(path.join(root, 'agents/new.md')), true);
    changes('add a skill file', () => put('skills/forge/reference/deep/x.md', 'x'), () => fs.rmSync(path.join(root, 'skills/forge/reference/deep'), { recursive: true }), true);
    changes('remove a checklist', () => fs.rmSync(path.join(root, 'reviewers/code.md')), () => put('reviewers/code.md', files['reviewers/code.md']), true);
    const from = path.join(root, 'skills/forge/reference/evals.md');
    const to = path.join(root, 'skills/forge/reference/other.md');
    changes('rename a skill file', () => fs.renameSync(from, to), () => fs.renameSync(to, from), true);

    for (const rel of ['README.md', 'lib/evals.ts', 'agents/sub/x.md', 'agents/notes.txt'])
      changes(`edit ${rel}`, () => put(rel, 'changed'), () => put(rel, files[rel]), false);
    const link = path.join(root, 'agents', 'link.md');
    changes('a symlinked prompt', () => fs.symlinkSync(path.join(root, 'README.md'), link), () => fs.rmSync(link), false);
    assert.match(pluginHash(path.join(root, 'missing')), /^[0-9a-f]{10}$/, 'missing paths are skipped');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('jobTiming splits wall time by stage and agent', () => {
  const events = [
    move(1, 'backlog', 'spec'),
    agent(1, 'start', 'spec-writer'),
    agent(3, 'end', 'spec-writer'),
    move(4, 'spec', 'build'),
    agent(4, 'start', 'builder'),
    agent(10, 'end', 'builder'),
    move(11, 'build', 'review'),
    agent(11, 'start', 'reviewer:code'),
    agent(11, 'start', 'reviewer:tests'),
    agent(14, 'end', 'reviewer:code'),
    agent(15, 'end', 'reviewer:tests'),
    // Never ends: ignored for time, still a reviewer run.
    agent(16, 'start', 'reviewer:code'),
    move(17, 'review', 'decide'),
    // A state-only transition keeps the stage.
    ev(18, 'transition', { from: side('decide'), to: { stage: 'decide', state: 'waiting', waitingOn: 'human' } }),
  ];
  // File order is not time order.
  const shuffled = [events[5], ...events.slice(0, 5), ...events.slice(6)];
  const t = jobTiming(shuffled as any, at(0), T0 + 20 * 60_000, 'done');
  assert.deepEqual(t.stages, { backlog: 1, spec: 3, build: 7, review: 6, decide: 3 });
  // 2 + 6 + 3 + 4, the overlapping reviewers summed.
  assert.equal(t.agentMinutes, 15);
  // The union of busy time is [1,3] [4,10] [11,15] = 12 of 20 minutes.
  assert.equal(t.orchestratorMinutes, 8);
  assert.equal(t.reviewerRuns, 3);

  const none = jobTiming([], at(0), T0 + 90_000, 'build');
  assert.deepEqual(none, { stages: { build: 1.5 }, agentMinutes: 0, orchestratorMinutes: 1.5, reviewerRuns: 0 });

  // A second start of a role before its end drops the first; a plain `reviewer` counts.
  const again = jobTiming([agent(1, 'start', 'builder'), agent(2, 'start', 'builder'), agent(5, 'end', 'builder'), agent(5, 'start', 'reviewer'), agent(6, 'end', 'reviewer')] as any, at(0), T0 + 6 * 60_000, 'build');
  assert.equal(again.agentMinutes, 4);
  assert.equal(again.orchestratorMinutes, 2);
  assert.equal(again.reviewerRuns, 1);

  assert.deepEqual(jobTiming([agent(1, 'start', 'reviewer:code')] as any, null, T0, 'build'), { stages: {}, agentMinutes: null, orchestratorMinutes: null, reviewerRuns: 1 });
  // Rounded to 0.01 minutes as `minutes` is.
  assert.deepEqual(jobTiming([], at(0), T0 + 1000, 'spec').stages, { spec: 0.02 });
});

test('old results summarise with null timing', () => {
  const old = { tasks: [entry('a', result({ minutes: 4 })), entry('b', result({ minutes: 6, check: { ran: true, pass: false, tail: 'x' } })), entry('c', null)] };
  const s = summarize(old);
  assert.equal(s.tasks, 3);
  assert.equal(s.graded, 2);
  assert.equal(s.checkPassRate, 0.5);
  assert.equal(s.avgMinutes, 5);
  assert.equal(s.avgTokens, 100);
  assert.equal(s.avgAgentMinutes, null);
  assert.equal(s.avgOrchestratorMinutes, null);
  assert.equal(s.avgReviewerRuns, null);

  const timed = summarize({ tasks: [entry('a', result({ agentMinutes: 2, orchestratorMinutes: 1, reviewerRuns: 3 })), entry('b', result())] });
  assert.equal(timed.avgAgentMinutes, 2);
  assert.equal(timed.avgReviewerRuns, 3);

  // A done run finished before the new keys existed gains them as null.
  const storedSummary = { tasks: 1, graded: 1, checkPassRate: 1, avgJudgeScore: null, firstPassRate: 1, avgRounds: 1, escalationRate: 0, avgTokens: 100, avgCostUsd: 1, avgMinutes: 10 };
  const r = runsRoot({ done: v1Run('done', [entry('a', result())], { status: 'done', summary: storedSummary }) });
  try {
    const [run] = listRuns(r.root);
    assert.deepEqual(run.summary, { ...storedSummary, roundsExhaustedRate: null, avgAgentMinutes: null, avgOrchestratorMinutes: null, avgReviewerRuns: null });
  } finally {
    r.cleanup();
  }
});

test('roundsExhaustedRate counts rounds-exhausted tasks', () => {
  // A rounds-exhausted job has no approver decision, so escalationRate leaves it out.
  const s = summarize({ tasks: [entry('a', result({ roundsExhausted: true, decision: null })), entry('b', result({ roundsExhausted: false })), entry('c', result({ roundsExhausted: false })), entry('d', result({ roundsExhausted: false }))] });
  assert.equal(s.roundsExhaustedRate, 0.25);
  assert.equal(s.escalationRate, 0);
  // Results graded before the field are left out of the mean, not counted as 0.
  const mixed = summarize({ tasks: [entry('a', result({ roundsExhausted: true, decision: null })), entry('b', result())] });
  assert.equal(mixed.roundsExhaustedRate, 1);
  assert.equal(summarize({ tasks: [entry('a', result()), entry('b', null)] }).roundsExhaustedRate, null);
});

test('compare shows the roundsExhaustedRate delta', () => {
  const a = v1Run('a', [entry('t', result({ roundsExhausted: true, decision: null }), 1), entry('u', result({ roundsExhausted: false }), 1)]);
  const b = v1Run('b', [entry('t', result({ roundsExhausted: false }), 1), entry('u', result({ roundsExhausted: false }), 1)]);
  const r = runsRoot({ a, b });
  try {
    assert.deepEqual(compareRuns(r.root, 'a', 'b').delta.roundsExhaustedRate, { a: 0.5, b: 0, change: -0.5, na: 2, nb: 2 });
  } finally {
    r.cleanup();
  }
});

test('aggregateTasks gives mean, min, max and n per task', () => {
  const tasks = [
    entry('t', result({ minutes: 10, tokens: 100, judge: { score: 4, outOf: 5 }, agentMinutes: 6, orchestratorMinutes: 4, reviewerRuns: 2, stages: { build: 5, review: 3 } }), 1),
    entry('u', result({ minutes: 1, check: { ran: false, pass: null, tail: null }, firstPass: null }), 1),
    // Graded before timing existed.
    entry('t', result({ minutes: 20, tokens: 301, check: { ran: true, pass: false, tail: 'x' }, firstPass: false, rounds: 2 }), 2),
    entry('t', null, 3),
  ];
  const [t, u] = aggregateTasks(tasks as any);
  assert.equal(t.task, 't');
  assert.equal(t.runs, 3);
  assert.equal(t.graded, 2);
  assert.deepEqual(t.metrics.minutes, { n: 2, mean: 15, min: 10, max: 20 });
  assert.deepEqual(t.metrics.tokens, { n: 2, mean: 200.5, min: 100, max: 301 });
  assert.deepEqual(t.metrics.checkPass, { n: 2, mean: 0.5, min: 0, max: 1 });
  assert.deepEqual(t.metrics.firstPass, { n: 2, mean: 0.5, min: 0, max: 1 });
  assert.deepEqual(t.metrics.rounds, { n: 2, mean: 1.5, min: 1, max: 2 });
  assert.deepEqual(t.metrics.judgeScore, { n: 1, mean: 0.8, min: 0.8, max: 0.8 });
  assert.deepEqual(t.metrics.costUsd, { n: 2, mean: 1, min: 1, max: 1 });
  assert.deepEqual(t.metrics.agentMinutes, { n: 1, mean: 6, min: 6, max: 6 });
  assert.deepEqual(t.metrics.orchestratorMinutes, { n: 1, mean: 4, min: 4, max: 4 });
  assert.deepEqual(t.metrics.reviewerRuns, { n: 1, mean: 2, min: 2, max: 2 });
  assert.deepEqual(t.stages, { build: { n: 1, mean: 5, min: 5, max: 5 }, review: { n: 1, mean: 3, min: 3, max: 3 } });

  assert.equal(u.runs, 1);
  assert.deepEqual(u.metrics.checkPass, { n: 0, mean: null, min: null, max: null });
  assert.deepEqual(u.metrics.firstPass, stat([]));
  assert.deepEqual(u.stages, {});

  assert.deepEqual(stat([1, 2, 2]), { n: 3, mean: 1.667, min: 1, max: 2 });
  assert.deepEqual(aggregateTasks([entry('x', null)] as any)[0], {
    task: 'x',
    runs: 1,
    graded: 0,
    metrics: Object.fromEntries(Object.keys(t.metrics).map((k) => [k, stat([])])),
    stages: {},
  });
});

test('compare aggregates repeats and shows the count behind each delta', () => {
  const a = v1Run('a', [
    entry('t', result({ minutes: 10, stages: { build: 4 } }), 1),
    entry('t', result({ minutes: 20, check: { ran: true, pass: false, tail: 'x' }, stages: { build: 6, review: 2 } }), 2),
    entry('v', result({ minutes: 5 }), 1),
  ], { schemaVersion: 2, repeat: 2, pluginHash: '0123456789', overlay: { 'pipeline.maxRounds': 5 } }); // old-version fixture: an eval run record
  const b = v1Run('b', [
    entry('t', result({ minutes: 30, stages: { build: 8 } }), 1),
    entry('t', result({ minutes: 40, check: { ran: false, pass: null, tail: null } }), 2),
    entry('u', null, 1),
  ], { schemaVersion: 2, repeat: 2, pluginHash: '9876543210', overlay: {} }); // old-version fixture: an eval run record
  const r = runsRoot({ a, b });
  try {
    const c = compareRuns(r.root, 'a', 'b');
    assert.deepEqual(c.a, { id: 'a', configHash: 'abcdef0123', forgeVersion: '0.16.0', pluginHash: '0123456789', overlay: { 'pipeline.maxRounds': 5 }, repeat: 2 });
    assert.equal(c.b.pluginHash, '9876543210');
    for (const [k, d] of Object.entries(c.delta)) {
      assert.equal(typeof d.na, 'number', k);
      assert.equal(typeof d.nb, 'number', k);
    }
    assert.deepEqual(c.delta.avgMinutes, { a: 11.667, b: 35, change: 23.333, na: 3, nb: 2 });
    assert.deepEqual(c.delta.checkPassRate, { a: 0.667, b: 1, change: 0.333, na: 3, nb: 1 });
    assert.deepEqual(c.delta.tasks, { a: 3, b: 3, change: 0, na: 3, nb: 2 });
    assert.deepEqual(c.delta.avgAgentMinutes, { a: null, b: null, change: null, na: 0, nb: 0 });
    assert.deepEqual(c.stages, { build: { a: 5, b: 8, change: 3, na: 2, nb: 1 }, review: { a: 2, b: null, change: null, na: 1, nb: 0 } });

    assert.deepEqual(c.perTask.map((p) => p.task), ['t', 'v', 'u']);
    const [t, v, u] = c.perTask;
    // One failed repeat fails the task; a repeat whose check never ran doesn't count.
    assert.equal(t.a, false);
    assert.equal(t.b, true);
    assert.equal(t.stats.a?.runs, 2);
    assert.deepEqual(t.delta.minutes, { a: 15, b: 35, change: 20, na: 2, nb: 2 });
    assert.deepEqual(t.delta.checkPass, { a: 0.5, b: 1, change: 0.5, na: 2, nb: 1 });
    assert.equal(v.a, true);
    assert.equal(v.b, null);
    assert.equal(v.stats.b, null);
    assert.deepEqual(v.delta.minutes, { a: 5, b: null, change: null, na: 1, nb: 0 });
    assert.equal(u.a, null);
    assert.equal(u.b, null, 'not graded yet');
    assert.equal(u.stats.a, null);
    assert.equal(u.stats.b?.graded, 0);
    assert.deepEqual(u.delta.minutes, { a: null, b: null, change: null, na: 0, nb: 0 });
  } finally {
    r.cleanup();
  }
});

describe('eval start', { concurrency: 4 }, () => {
  test('runs and compare carry pluginHash, overlay and repeat', async () => {
    const s = evalScratch();
    try {
      const one = await forgeAsync(s.dir, ['eval', 'start', '--tasks', 't', '--label', 'a']);
      assert.equal(one.status, 0, one.stderr);
      const two = await forgeAsync(s.dir, ['eval', 'start', '--tasks', 't', '--label', 'b', '--set', 'pipeline.maxRounds=5']);
      assert.equal(two.status, 0, two.stderr);
      const a = JSON.parse(one.stdout);
      const b = JSON.parse(two.stdout);
      assert.equal(a.schemaVersion, 2);
      assert.equal(a.pluginHash, pluginHash(PLUGIN_ROOT));
      assert.match(a.pluginHash, /^[0-9a-f]{10}$/);
      assert.equal(JSON.stringify(a).includes(PLUGIN_ROOT), false, 'the plugin path is never recorded');

      const runs = await forgeAsync(s.dir, ['eval', 'runs']);
      assert.equal(runs.status, 0, runs.stderr);
      const rows = JSON.parse(runs.stdout);
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.pluginHash, a.pluginHash);
        assert.equal(row.repeat, 1);
      }
      assert.deepEqual(rows.find((r) => r.id === b.id).overlay, { 'pipeline.maxRounds': 5 });
      assert.deepEqual(rows.find((r) => r.id === a.id).overlay, {});

      const cmp = await forgeAsync(s.dir, ['eval', 'compare', a.id, b.id]);
      assert.equal(cmp.status, 0, cmp.stderr);
      const c = JSON.parse(cmp.stdout);
      assert.deepEqual(c.a, { id: a.id, configHash: a.configHash, forgeVersion: a.forgeVersion, pluginHash: a.pluginHash, overlay: {}, repeat: 1 });
      assert.deepEqual(c.b.overlay, { 'pipeline.maxRounds': 5 });
      assert.equal(c.b.repeat, 1);
      assert.equal(c.b.pluginHash, a.pluginHash);
    } finally {
      s.cleanup();
    }
  });

  test('repeat creates n jobs per task, each with a worktree', async () => {
    const s = evalScratch();
    try {
      const res = await forgeAsync(s.dir, ['eval', 'start', '--tasks', 't', '--repeat', '3', '--label', 'r']);
      assert.equal(res.status, 0, res.stderr);
      const rec = JSON.parse(res.stdout);
      assert.equal(rec.repeat, 3);
      assert.deepEqual(rec.tasks.map((t) => [t.task, t.repeat]), [['t', 1], ['t', 2], ['t', 3]]);
      assert.equal(new Set(rec.tasks.map((t) => t.job)).size, 3);
      rec.tasks.forEach((t, i) => {
        const job = loadJob(s.dir, t.job);
        assert.equal(job.branch, `forge-eval/${rec.id}/t-r${i + 1}`);
        assert.equal(job.eval?.repeat, i + 1);
        assert.equal(job.eval?.task, 't');
        assert.ok(job.worktree && fs.existsSync(job.worktree), `${t.job} has its worktree`);
        assert.equal(t.worktreeOk, true);
      });

      const plain = await forgeAsync(s.dir, ['eval', 'start', '--tasks', 't', '--label', 'p']);
      assert.equal(plain.status, 0, plain.stderr);
      const p = JSON.parse(plain.stdout);
      assert.equal(p.repeat, 1);
      assert.equal(p.tasks.length, 1);
      assert.equal(p.tasks[0].repeat, 1);
      const job = loadJob(s.dir, p.tasks[0].job);
      assert.equal(job.branch, `forge-eval/${p.id}/t`);
      assert.match(job.id, /^eval-t-/);
      assert.equal(job.eval?.repeat, 1);
    } finally {
      s.cleanup();
    }
  });

  test('a bad --repeat creates nothing', async () => {
    const s = evalScratch();
    try {
      const calls = [['0'], ['11'], ['1.5'], ['abc'], ['-1'], []].map((v) => forgeAsync(s.dir, ['eval', 'start', '--tasks', 't', '--repeat', ...v]));
      for (const r of await Promise.all(calls)) {
        assert.equal(r.status, 1, r.stderr);
        assert.match(r.stderr, /--repeat must be an integer from 1 to 10/);
      }
      assertNothingCreated(s.dir);
    } finally {
      s.cleanup();
    }
  });

  test('a v1 run record reads in runs, report and compare', async () => {
    const s = evalScratch();
    try {
      const now = await forgeAsync(s.dir, ['eval', 'start', '--tasks', 't', '--label', 'new']);
      assert.equal(now.status, 0, now.stderr);
      const fresh = JSON.parse(now.stdout);
      const old = v1Run('20250101-000000-old', [entry('t', result({ minutes: 7 })), entry('u', null)]);
      for (const k of ['repeat', 'overlay', 'pluginHash']) assert.equal(k in old, false);
      fs.writeFileSync(path.join(s.dir, '.forge', 'evals', 'runs', `${old.id}.json`), JSON.stringify(old));

      const runs = await forgeAsync(s.dir, ['eval', 'runs']);
      assert.equal(runs.status, 0, runs.stderr);
      const row = JSON.parse(runs.stdout).find((r) => r.id === old.id);
      assert.equal(row.repeat, 1);
      assert.deepEqual(row.overlay, {});
      assert.equal(row.pluginHash, null);
      assert.equal(row.summary.avgMinutes, 7);
      assert.equal(row.summary.avgAgentMinutes, null);

      const report = await forgeAsync(s.dir, ['eval', 'report', old.id]);
      assert.equal(report.status, 0, report.stderr);
      const r = JSON.parse(report.stdout);
      assert.equal(r.repeat, 1);
      assert.deepEqual(r.overlay, {});
      assert.equal(r.pluginHash, null);
      assert.deepEqual(r.perTask.map((p) => [p.task, p.runs, p.graded]), [['t', 1, 1], ['u', 1, 0]]);
      assert.deepEqual(r.perTask[0].metrics.agentMinutes, { n: 0, mean: null, min: null, max: null });
      assert.deepEqual(r.perTask[0].metrics.minutes, { n: 1, mean: 7, min: 7, max: 7 });

      const cmp = await forgeAsync(s.dir, ['eval', 'compare', old.id, fresh.id]);
      assert.equal(cmp.status, 0, cmp.stderr);
      const c = JSON.parse(cmp.stdout);
      assert.deepEqual(c.a, { id: old.id, configHash: old.configHash, forgeVersion: old.forgeVersion, pluginHash: null, overlay: {}, repeat: 1 });
      assert.equal(c.b.pluginHash, fresh.pluginHash);
      assert.deepEqual(c.delta.avgAgentMinutes, { a: null, b: null, change: null, na: 0, nb: 0 });
      assert.deepEqual(c.stages, {});
      assert.deepEqual(c.perTask.map((p) => p.task), ['t', 'u']);
      assert.equal(c.perTask[0].stats.b.graded, 0);
    } finally {
      s.cleanup();
    }
  });
});
