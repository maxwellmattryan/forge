// The dashboard's budget model against the engine's rule (budgetRows' limits are effectiveLimits'), and
// the budget gate's Approve: the body its note gives, the POST it sends, and whether it goes on to queue approve.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '#core/config/load.ts';
import { effectiveLimits } from '#engine/metrics/budget.ts';
import { budgetApprove, budgetApproveBody, budgetRows, postJobBudget, unattendedDefault } from './budget.ts';
import { setProject } from './project.ts';

// The budget route is a project route: every POST here goes to /api/p/web/….
setProject('web');

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

test('budget rows show the metered spend the last check saw', () => {
  const lastCheck = { at: '2026-10-24T00:00:00.000Z', checkpoint: 'session-meter', used: { usd: 13, tokens: 50 } };
  const j = { id: 'j-1', round: 1, budget: { limits: { usd: 10 }, ack: {}, lastCheck }, usage: { estCostUsd: 4, totalTokens: 900 } } as never;
  const rows = Object.fromEntries(budgetRows(j, {} as never).map((r) => [r.key, r]));
  assert.deepEqual([rows.usd.used, rows.usd.tone], [13, 'bad'], 'the metered usd is larger');
  assert.equal(rows.tokens.used, 900, 'the reported tokens are larger');
  const unchecked = { id: 'j-2', round: 1, budget: { limits: { usd: 10 }, ack: {}, lastCheck: null }, usage: { estCostUsd: 4 } } as never;
  assert.equal(budgetRows(unchecked, {} as never).find((r) => r.key === 'usd')?.used, 4, 'no check: the reported total');
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
  assert.equal(seen[0].url, '/api/p/web/jobs/a%20b/budget');
  assert.equal(seen[0].init.method, 'POST');
  assert.deepEqual(seen[0].init.headers, { 'content-type': 'application/json', 'x-forge-token': 'tok' });
  assert.equal(seen[0].init.body, '{"ack":true}');
  await assert.rejects(postJobBudget('j', { set: ['usd=-1'] }, 'tok', reply(400, JSON.stringify({ error: 'bad budget value in "usd=-1"' }))), /^Error: bad budget value in "usd=-1"$/);
});

test("the budget gate's Approve queues approve only once the budget route clears the job", async () => {
  const msg = { stillOver: (keys: string) => `still over: ${keys}`, failed: (error: string) => `failed: ${error}` };
  const bad = 'bad budget value in "usd=-1" (a limit is a number >= 0)';
  const rows: [string, string, number, unknown, string, unknown][] = [
    ['a raise that clears it', 'usd=20', 200, { stillExceeded: [] }, '{"set":["usd=20"]}', { proceed: true }],
    ['a bad value', 'usd=-1', 400, { error: bad }, '{"set":["usd=-1"]}', { toast: `failed: ${bad}` }],
    ['an empty note acknowledges', '', 200, { stillExceeded: [] }, '{"ack":true}', { proceed: true }],
    ['a raise that leaves keys over', 'usd=20', 200, { stillExceeded: ['tokens', 'minutes'] }, '{"set":["usd=20"]}', { toast: 'still over: tokens, minutes' }],
  ];
  for (const [name, note, status, reply, sent, want] of rows) {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(init.body);
      return new Response(JSON.stringify(reply), { status });
    }) as unknown as typeof fetch;
    assert.deepEqual(await budgetApprove('j-1', note, 'tok', msg, fetchImpl), want, name);
    assert.deepEqual(bodies, [sent], `${name}: one POST`);
  }
  const offline = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  assert.deepEqual(await budgetApprove('j-1', 'usd=20', 'tok', msg, offline), { toast: 'failed: fetch failed' }, 'a network error');
});
