// The dashboard's budget model against the engine's rule: budgetRows' limits are effectiveLimits'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '#core/config/load.ts';
import { effectiveLimits } from '#engine/metrics/budget.ts';
import { budgetRows, unattendedDefault } from './budget.ts';

type EngineConfig = ReturnType<typeof defaults>;

function daemonConfig(budget: Record<string, number | null>, jobBudget: { tokens?: number | null; usd?: number | null; minutes?: number | null } | null = { tokens: 600000000, usd: 150 }, enabled = true): EngineConfig {
  const c = defaults();
  c.pipeline.budget = { ...c.pipeline.budget, tokens: null, usd: null, minutes: null, ...budget };
  c.daemon = { ...c.daemon, enabled, jobBudget };
  return c;
}

const job = (limits: Record<string, number | null> = {}) => ({ id: 'j-1', round: 1, budget: { limits, ack: {}, lastCheck: null }, usage: {} }) as never;

test('budgetRows limits match effectiveLimits', () => {
  const rows: [string, EngineConfig, Record<string, number | null>][] = [
    ['nothing set', daemonConfig({}), {}],
    ['config usd 50', daemonConfig({ usd: 50 }), {}],
    ['config minutes 30', daemonConfig({ minutes: 30 }), {}],
    ['job override tokens 5', daemonConfig({}), { tokens: 5 }],
    ['job override usd null', daemonConfig({}), { usd: null }],
    ['daemon off', daemonConfig({}, undefined, false), {}],
    ['jobBudget null', daemonConfig({}, null), {}],
  ];
  for (const [name, config, limits] of rows) {
    const j = job(limits);
    const shown = Object.fromEntries(budgetRows(j, config.pipeline.budget, unattendedDefault(config)).map((r) => [r.key, r.limit]));
    assert.deepEqual(shown, effectiveLimits(config, j), name);
  }
});
