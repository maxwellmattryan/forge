import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetRows, budgetWorst, budgetChip, budgetCell, budgetPanel, BUDGET_KEYS } from '../dashboard/budget.js';

const row = (rows, key) => rows.find((r) => r.key === key);
const job = (over = {}) => ({ state: 'running', round: 1, usage: { totalTokens: 0, estCostUsd: 0, byRole: {} }, verifyRetries: {}, budget: { limits: {}, ack: {}, lastCheck: null }, ...over });

test('budgetRows: five rows in key order with the documented shape', () => {
  const rows = budgetRows(job(), {});
  assert.deepEqual(rows.map((r) => r.key), [...BUDGET_KEYS]);
  for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ['ackBase', 'counted', 'fraction', 'key', 'label', 'limit', 'tone', 'used']);
});

test('budgetRows: limits come from the job override, then config, then null', () => {
  const j = job({ budget: { limits: { tokens: 500, usd: null }, ack: {}, lastCheck: null } });
  const rows = budgetRows(j, { tokens: 1000, usd: 5, minutes: 30 });
  assert.equal(row(rows, 'tokens').limit, 500, 'override beats config');
  assert.equal(row(rows, 'usd').limit, null, 'explicit null override means unlimited');
  assert.equal(row(rows, 'usd').tone, null);
  assert.equal(row(rows, 'minutes').limit, 30);
  assert.equal(row(rows, 'changedLines').limit, null);
  for (const r of budgetRows(j, undefined)) if (r.key !== 'tokens' && r.key !== 'usd') assert.equal(r.limit, null, 'missing config means null');
});

test('budgetRows: used values come from live job fields', () => {
  const j = job({
    round: 2,
    usage: { totalTokens: 900, estCostUsd: 1.5, byRole: { builder: { durationMs: 60000 }, reviewer: { durationMs: 120000 } }, byModel: { m: { durationMs: 180000 } } },
    verifyRetries: { 1: 4, 2: 1 },
    budget: { limits: {}, ack: {}, lastCheck: { at: new Date().toISOString(), checkpoint: 'build', used: { changedLines: 42 } } },
  });
  const rows = budgetRows(j, {});
  assert.equal(row(rows, 'tokens').used, 900);
  assert.equal(row(rows, 'usd').used, 1.5);
  assert.equal(row(rows, 'minutes').used, 3, 'byRole only; byModel ignored');
  assert.equal(row(rows, 'verifyRetries').used, 1, 'current round');
  assert.equal(row(rows, 'verifyRetries').label, 'Verify retries (round 2)');
  assert.equal(row(rows, 'changedLines').used, 42);
  assert.equal(row(budgetRows(job(), { changedLines: 100 }), 'changedLines').used, null, 'unmeasured without lastCheck');
  assert.equal(row(budgetRows(job(), { changedLines: 100 }), 'changedLines').tone, null);
});

test('budgetRows: acks reduce counted; a verifyRetries ack from another round is ignored', () => {
  const j = job({
    round: 2,
    usage: { totalTokens: 1500, estCostUsd: 0, byRole: {} },
    verifyRetries: { 2: 3 },
    budget: { limits: {}, ack: { tokens: { used: 1200, round: 1 }, verifyRetries: { used: 3, round: 1 } }, lastCheck: null },
  });
  const rows = budgetRows(j, { tokens: 1000, verifyRetries: 2 });
  const t = row(rows, 'tokens');
  assert.equal(t.ackBase, 1200);
  assert.equal(t.counted, 300);
  assert.equal(t.tone, 'ok');
  const v = row(rows, 'verifyRetries');
  assert.equal(v.ackBase, 0);
  assert.equal(v.counted, 3);
  assert.equal(v.tone, 'bad');
  const same = budgetRows({ ...j, budget: { ...j.budget, ack: { verifyRetries: { used: 3, round: 2 } } } }, { verifyRetries: 2 });
  assert.equal(row(same, 'verifyRetries').counted, 0);
});

test('budgetRows: tone thresholds and a zero limit', () => {
  const tone = (used, limit) => row(budgetRows(job({ usage: { totalTokens: used, estCostUsd: 0, byRole: {} } }), { tokens: limit }), 'tokens');
  assert.equal(tone(0, 0).tone, 'ok');
  assert.equal(tone(0, 0).fraction, 0);
  assert.equal(tone(1, 0).fraction, Infinity);
  assert.equal(tone(1, 0).tone, 'bad');
  assert.equal(tone(79, 100).tone, 'ok');
  assert.equal(tone(80, 100).tone, 'warn');
  assert.equal(tone(100, 100).tone, 'warn');
  assert.equal(tone(101, 100).tone, 'bad');
});

test('budgetRows and the HTML helpers tolerate old and partial jobs', () => {
  for (const j of [{}, { state: 'running' }, { budget: null, usage: null }, { usage: { byRole: {} } }, null, undefined]) {
    for (const cfg of [undefined, null, {}, { tokens: 10 }]) {
      const rows = budgetRows(j, cfg);
      assert.equal(rows.length, 5);
      assert.equal(typeof budgetPanel(j, cfg), 'string');
      assert.equal(typeof budgetPanel(j, cfg, { compact: true }), 'string');
      assert.equal(typeof budgetChip(j, cfg), 'string');
      assert.equal(typeof budgetCell(j, cfg), 'string');
    }
  }
  assert.equal(budgetWorst(budgetRows({}, undefined)), null);
  assert.equal(budgetCell({}, undefined), '—');
});

test('budgetPanel: one row per key, header, and everything escaped', () => {
  const plain = budgetPanel(job(), { tokens: 1000 });
  assert.match(plain, /not checked yet/);
  for (const label of ['Tokens', 'Est. cost', 'Agent minutes', 'Changed lines', 'Verify retries (round 1)']) assert.ok(plain.includes(label), label);
  assert.equal(budgetPanel(job(), {}, { compact: true }).includes('not checked yet'), false);
  const evil = job({
    budget: {
      limits: { tokens: '<script>' },
      ack: { usd: { used: '<script>' } },
      lastCheck: { at: '<img src=x onerror=alert(1)>', checkpoint: '<img src=x onerror=alert(1)>', used: { changedLines: '<script>' } },
    },
  });
  const html = budgetPanel(evil, { usd: '<b>' });
  assert.equal(html.includes('<img'), false);
  assert.equal(html.includes('<script'), false);
  assert.ok(html.includes('&lt;img'));
  assert.equal(row(budgetRows(evil, {}), 'tokens').limit, null, 'non-numeric limit is treated as unlimited');
});

test('budgetPanel: shows counted / limit, the ack and the bar tone', () => {
  const j = job({ usage: { totalTokens: 900, estCostUsd: 0, byRole: {} }, budget: { limits: {}, ack: { tokens: { used: 100, round: 1 } }, lastCheck: null } });
  const html = budgetPanel(j, { tokens: 1000 });
  assert.ok(html.includes(`${(800).toLocaleString()} / ${(1000).toLocaleString()}`));
  assert.ok(html.includes('acknowledged'));
  assert.ok(html.includes('bg-warn') && html.includes('width:80%'));
  assert.ok(budgetPanel(job(), {}).includes('unlimited'));
  assert.ok(budgetPanel(job(), { changedLines: 10 }).includes('not measured yet'));
});

test('budgetChip: warn and bad only, never for done, cancelled or waiting:budget jobs', () => {
  const at = (used, extra = {}) => job({ usage: { totalTokens: used, estCostUsd: 0, byRole: {} }, ...extra });
  assert.equal(budgetChip(at(790), { tokens: 1000 }), '');
  assert.match(budgetChip(at(850), { tokens: 1000 }), />budget 85%</);
  assert.match(budgetChip(at(850), { tokens: 1000 }), /title="Tokens 850\/1,?000"/);
  assert.match(budgetChip(at(1500), { tokens: 1000 }), />over budget</);
  assert.equal(budgetChip(at(1500, { state: 'done' }), { tokens: 1000 }), '');
  assert.equal(budgetChip(at(1500, { state: 'cancelled' }), { tokens: 1000 }), '');
  assert.equal(budgetChip(at(1500, { state: 'waiting', waitingOn: 'budget' }), { tokens: 1000 }), '');
  assert.ok(budgetChip(at(1500, { state: 'waiting', waitingOn: 'input' }), { tokens: 1000 }).includes('over budget'));
  assert.match(budgetCell(at(500), { tokens: 1000 }), />50%</);
  assert.match(budgetCell(at(1500, { state: 'waiting', waitingOn: 'budget' }), { tokens: 1000 }), />150%</);
});
