// The dashboard's budget model against the engine's rule (budgetRows' limits are effectiveLimits'), and
// the budget gate's Approve: the body its note gives and the POST it sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '#core/config/load.ts';
import { effectiveLimits } from '#engine/metrics/budget.ts';
import { budgetApproveBody, budgetRows, postJobBudget, unattendedDefault } from './budget.ts';

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

test("the budget gate's Approve body comes from the note", async () => {
  assert.deepEqual(budgetApproveBody(''), { ack: true });
  assert.deepEqual(budgetApproveBody('looks fine'), { ack: true });
  assert.deepEqual(budgetApproveBody('usd=20 tokens=2000000'), { set: ['usd=20', 'tokens=2000000'] });
  assert.deepEqual(budgetApproveBody('usd=5, usd=9 please'), { set: ['usd=9'] });
  assert.deepEqual(budgetApproveBody('foo=1'), { ack: true });

  const seen: { url: string; init: RequestInit }[] = [];
  const reply = (status: number, body: string) =>
    (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(body, { status });
    }) as unknown as typeof fetch;
  const ok = await postJobBudget('a b', { ack: true }, 'tok', reply(200, JSON.stringify({ id: 'a b', stillExceeded: [] })));
  assert.deepEqual(ok.stillExceeded, []);
  assert.equal(seen[0].url, '/api/jobs/a%20b/budget');
  assert.equal(seen[0].init.method, 'POST');
  assert.deepEqual(seen[0].init.headers, { 'content-type': 'application/json', 'x-forge-token': 'tok' });
  assert.equal(seen[0].init.body, '{"ack":true}');
  await assert.rejects(postJobBudget('j', { set: ['usd=-1'] }, 'tok', reply(400, JSON.stringify({ error: 'bad budget value in "usd=-1"' }))), /^Error: bad budget value in "usd=-1"$/);
});
