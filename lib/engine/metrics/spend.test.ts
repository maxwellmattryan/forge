// spendLedger reads each job's CLI copy of events.jsonl, never the job folder's mirror, and joins the supervisor's
// meter to the reported agent ends without counting a run twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { createJob, jobDir, logEvent } from '#core/job/store.ts';
import { EVENT_SCHEMA_VERSION } from '#core/job/schema.ts';
import { jobFiles } from '#core/paths.ts';
import { appendMeter } from './meter.ts';
import { repoBudgetStatus } from './repo-budget.ts';
import { SPEND_CACHE_VERSION, ledgerRows, periodTotals, sessionRows, spendCounters, spendLedger } from './spend.ts';
import { statsCsv } from './stats.ts';

/** $1 per input token, so a run's input is its cost. */
function usdConfig() {
  const config = defaults();
  config.usage.pricing = { models: { 'usd-model': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } } };
  return config;
}

test('repo spend reads the CLI copy', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  const config = usdConfig();
  const job = createJob(r.dir, config, { title: 'spender' });
  const run = (usd: number) => ({ role: 'builder', model: 'usd-model', usage: { input: usd, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: usd } });
  logEvent(r.dir, job.id, 'agent-end', run(3));
  fs.appendFileSync(path.join(jobDir(r.dir, job.id), 'events.jsonl'), `${JSON.stringify({ v: 2, ts: new Date().toISOString(), type: 'agent-end', ...run(500) })}\n`);
  const { buckets } = spendLedger(r.dir, config, { write: false })[job.id];
  assert.deepEqual(
    Object.values(buckets).reduce((n, b) => ({ runs: n.runs + b.runs, usd: n.usd + b.usd }), { runs: 0, usd: 0 }),
    { runs: 1, usd: 3 },
  );
});

const D = '2026-10-20';
const AT = Date.parse(`${D}T12:00:00.000Z`);

/** One agent-end on day D in both copies, as the CLI writes it, with `metered` when its session's meter holds it. */
function agentEnd(root: string, id: string, role: string, usd: number, metered: boolean): void {
  const e = { v: EVENT_SCHEMA_VERSION, ts: `${D}T09:00:00.000Z`, type: 'agent-end', role, model: 'usd-model', usage: { input: usd, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: usd }, ...(metered ? { metered: true } : {}) };
  for (const file of jobFiles(root, id, 'events.jsonl')) fs.appendFileSync(file, JSON.stringify(e) + '\n');
}

/** One meter record of `scope` on day D: `usd` for usd-model, as many input tokens. */
function meter(root: string, scope: string, usd: number, hour = '10'): void {
  const models = { 'usd-model': { usd, input: usd, output: 0, cacheRead: 0, cacheWrite: 0 } };
  appendMeter(root, { v: 1, ts: `${D}T${hour}:00:00.000Z`, scope, sessionId: null, spawnId: 's', turn: 1, usd, tokens: usd, models, cum: { usd, models } });
}

test('metered sessions join the ledger without double counting', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  const root = r.dir;
  const config = usdConfig();
  const id = createJob(root, config, { title: 'metered' }).id;
  agentEnd(root, id, 'builder', 3, true);
  agentEnd(root, id, 'planner', 2, false);
  meter(root, id, 7);
  meter(root, '_office', 5);
  meter(root, '_inbox', 1);
  // A legacy assistant session's meter keeps its past spend; the gate runs' is the same role.
  meter(root, '_assistant-1', 2);
  meter(root, '_gates', 4);
  meter(root, '_chat-0123456789ab', 3);

  const ledger = spendLedger(root, config, { write: false });
  assert.deepEqual(Object.keys(ledger[id].metered), [`${D}|orchestrator|usd-model`]);
  assert.equal(ledger[id].metered[`${D}|orchestrator|usd-model`].usd, 4, 'the meter less the covered builder run');
  assert.equal(ledger[id].metered[`${D}|orchestrator|usd-model`].tokens, 4);
  assert.deepEqual([ledger._office.kind, ledger._office.title, ledger._office.metered[`${D}|office|usd-model`].usd], ['session', 'Office session', 5]);
  assert.deepEqual([ledger._inbox.kind, ledger._inbox.title, ledger._inbox.metered[`${D}|inbox|usd-model`].usd], ['session', 'Inbox session', 1]);
  assert.deepEqual([ledger['_assistant-1'].kind, ledger['_assistant-1'].title, ledger['_assistant-1'].metered[`${D}|assistant|usd-model`].usd], ['session', 'Assistant foreman 1', 2]);
  assert.deepEqual([ledger._gates.kind, ledger._gates.title, ledger._gates.metered[`${D}|assistant|usd-model`].usd], ['session', 'Foreman gates', 4]);
  assert.deepEqual([ledger['_chat-0123456789ab'].kind, ledger['_chat-0123456789ab'].title, ledger['_chat-0123456789ab'].metered[`${D}|chat|usd-model`].usd], ['session', 'Chat 0123456789ab', 3]);
  assert.equal(periodTotals(ledger, AT).dayUsd, 24, '5 reported + 4 + 5 + 1 + 2 + 4 + 3');

  const byRole = ledgerRows(ledger, { by: 'role' });
  assert.ok(byRole.every((row) => row.key.length === 2 && ['reported', 'supervisor'].includes(row.key[1])), 'keyed by role and source');
  const csv = statsCsv(root, config, { csv: true, by: 'role' }).split('\r\n');
  assert.equal(csv[0], 'role,source,runs,tokens,input,output,cache_read,cache_write,usd');
  assert.ok(csv.includes('orchestrator,supervisor,1,4,4,0,0,0,4.0000'), csv.join('\n'));
  assert.ok(csv.includes('builder,reported,1,3,3,0,0,0,3.0000'), csv.join('\n'));

  const sessions = sessionRows(ledger);
  assert.deepEqual(Object.fromEntries(Object.entries(sessions).map(([k, v]) => [k, v.estCostUsd])), { orchestrator: 4, office: 5, inbox: 1, assistant: 6, chat: 3 });
  // A cached spend.json is a file: a role outside the sessions' is skipped, never used as a key.
  const cell = ledger._office.metered[`${D}|office|usd-model`];
  const forged = { x: { ...ledger._office, metered: { [`${D}|__proto__|m`]: cell, [`${D}|builder|m`]: cell } } };
  assert.deepEqual(sessionRows(forged), {});
  assert.equal(({} as Record<string, unknown>).tokens, undefined, 'Object.prototype is untouched');
  assert.equal(repoBudgetStatus(root, config, { at: AT, write: false }).spent.dayUsd, 24);

  assert.equal(SPEND_CACHE_VERSION, 2);
  spendLedger(root, config);
  const before = spendCounters.parsed;
  spendLedger(root, config);
  assert.equal(spendCounters.parsed, before, 'nothing changed, nothing re-parsed');
  meter(root, '_office', 1, '11');
  const after = spendLedger(root, config);
  assert.equal(spendCounters.parsed, before + 1, 'only the office entry');
  assert.equal(after._office.metered[`${D}|office|usd-model`].usd, 6);
});

test('covered usage above the metered figure leaves a $0 cell', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  const config = usdConfig();
  const id = createJob(r.dir, config, { title: 'over-covered' }).id;
  agentEnd(r.dir, id, 'builder', 9, true);
  meter(r.dir, id, 2);
  const cell = spendLedger(r.dir, config, { write: false })[id].metered[`${D}|orchestrator|usd-model`];
  assert.deepEqual([cell.usd, cell.tokens, cell.input, cell.runs], [0, 0, 0, 1]);
});
