import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetRows, budgetWorst, budgetChipModel, budgetCellModel, budgetPanelModel, unattendedDefault, BUDGET_KEYS } from '../dashboard/src/lib/budget.ts';
import { effectiveLimits } from '../lib/budget.ts';
import { defaults } from '../lib/core/config/load.ts';

const row = (rows, key) => rows.find((r) => r.key === key);
const job = (over = {}): any => ({ state: 'running', round: 1, usage: { totalTokens: 0, estCostUsd: 0, byRole: {} }, verifyRetries: {}, budget: { limits: {}, ack: {}, lastCheck: null }, ...over });

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

test('budgetRows applies the unattended default like effectiveLimits', () => {
  const on = { daemon: { enabled: true, jobBudget: { tokens: 600000000, usd: 150, minutes: null } } };
  const fill = unattendedDefault(on);
  const pipeline = defaults().pipeline.budget;
  const limitsOf = (rows) => Object.fromEntries(rows.map((r) => [r.key, r.limit]));
  for (const [label, j, cfg] of [
    ['no spend limit', job(), pipeline],
    ['a config spend limit', job(), { ...pipeline, minutes: 30 }],
    ['a job spend override', job({ budget: { limits: { usd: 9 }, ack: {}, lastCheck: null } }), pipeline],
    ['an explicit null override', job({ budget: { limits: { tokens: null }, ack: {}, lastCheck: null } }), pipeline],
  ] as const) {
    const config: any = { ...defaults(), daemon: { ...defaults().daemon, enabled: true }, pipeline: { ...defaults().pipeline, budget: cfg } };
    assert.deepEqual(limitsOf(budgetRows(j, cfg, fill)), effectiveLimits(config, j), label);
  }
  const rows = budgetRows(job(), pipeline, fill);
  assert.equal(row(rows, 'tokens').limit, 600000000);
  assert.equal(row(rows, 'usd').limit, 150);
  assert.equal(row(rows, 'minutes').limit, null);
  assert.equal(unattendedDefault({ daemon: { enabled: false, jobBudget: on.daemon.jobBudget } }), null, 'daemon off');
  assert.equal(unattendedDefault({ daemon: { enabled: true, jobBudget: null } }), null, 'turned off');
  assert.equal(unattendedDefault(undefined), null);
  assert.equal(row(budgetRows(job(), pipeline), 'usd').limit, null, 'no default passed: unchanged');
  const cell = budgetCellModel(job({ usage: { totalTokens: 0, estCostUsd: 140, byRole: {} } }), pipeline, fill);
  assert.equal(cell.kind === 'chip' && cell.chip.text, 'budget 93%');
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

test('budgetRows and the view models tolerate old and partial jobs', () => {
  for (const j of [{}, { state: 'running' }, { budget: null, usage: null }, { usage: { byRole: {} } }, null, undefined] as any) {
    for (const cfg of [undefined, null, {}, { tokens: 10 }]) {
      const rows = budgetRows(j, cfg);
      assert.equal(rows.length, 5);
      const panel = budgetPanelModel(j, cfg);
      assert.equal(panel.rows.length, 5);
      assert.equal(typeof panel.checked, 'string');
      assert.deepEqual(budgetPanelModel(j, cfg, { compact: true }).checked, null);
      const chip = budgetChipModel(j, cfg);
      assert.ok(chip === null || typeof chip.text === 'string');
      assert.ok(['chip', 'text', 'none'].includes(budgetCellModel(j, cfg).kind));
    }
  }
  assert.equal(budgetWorst(budgetRows({} as any, undefined)), null);
  assert.deepEqual(budgetCellModel({} as any, undefined), { kind: 'none' });
});

test('budgetPanel model: one row per key, the checked line, raw text', () => {
  const plain = budgetPanelModel(job(), { tokens: 1000 });
  assert.equal(plain.checked, 'not checked yet');
  assert.deepEqual(plain.rows.map((r) => r.key), [...BUDGET_KEYS]);
  assert.deepEqual(plain.rows.map((r) => r.label), ['Tokens', 'Est. cost', 'Agent minutes', 'Changed lines', 'Verify retries (round 1)']);
  for (const r of plain.rows) assert.deepEqual(Object.keys(r).sort(), ['bad', 'bar', 'key', 'label', 'note', 'value']);
  assert.equal(budgetPanelModel(job(), {}, { compact: true }).checked, null, 'compact has no header');
  const at = new Date(Date.now() - 3 * 60000).toISOString();
  assert.equal(budgetPanelModel(job({ budget: { limits: {}, ack: {}, lastCheck: { at, checkpoint: 'build', used: {} } } }), {}).checked, 'checked 3m ago · build');
  const evil = job({
    budget: {
      limits: { tokens: '<script>' },
      ack: { usd: { used: '<script>' } },
      lastCheck: { at: '<img src=x onerror=alert(1)>', checkpoint: '<img src=x onerror=alert(1)>', used: { changedLines: '<script>' } },
    },
  });
  const m = budgetPanelModel(evil, { usd: '<b>' } as any);
  assert.equal(m.checked, 'checked — · <img src=x onerror=alert(1)>', 'raw text, never HTML: Svelte escapes it');
  assert.ok(m.rows.every((r) => !r.label.includes('&')));
  const tokens = m.rows.find((r) => r.key === 'tokens')!;
  assert.deepEqual([tokens.note, tokens.bar], ['· unlimited', null], 'a non-numeric limit reads as unlimited');
  assert.equal(m.rows.find((r) => r.key === 'usd')!.note, '· unlimited', 'a non-numeric config limit too');
  assert.equal(row(budgetRows(evil, {}), 'tokens').limit, null, 'non-numeric limit is treated as unlimited');
});

test('budgetPanel model: counted / limit, the ack and the bar tone', () => {
  const j = job({ usage: { totalTokens: 900, estCostUsd: 0, byRole: {} }, budget: { limits: {}, ack: { tokens: { used: 100, round: 1 } }, lastCheck: null } });
  const tokens = budgetPanelModel(j, { tokens: 1000 }).rows[0];
  assert.deepEqual(tokens, { key: 'tokens', label: 'Tokens', value: `${(800).toLocaleString()} / ${(1000).toLocaleString()}`, note: `· ${(100).toLocaleString()} acknowledged`, bad: false, bar: { tone: 'warn', width: 80 } });
  const over = budgetPanelModel(job({ usage: { totalTokens: 1500, estCostUsd: 0, byRole: {} } }), { tokens: 1000 }).rows[0];
  assert.deepEqual([over.bad, over.bar], [true, { tone: 'bad', width: 100 }], 'the width is clamped to 100');
  const ok = budgetPanelModel(job(), { tokens: 1000 }).rows[0];
  assert.deepEqual([ok.note, ok.bad, ok.bar], [null, false, { tone: 'ok', width: 0 }]);
  const unlimited = budgetPanelModel(job(), {}).rows[1];
  assert.deepEqual([unlimited.value, unlimited.note, unlimited.bar], ['$0.000', '· unlimited', null]);
  const unmeasured = budgetPanelModel(job(), { changedLines: 10 }).rows[3];
  assert.deepEqual([unmeasured.value, unmeasured.note, unmeasured.bar], ['— / 10', 'not measured yet', null]);
});

test('budgetChip: warn and bad only, never for done, cancelled or waiting:budget jobs', () => {
  const at = (used, extra = {}) => job({ usage: { totalTokens: used, estCostUsd: 0, byRole: {} }, ...extra });
  assert.equal(budgetChipModel(at(790), { tokens: 1000 }), null);
  assert.deepEqual(budgetChipModel(at(850), { tokens: 1000 }), { tone: 'warn', text: 'budget 85%', title: `Tokens 850/${(1000).toLocaleString()}` });
  assert.deepEqual(budgetChipModel(at(1500), { tokens: 1000 }), { tone: 'bad', text: 'over budget', title: `Tokens ${(1500).toLocaleString()}/${(1000).toLocaleString()}` });
  assert.equal(budgetChipModel(at(1500, { state: 'done' }), { tokens: 1000 }), null);
  assert.equal(budgetChipModel(at(1500, { state: 'cancelled' }), { tokens: 1000 }), null);
  assert.equal(budgetChipModel(at(1500, { state: 'waiting', waitingOn: 'budget' }), { tokens: 1000 }), null);
  assert.equal(budgetChipModel(at(1500, { state: 'waiting', waitingOn: 'input' }), { tokens: 1000 })?.text, 'over budget');
  assert.deepEqual(budgetCellModel(at(850), { tokens: 1000 }), { kind: 'chip', chip: budgetChipModel(at(850), { tokens: 1000 }) });
  assert.deepEqual(budgetCellModel(at(500), { tokens: 1000 }), { kind: 'text', text: '50%' });
  assert.deepEqual(budgetCellModel(at(1500, { state: 'waiting', waitingOn: 'budget' }), { tokens: 1000 }), { kind: 'text', text: '150%' });
  assert.deepEqual(budgetCellModel(at(1, { state: 'waiting', waitingOn: 'budget' }), { tokens: 0 }), { kind: 'text', text: 'over' }, 'a zero limit that was exceeded');
});
