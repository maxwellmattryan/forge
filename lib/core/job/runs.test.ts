// A role's agent runs: what each end records on the agent (recordRun), the runs rebuilt for the dashboard
// (agentRuns, runsTokens) and the agents served without them (withoutRunHistory).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_AGENT_RUNS, agentRuns, recordRun, runsTokens, withoutRunHistory } from './runs.ts';
import type { AgentRun, ContextComposition, JobAgent, JobEvent } from '../types.ts';

const COMP: ContextComposition = { total: 100, forgePrompt: 10, harness: 50, carried: 0, tools: [{ name: 'Read', tokens: 30 }], assistant: 6, user: 4 };
const COMP2: ContextComposition = { ...COMP, total: 200, harness: 150 };
const USAGE = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 };
const run = (over: Partial<AgentRun> = {}): AgentRun => ({ round: 1, startedAt: 'S', endedAt: 'E', status: 'done', model: 'opus', usage: { ...USAGE }, composition: null, ...over });
const end = { at: '2026-10-02T10:05:00.000Z', round: 2, status: 'done', model: 'opus' };

test('recordRun', async (t) => {
  const rows: { name: string; agent: JobAgent; end: Parameters<typeof recordRun>[1]; want: AgentRun[] }[] = [
    {
      name: 'the end of a running agent appends a run, with its round',
      agent: { runs: 1, status: 'running', startedAt: '2026-10-02T10:00:00.000Z', round: 2 },
      end: { ...end, wasRunning: true, usage: { ...USAGE, toolUses: 3, exact: true }, composition: COMP },
      want: [{ round: 2, startedAt: '2026-10-02T10:00:00.000Z', endedAt: end.at, status: 'done', model: 'opus', usage: USAGE, composition: COMP }],
    },
    {
      name: 'a second end with usage folds its counts into the last run and keeps its composition without one',
      agent: { runs: 1, status: 'done', runHistory: [run({ composition: COMP })] },
      end: { ...end, wasRunning: false, usage: { input: 10, totalTokens: 15 } },
      want: [run({ usage: { input: 11, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 25 }, composition: COMP })],
    },
    {
      name: 'a second end with a composition replaces it',
      agent: { runs: 1, status: 'done', runHistory: [run({ composition: COMP })] },
      end: { ...end, wasRunning: false, usage: { totalTokens: 5 }, composition: COMP2 },
      want: [run({ usage: { ...USAGE, totalTokens: 15 }, composition: COMP2 })],
    },
    {
      name: 'a lost end of a running agent with no usage appends a run without usage',
      agent: { runs: 1, status: 'running', startedAt: 'S', round: 2 },
      end: { ...end, wasRunning: true, status: 'lost' },
      want: [{ round: 2, startedAt: 'S', endedAt: end.at, status: 'lost', model: 'opus', usage: null, composition: null }],
    },
    { name: 'an end with no usage on an agent that never started appends nothing', agent: { runs: 0 }, end: { ...end, wasRunning: false, status: 'lost' }, want: [] },
    {
      name: 'an end with usage on an ended agent with only legacy runs leaves them to the events',
      agent: { runs: 1, status: 'done', legacyRuns: 1 },
      end: { ...end, wasRunning: false, usage: { totalTokens: 5 } },
      want: [],
    },
    {
      name: 'a non-array runHistory is reset to []',
      agent: { runs: 1, status: 'done', runHistory: 'x' as unknown as AgentRun[] },
      end: { ...end, wasRunning: false },
      want: [],
    },
  ];
  for (const row of rows) {
    await t.test(row.name, () => {
      recordRun(row.agent, row.end);
      assert.deepEqual(row.agent.runHistory, row.want);
    });
  }

  await t.test(`the list keeps at most ${MAX_AGENT_RUNS} runs, dropping the oldest`, () => {
    const a: JobAgent = { runs: MAX_AGENT_RUNS + 1, status: 'running', startedAt: 'S', round: 9, runHistory: Array.from({ length: MAX_AGENT_RUNS }, (_, i) => run({ endedAt: `E${i}` })) };
    recordRun(a, { ...end, wasRunning: true, usage: USAGE });
    assert.equal(a.runHistory!.length, MAX_AGENT_RUNS);
    assert.equal(a.runHistory![0]!.endedAt, 'E1', 'the oldest run dropped');
    assert.equal(a.runHistory!.at(-1)!.round, 2);
  });
});

const ev = (type: string, ts: string, extra: Partial<JobEvent> = {}): JobEvent => ({ v: 1, ts, type, role: 'builder', ...extra });

test('agentRuns', async (t) => {
  const events: JobEvent[] = [
    ev('agent-start', 'T1', { model: 'opus' }),
    ev('agent-start', 'T1b', { role: 'reviewer:code' }),
    ev('agent-end', 'T2', { usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20, totalTokens: 135 } }),
    ev('agent-end', 'T2b', { role: 'reviewer:code', usage: { totalTokens: 999 } }),
    ev('agent-end', 'T3', { usage: { totalTokens: 100 }, status: 'done' }),
    ev('agent-start', 'T4'),
    ev('agent-end', 'T5', { status: 'failed', model: 'sonnet', usage: { input: -5, output: Infinity, cacheRead: 'x' as unknown as number, cacheWrite: 7 } }),
    ev('agent-end', 'T6'),
    ev('agent-start', 'T7'),
    ev('agent-end', 'T8', { usage: { totalTokens: 1 } }),
  ];

  await t.test('legacy runs pair starts with ends, fold a further end with usage, and skip one with neither', () => {
    const runs = agentRuns('builder', { runs: 3, status: 'done', legacyRuns: 2 }, events);
    assert.deepEqual(runs, [
      { round: null, startedAt: 'T1', endedAt: 'T2', status: 'done', model: 'opus', usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20, totalTokens: 235 }, composition: null },
      { round: null, startedAt: 'T4', endedAt: 'T5', status: 'failed', model: 'sonnet', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 7, totalTokens: 7 }, composition: null },
    ]);
    assert.equal(runsTokens(runs), 242);
  });

  await t.test('an agent without legacyRuns has none', () => {
    assert.deepEqual(agentRuns('builder', { runs: 3, status: 'done' }, events), []);
  });

  await t.test(`at most min(legacyRuns, ${MAX_AGENT_RUNS}) legacy runs are taken`, () => {
    const many = Array.from({ length: MAX_AGENT_RUNS + 10 }, (_, i) => [ev('agent-start', `S${i}`), ev('agent-end', `E${i}`, { usage: { totalTokens: 1 } })]).flat();
    assert.equal(agentRuns('builder', { runs: 1000, legacyRuns: 1000 }, many).length, MAX_AGENT_RUNS);
    assert.equal(agentRuns('builder', { runs: 3, legacyRuns: 3 }, many).length, 3);
  });

  await t.test('legacy runs come first, then runHistory without its malformed entries', () => {
    const bad = { ...COMP, harness: 51 };
    const history = [null, 'x', run({ usage: { ...USAGE, input: '1' as unknown as number } }), run({ round: 3, composition: COMP }), run({ round: 4, composition: bad }), run({ round: 5, usage: null, composition: { ...COMP, tools: { Read: 30 } } as unknown as ContextComposition })];
    const runs = agentRuns('builder', { runs: 4, status: 'done', legacyRuns: 1, runHistory: history as AgentRun[] }, events);
    assert.deepEqual(
      runs.map((r) => [r.round, r.composition]),
      [
        [null, null],
        [3, COMP],
        [4, null],
        [5, null],
      ],
    );
    assert.equal(runsTokens(runs), 235 + 10 + 10);
  });

  await t.test('runsTokens is null when no run has usage', () => {
    assert.equal(runsTokens([]), null);
    assert.equal(runsTokens([run({ usage: null })]), null);
  });
});

test('withoutRunHistory', () => {
  const agents: Record<string, JobAgent> = { builder: { runs: 2, status: 'done', model: 'opus', legacyRuns: 1, runHistory: [run()] }, planner: { runs: 1 } };
  assert.deepEqual(withoutRunHistory(agents), { builder: { runs: 2, status: 'done', model: 'opus' }, planner: { runs: 1 } });
  assert.equal(agents.builder!.runHistory!.length, 1, 'the job itself is left alone');
});
