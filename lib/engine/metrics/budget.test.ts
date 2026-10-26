// budgetCmd in-process: --set and --ack change a job's spend limits only with a person's grant, and
// their events say who; a plain read needs none. effectiveLimits' per-key unattended backstop and
// remainingUsd, the dollar cap a spawn passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { jobAt, tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { ForgeError } from '#core/errors.ts';
import { createJob, loadJob, logEvent, readEvents, updateJob } from '#core/job/store.ts';
import { EVENT_SCHEMA_VERSION } from '#core/job/schema.ts';
import { jobDir, stateFile } from '#core/paths.ts';
import type { BudgetLimits, Config, DaemonJobBudget, HumanGrant, Job, JobBudget } from '#core/types.ts';
import { budgetCmd, effectiveLimits, enforceBudget, remainingUsd } from './budget.ts';
import { appendMeter } from './meter.ts';
import { jobSpend, spentFrom } from './spend.ts';

const config = defaults();
config.pipeline.budget = { ...config.pipeline.budget, usd: 10 };
const GRANT: HumanGrant = { channel: 'terminal', actor: { login: 'alice', source: 'env' } };

test("budgetCmd changes limits and acks only with a person's grant", () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const id = createJob(root, config, { title: 'over budget' }).id;
    updateJob(root, id, (j) => {
      j.usage = { ...j.usage, estCostUsd: 12 };
    });
    const files = () => ['job.json', 'events.jsonl'].map((f) => fs.readFileSync(path.join(jobDir(root, id), f), 'utf8'));
    const refused: [string, Parameters<typeof budgetCmd>[3]][] = [
      ['--set without a grant', { set: ['usd=1000000'] }],
      ['--ack without a grant', { ack: true }],
      ['--set with a stray true', { set: ['usd=1000000'], grant: true as never }],
      ['--ack with a grant of an unknown channel', { ack: true, grant: { channel: 'env', actor: GRANT.actor } as never }],
      ['--ack with a grant whose actor has no source', { ack: true, grant: { channel: 'terminal', actor: { login: 'x' } } as never }],
    ];
    for (const [name, opts] of refused) {
      const before = files();
      assert.throws(() => budgetCmd(root, config, id, opts), (e: unknown) => e instanceof ForgeError && e.code === 'human_only' && e.exitCode === 1, name);
      assert.deepEqual(files(), before, `${name}: job.json and events.jsonl unchanged`);
    }

    const read = budgetCmd(root, config, id);
    assert.deepEqual([read.exceeded, read.acked], [['usd'], []]);

    const acked = budgetCmd(root, config, id, { ack: true, grant: GRANT });
    assert.deepEqual([acked.acked, acked.stillExceeded], [['usd'], []]);
    const set = budgetCmd(root, config, id, { set: ['usd=20'], grant: { channel: 'dashboard', actor: { login: 'bob', source: 'dashboard' } } });
    assert.equal(set.limits.usd, 20);
    const events = readEvents(root, id);
    assert.deepEqual(events.find((e) => e.type === 'budget-ack')?.actor, GRANT.actor);
    assert.deepEqual(events.find((e) => e.type === 'budget-set')?.actor, { login: 'bob', source: 'dashboard' });
  } finally {
    repo.cleanup();
  }
});

/** A config with the daemon on (or off) and the given pipeline.budget and daemon.jobBudget. */
function daemonConfig(budget: Partial<BudgetLimits>, jobBudget: DaemonJobBudget = { tokens: 600000000, usd: 150 }, enabled = true): Config {
  const c = defaults();
  c.pipeline.budget = { ...c.pipeline.budget, tokens: null, usd: null, minutes: null, ...budget };
  c.daemon = { ...c.daemon, enabled, jobBudget };
  return c;
}

const job = (limits: BudgetLimits = {}, usage: Partial<Job['usage']> = {}, ack: JobBudget['ack'] = {}) =>
  ({ budget: { limits, ack, lastCheck: null }, usage }) as unknown as Job;

test('the unattended job budget fills each unset spend key', () => {
  const spend = (c: Config, j: Job) => {
    const l = effectiveLimits(c, j);
    return { tokens: l.tokens, usd: l.usd, minutes: l.minutes };
  };
  const rows: [string, Config, Job, Record<string, number | null>][] = [
    ['nothing set', daemonConfig({}), job(), { tokens: 6e8, usd: 150, minutes: null }],
    ['config usd 50', daemonConfig({ usd: 50 }), job(), { tokens: 6e8, usd: 50, minutes: null }],
    ['config minutes 30', daemonConfig({ minutes: 30 }), job(), { tokens: 6e8, usd: 150, minutes: 30 }],
    ['job override tokens 5', daemonConfig({}), job({ tokens: 5 }), { tokens: 5, usd: 150, minutes: null }],
    ['job override usd null', daemonConfig({}), job({ usd: null }), { tokens: 6e8, usd: null, minutes: null }],
    ['daemon off', daemonConfig({}, undefined, false), job(), { tokens: null, usd: null, minutes: null }],
    ['jobBudget null', daemonConfig({}, null), job(), { tokens: null, usd: null, minutes: null }],
  ];
  for (const [name, c, j, want] of rows) assert.deepEqual(spend(c, j), want, name);
});

/** $1 per input token, so a run's input is its cost and its tokens. */
function usdConfig(): Config {
  const c = defaults();
  c.pipeline.budget = { ...c.pipeline.budget, usd: 10 };
  c.usage.pricing = { models: { 'usd-model': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } } };
  return c;
}

/** A running job that reported `reported` dollars, of which `covered` ended inside its own session, with `meter` dollars metered (null: no meter file). */
function spender(root: string, c: Config, reported: number, covered: number, meter: number | null, legacy = false): string {
  const id = jobAt(root, 'build', { title: `spent ${reported}/${covered}/${meter}`, config: c }).id;
  updateJob(root, id, (j) => void (j.usage = { ...j.usage, estCostUsd: reported, totalTokens: reported }));
  const run = (usd: number, metered: boolean) => ({ role: 'builder', model: 'usd-model', usage: { input: usd, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: usd }, ...(metered && !legacy ? { metered: true } : {}) });
  if (covered) logEvent(root, id, 'agent-end', run(covered, true));
  if (reported - covered) logEvent(root, id, 'agent-end', run(reported - covered, false));
  if (meter !== null) {
    const models = { 'usd-model': { usd: meter, input: meter, output: 0, cacheRead: 0, cacheWrite: 0 } };
    appendMeter(root, { v: 1, ts: new Date().toISOString(), scope: id, sessionId: null, spawnId: 's', turn: 1, usd: meter, tokens: meter, models, cum: { usd: meter, models } });
  }
  return id;
}

test('enforcement prefers the metered figure', (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  const root = repo.dir;
  const c = usdConfig();
  const rows: [string, number, number, number | null, number, boolean?][] = [
    ['no meter: the reported total', 4, 0, null, 4],
    ['meter $10, reported $4 all covered', 4, 4, 10, 10],
    ['meter $10, reported $4 of which $1 covered', 4, 1, 10, 13],
    ['meter $3, reported $8 all covered', 8, 8, 3, 8],
    ['an agent end from before the step counts as uncovered', 4, 4, 10, 14, true],
  ];
  for (const [name, reported, covered, meter, want, legacy] of rows) {
    const id = spender(root, c, reported, covered, meter, legacy);
    assert.deepEqual(spentFrom(jobSpend(root, c, loadJob(root, id))), { usd: want, tokens: want }, `${name}: usd and tokens follow one rule`);
  }

  const id = spender(root, c, 4, 1, 13);
  const before = loadJob(root, id);
  assert.ok((before.usage.estCostUsd ?? 0) < 10, 'the reported total is under the limit');
  const r = enforceBudget(root, c, id, 'agent-end');
  assert.equal(r?.stopped, true);
  const parked = loadJob(root, id);
  assert.deepEqual([parked.state, parked.waitingOn, parked.budget.lastCheck?.used.usd], ['waiting', 'budget', 16]);
  assert.equal(remainingUsd(c, parked, spentFrom(jobSpend(root, c, parked)).usd), -6);
  assert.deepEqual(budgetCmd(root, c, id).exceeded, ['usd'], 'budgetCmd reads the same figure');
});

test('an edited events.jsonl never lowers the enforced spend', (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  const root = repo.dir;
  const c = usdConfig();
  const id = spender(root, c, 4, 0, 10);
  const spent = () => spentFrom(jobSpend(root, c, loadJob(root, id)));
  const exceeded = () => enforceBudget(root, c, id, 'agent-end')?.exceeded.map((e) => [e.key, e.used]);
  const want = spent();
  assert.equal(want.usd, 14);
  const wantExceeded = exceeded();
  const forged = JSON.stringify({ v: EVENT_SCHEMA_VERSION, ts: new Date().toISOString(), type: 'agent-end', role: 'builder', model: 'usd-model', metered: true, usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1000 } }) + '\n';
  // The job folder's copy is a mirror Forge never reads.
  fs.appendFileSync(path.join(jobDir(root, id), 'events.jsonl'), forged);
  assert.deepEqual(spent(), want, 'the mirror');
  assert.deepEqual(exceeded(), wantExceeded, 'the mirror: enforcement unchanged');
  // The CLI copy can claim covered runs, but never below the meter or the reported total.
  fs.appendFileSync(stateFile(root, id, 'events.jsonl'), forged);
  assert.ok(spent().usd >= 10 && spent().usd >= 4, `the CLI copy: ${spent().usd}`);
});

test('remainingUsd is the dollar limit past the acknowledged point', () => {
  const c = daemonConfig({ usd: 150 });
  assert.equal(remainingUsd(daemonConfig({}), job({ usd: null })), null);
  assert.equal(remainingUsd(daemonConfig({}, null), job()), null);
  assert.equal(remainingUsd(c, job({}, { estCostUsd: 40 })), 110);
  assert.equal(remainingUsd(c, job({}, { estCostUsd: 190 }, { usd: { used: 40, round: 1 } })), 0);
  assert.equal(remainingUsd(c, job({}, { estCostUsd: 200 })), -50);
});
