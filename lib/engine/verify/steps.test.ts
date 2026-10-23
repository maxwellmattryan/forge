import test from 'node:test';
import assert from 'node:assert/strict';
import { runGroups } from './steps.ts';
import type { VerifyStep } from './steps.ts';

/** How a stub step behaves: how many event-loop turns it takes, and whether it fails or throws. */
type Plan = Record<string, { ticks: number; ok?: boolean; throws?: boolean }>;

const turns = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** A stub step runner that logs when each step starts and settles: no worktree, no command. */
const stub = (plan: Plan, log: string[]) => async (step: string): Promise<VerifyStep> => {
  log.push(`start ${step}`);
  await turns(plan[step]!.ticks);
  log.push(`end ${step}`);
  if (plan[step]!.throws) throw new Error(`${step} threw`);
  return { name: step, ok: plan[step]!.ok ?? true };
};

test('verify groups run in config order and stop after a failing group', async () => {
  const rows: { name: string; groups: string[][]; plan: Plan; want: { results: string[] | null; error: string | null; log: string[]; after: string[][] } }[] = [
    {
      name: 'results keep config order when steps finish in reverse',
      groups: [['a', 'b', 'c']],
      plan: { a: { ticks: 3 }, b: { ticks: 2 }, c: { ticks: 1 } },
      want: { results: ['a:ok', 'b:ok', 'c:ok'], error: null, log: ['start a', 'start b', 'start c', 'end c', 'end b', 'end a'], after: [['a', 'b', 'c']] },
    },
    {
      name: 'a failing group lets its siblings finish and no later group starts',
      groups: [['a', 'b'], ['c']],
      plan: { a: { ticks: 1, ok: false }, b: { ticks: 3 }, c: { ticks: 1 } },
      want: { results: ['a:fail', 'b:ok'], error: null, log: ['start a', 'start b', 'end a', 'end b'], after: [['a', 'b']] },
    },
    {
      name: 'a step that throws rejects only after its siblings settle, and its group gets no afterGroup',
      groups: [['first'], ['boom', 'slow'], ['never']],
      plan: { first: { ticks: 1 }, boom: { ticks: 1, throws: true }, slow: { ticks: 3 }, never: { ticks: 1 } },
      want: { results: null, error: 'boom threw', log: ['start first', 'end first', 'start boom', 'start slow', 'end boom', 'end slow', 'rejected'], after: [['first']] },
    },
    {
      name: "afterGroup gets each completed group's results once",
      groups: [['a'], ['b', 'c']],
      plan: { a: { ticks: 1 }, b: { ticks: 2 }, c: { ticks: 1 } },
      want: { results: ['a:ok', 'b:ok', 'c:ok'], error: null, log: ['start a', 'end a', 'start b', 'start c', 'end c', 'end b'], after: [['a'], ['b', 'c']] },
    },
    { name: 'empty groups give []', groups: [], plan: {}, want: { results: [], error: null, log: [], after: [] } },
  ];
  for (const row of rows) {
    const log: string[] = [];
    const after: string[][] = [];
    let results: string[] | null = null;
    let error: string | null = null;
    try {
      const ran = await runGroups(row.groups, stub(row.plan, log), (g) => after.push(g.map((s) => s.name)));
      results = ran.map((s) => `${s.name}:${s.ok ? 'ok' : 'fail'}`);
    } catch (e) {
      error = (e as Error).message;
      log.push('rejected');
    }
    assert.deepEqual({ results, error, log, after }, row.want, row.name);
  }
});
