import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forgeAsync, tempRepo } from './helpers.ts';
import { TRUST_ENV, defaults, loadConfig, trustDigest, validateConfig } from '../lib/config.ts';
import { CONFIG_DISCLOSURE, FIELDS } from '../lib/config-fields.ts';
import { CONFIG_SCHEMA_VERSION, migrateConfig } from '../lib/schema.ts';
import * as yaml from '../lib/yaml.ts';
import { budgetRepo, spend } from './repo-budget-fixture.ts';
import { budgetCmd } from '../lib/budget.ts';
import { jobCmd } from '../lib/commands/job.ts';
import { nextCmd } from '../lib/commands/tracker.ts';
import { claimJob, createJob, loadJob, parseEventLines, readEvents, recordAgent, repoAuditFile, setJob, updateJob } from '../lib/jobs.ts';
import { transitionEvents } from '../lib/notify.ts';
import { parkForRepoBudget, releaseRepoHolds, repoBudgetStatus } from '../lib/repo-budget.ts';
import { listRequests } from '../lib/requests.ts';
import type { Config } from '../lib/types.ts';

const problems = (budget: unknown) => {
  const c: any = defaults();
  c.budget = budget;
  return validateConfig(c, process.cwd()).filter((p) => p.startsWith('budget'));
};

test('config defaults and validation', () => {
  assert.deepEqual(defaults().budget, { usdPerDay: null, usdPerMonth: null, tokensPerMonth: null, onExceeded: 'hold' });
  assert.deepEqual(problems(defaults().budget), []);
  assert.deepEqual(problems({ usdPerDay: 0, usdPerMonth: 12.5, tokensPerMonth: 1000, onExceeded: 'warn' }), []);
  assert.equal(problems({ ...defaults().budget, usdPerDay: -1 }).length, 1, 'a negative USD cap');
  assert.equal(problems({ ...defaults().budget, usdPerMonth: 'lots' }).length, 1, 'a non-numeric USD cap');
  assert.equal(problems({ ...defaults().budget, tokensPerMonth: 1.5 }).length, 1, 'a non-integer token cap');
  assert.equal(problems({ ...defaults().budget, onExceeded: 'stop' }).length, 1, 'onExceeded outside hold|warn');
  assert.deepEqual(problems([1]), ['budget must be a map (got [1])']);
  assert.deepEqual(problems(null), ['budget must be a map (got null)']);
});

test('config v8 migrates to v9 unchanged', () => {
  assert.equal(CONFIG_SCHEMA_VERSION, 14);
  const v8 = { schemaVersion: 8, git: { base: 'trunk' }, notify: { webhooks: [], command: null } };
  const { config, from } = migrateConfig(structuredClone(v8));
  assert.equal(from, 8);
  assert.deepEqual(config, { ...v8, schemaVersion: 14, repos: [] }, 'only schemaVersion and the empty repos list change');
  const repo = tempRepo();
  try {
    fs.mkdirSync(path.join(repo.dir, '.forge'), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), yaml.stringify(v8));
    const loaded = loadConfig(repo.dir);
    assert.equal(loaded.config.schemaVersion, 14);
    assert.deepEqual(loaded.config.budget, defaults().budget, 'a v8 config loads with the budget defaults');
  } finally {
    repo.cleanup();
  }
});

describe('budget keys are settable', { concurrency: 4 }, () => {
  test('fields and disclosure', () => {
    const keys = ['budget.usdPerDay', 'budget.usdPerMonth', 'budget.tokensPerMonth', 'budget.onExceeded'];
    for (const k of keys) {
      const f = FIELDS.find((x) => x.key === k);
      assert.ok(f, `${k} is a field`);
      assert.equal(f.editable, true, `${k} is editable`);
    }
    assert.equal(FIELDS.find((x) => x.key === 'budget.onExceeded')!.type, 'enum');
    assert.deepEqual(FIELDS.find((x) => x.key === 'budget.onExceeded')!.options, ['hold', 'warn']);
    assert.equal(FIELDS.find((x) => x.key === 'budget.tokensPerMonth')!.type, 'integer');
    assert.equal(CONFIG_DISCLOSURE.budget, 'plain');
  });

  test('forge config set writes and refuses', async () => {
    const repo = tempRepo();
    try {
      fs.mkdirSync(path.join(repo.dir, '.forge'), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), 'schemaVersion: 10\n');
      const ok = await forgeAsync(repo.dir, ['config', 'set', 'budget.usdPerMonth', '50']);
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(loadConfig(repo.dir).config.budget.usdPerMonth, 50);
      const bad = await forgeAsync(repo.dir, ['config', 'set', 'budget.usdPerMonth', '-1']);
      assert.equal(bad.status, 1);
      assert.equal(loadConfig(repo.dir).config.budget.usdPerMonth, 50, 'a refused value writes nothing');
      const mode = await forgeAsync(repo.dir, ['config', 'set', 'budget.onExceeded', 'warn']);
      assert.equal(mode.status, 0, mode.stderr);
      assert.equal((await forgeAsync(repo.dir, ['config', 'set', 'budget.onExceeded', 'stop'])).status, 1);
    } finally {
      repo.cleanup();
    }
  });
});

// ---------- status, enforcement and release ----------

const at = (iso: string) => Date.parse(iso);
const month = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);
const events = (root: string, id: string, type: string) => readEvents(root, id).filter((e) => e.type === type);
const audit = (root: string) => parseEventLines(fs.existsSync(repoAuditFile(root)) ? fs.readFileSync(repoAuditFile(root), 'utf8') : '');
const json = (r: { stdout: string }) => JSON.parse(r.stdout);
/** A job parked on its own per-job budget: verifyRetries over the default 2. */
const perJobOver = (root: string, config: Config, title: string) => {
  const j = createJob(root, config, { title });
  updateJob(root, j.id, (x) => (x.verifyRetries = { 0: 3 }));
  return j.id;
};

describe('repo budget', { concurrency: 4 }, () => {
  test('status shape, projection and reasons', async () => {
    const s = budgetRepo({ usdPerMonth: 100, tokensPerMonth: 5, usdPerDay: 5 });
    try {
      spend(s.root, s.spender, 10, '2026-10-05T09:00:00.000Z');
      spend(s.root, s.spender, 99, '2026-09-30T23:00:00.000Z');
      const st = repoBudgetStatus(s.root, s.config, { at: at('2026-10-05T12:00:00Z') });
      assert.deepEqual(Object.keys(st).sort(), ['acks', 'caps', 'configured', 'day', 'exceeded', 'heldJobs', 'held', 'month', 'onExceeded', 'projectedMonthUsd', 'reason', 'remaining', 'spent'].sort());
      assert.equal(st.day, '2026-10-05');
      assert.equal(st.month, '2026-10');
      assert.deepEqual(st.spent, { dayUsd: 10, monthUsd: 10, monthTokens: 10 });
      assert.deepEqual(st.caps, { usdPerMonth: 100, tokensPerMonth: 5, usdPerDay: 5 });
      assert.deepEqual(st.remaining, { usdPerMonth: 90, tokensPerMonth: 0, usdPerDay: 0 });
      assert.deepEqual(st.acks, { day: 0, month: 0 });
      assert.equal(st.projectedMonthUsd, 62, '$10 on day 5 of a 31-day month projects $62');
      assert.deepEqual(st.exceeded, ['tokensPerMonth', 'usdPerDay']);
      assert.equal(st.held, true);
      assert.equal(st.reason, 'repo budget: 10 of 5 tokens this month, $10.00 of $5.00 today');
      s.config.budget.usdPerMonth = 10;
      assert.equal(repoBudgetStatus(s.root, s.config, { at: at('2026-10-05T12:00:00Z') }).reason, 'repo budget: $10.00 of $10.00 this month, 10 of 5 tokens this month, $10.00 of $5.00 today', 'reaching a cap holds, and keys list in order');
      s.config.budget.onExceeded = 'warn';
      const warn = repoBudgetStatus(s.root, s.config, { at: at('2026-10-05T12:00:00Z') });
      assert.equal(warn.held, false);
      assert.ok(warn.reason, 'the reason is kept under warn');
      const none = repoBudgetStatus(s.root, { ...s.config, budget: defaults().budget }, { at: at('2026-11-02T00:00:00Z') });
      assert.deepEqual({ spent: none.spent, exceeded: none.exceeded, projected: none.projectedMonthUsd, remaining: none.remaining, reason: none.reason }, { spent: { dayUsd: 0, monthUsd: 0, monthTokens: 0 }, exceeded: [], projected: 0, remaining: { usdPerMonth: null, tokensPerMonth: null, usdPerDay: null }, reason: null });

      // `forge budget` prints the same shape for now.
      spend(s.root, s.spender, 3);
      const cli = await forgeAsync(s.root, ['budget']);
      assert.equal(cli.status, 0, cli.stderr);
      const out = json(cli);
      assert.equal(out.month, month());
      assert.equal(out.spent.monthUsd, month() === '2026-10' ? 13 : 3);
      assert.equal(out.configured.usdPerMonth, 100);
    } finally {
      s.cleanup();
    }
  });

  test('job new parks over the cap', async () => {
    const s = budgetRepo({ usdPerMonth: 100 }, 103.2);
    try {
      const r: any = await jobCmd(s.root, s.config, 'new', [], { title: 'X', session: 'S' });
      assert.deepEqual(r.repoBudget, { held: true, reason: 'repo budget: $103.20 of $100.00 this month' });
      const job = loadJob(s.root, r.id);
      assert.equal(job.state, 'waiting');
      assert.equal(job.waitingOn, 'budget');
      assert.equal(job.reason, 'repo budget: $103.20 of $100.00 this month');
      assert.equal(job.owner, null, 'not claimed, even with --session');
      const [t] = events(s.root, r.id, 'transition');
      assert.deepEqual(transitionEvents(t.from as any, t.to as any, job)?.events, ['budget-exceeded', 'gate'], 'the park queues budget-exceeded like other budget parks');
      assert.equal(events(s.root, r.id, 'repo-budget-hold').length, 1);
      assert.deepEqual(repoBudgetStatus(s.root, s.config).heldJobs, [r.id]);
    } finally {
      s.cleanup();
    }
  });

  test('retro and force are exempt', async () => {
    const s = budgetRepo({ usdPerMonth: 100 }, 150);
    try {
      const retro: any = await jobCmd(s.root, s.config, 'new', [], { title: 'Retro', kind: 'retro' });
      assert.equal(loadJob(s.root, retro.id).state, 'queued', 'a retro job is never parked');
      assert.equal(retro.repoBudget, undefined);
      const forced: any = await jobCmd(s.root, s.config, 'new', [], { title: 'Forced', session: 'S', force: true });
      const job = loadJob(s.root, forced.id);
      assert.equal(job.owner?.session, 'S', 'claimed when --session is given');
      assert.notEqual(job.state, 'waiting');
      const [o] = events(s.root, forced.id, 'budget-override');
      assert.equal(o.month, month());
      assert.equal(o.day, today());
      assert.ok(o.actor, 'the override names who forced it');
      await jobCmd(s.root, s.config, 'release', [forced.id], {});
      const again: any = await jobCmd(s.root, s.config, 'claim', [forced.id], { session: 'S2' });
      assert.equal(again.owner.session, 'S2', 'a later claim this month is not parked');
      assert.notEqual(loadJob(s.root, forced.id).state, 'waiting');
    } finally {
      s.cleanup();
    }
  });

  test("daemon sessions can't lift the cap", async () => {
    const s = budgetRepo({ usdPerMonth: 100 }, 150);
    try {
      const env = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(s.root) };
      const before = fs.readdirSync(path.join(s.root, '.forge', 'jobs')).length;
      const f = await forgeAsync(s.root, ['job', 'new', '--title', 'Sneaky', '--force'], env);
      assert.equal(f.status, 1, f.stderr);
      assert.match(f.stderr, /daemon session may not/);
      assert.equal(fs.readdirSync(path.join(s.root, '.forge', 'jobs')).length, before, 'no job dir');
      const a = await forgeAsync(s.root, ['budget', 'ack', '--period', month()], env);
      assert.equal(a.status, 1, a.stderr);
      assert.equal(audit(s.root).length, 0, 'no audit line');
    } finally {
      s.cleanup();
    }
  });

  test('claim parks over the cap', async () => {
    const s = budgetRepo({ usdPerMonth: 100 }, 150);
    try {
      const j = createJob(s.root, s.config, { title: 'Queued' });
      setJob(s.root, j.id, { stage: 'build', state: 'queued' });
      const before = events(s.root, j.id, 'transition').length;
      const r = await forgeAsync(s.root, ['job', 'claim', j.id, '--session', 'S']);
      assert.equal(r.status, 4, r.stderr);
      assert.match(r.stderr, /repo budget: \$150\.00 of \$100\.00 this month/);
      const job = loadJob(s.root, j.id);
      assert.deepEqual([job.state, job.waitingOn, job.stage, job.owner], ['waiting', 'budget', 'build', null]);
      assert.equal(events(s.root, j.id, 'transition').length, before + 1);
      const again = await forgeAsync(s.root, ['job', 'claim', j.id, '--session', 'S']);
      assert.equal(again.status, 4);
      assert.equal(events(s.root, j.id, 'transition').length, before + 1, 'a second claim logs no second transition');
      assert.equal(loadJob(s.root, j.id).owner, null);
    } finally {
      s.cleanup();
    }
  });

  test('claim never strands a running agent or double-parks', async () => {
    const s = budgetRepo({ usdPerMonth: 100 }, 150);
    try {
      const running = createJob(s.root, s.config, { title: 'Running' });
      setJob(s.root, running.id, { stage: 'build', state: 'running' });
      recordAgent(s.root, running.id, { role: 'builder', phase: 'start' }, s.config);
      const r: any = await jobCmd(s.root, s.config, 'claim', [running.id], { session: 'S' });
      assert.equal(r.owner.session, 'S');
      assert.deepEqual(r.repoBudget, { held: true, reason: 'repo budget: $150.00 of $100.00 this month' });
      assert.equal(loadJob(s.root, running.id).state, 'running', 'state unchanged');

      const owned = createJob(s.root, s.config, { title: 'Owned' });
      claimJob(s.root, owned.id, 'other');
      await assert.rejects(jobCmd(s.root, s.config, 'claim', [owned.id], { session: 'S' }), (e: any) => e.exitCode === 3);
      assert.equal(loadJob(s.root, owned.id).state, 'queued', 'a live foreign owner leaves it unparked');

      const perJob = perJobOver(s.root, s.config, 'Per-job');
      setJob(s.root, perJob, { state: 'waiting', waitingOn: 'budget', reason: 'budget exceeded: verifyRetries 3/2' });
      await jobCmd(s.root, s.config, 'claim', [perJob], { session: 'S' });
      assert.equal(loadJob(s.root, perJob).reason, 'budget exceeded: verifyRetries 3/2', 'a per-job budget wait keeps its reason');
    } finally {
      s.cleanup();
    }
  });

  test('next and from-ref start nothing', async () => {
    const s = budgetRepo({ usdPerMonth: 100 }, 150);
    try {
      const queued = createJob(s.root, s.config, { title: 'Queued' });
      fs.writeFileSync(path.join(s.root, '.forge', 'backlog.md'), '# Backlog\n\n- [ ] Ready item\n');
      const jobsBefore = fs.readdirSync(path.join(s.root, '.forge', 'jobs')).sort();
      const n = await forgeAsync(s.root, ['next', '--claim', '--session', 'S']);
      assert.equal(n.status, 0, n.stderr);
      assert.deepEqual(json(n), { held: true, repoBudget: { held: true, reason: 'repo budget: $150.00 of $100.00 this month' } });
      const q = loadJob(s.root, queued.id);
      assert.deepEqual([q.state, q.owner], ['queued', null], 'the queued job stays queued and unowned');
      assert.deepEqual(fs.readdirSync(path.join(s.root, '.forge', 'jobs')).sort(), jobsBefore, 'no job is created');
      assert.match(fs.readFileSync(path.join(s.root, '.forge', 'backlog.md'), 'utf8'), /- \[ \] Ready item/, 'no tracker item is claimed');
      const f = await forgeAsync(s.root, ['job', 'from-ref', 'ready-item', '--session', 'S']);
      assert.equal(f.status, 4, f.stderr);
      assert.deepEqual(fs.readdirSync(path.join(s.root, '.forge', 'jobs')).sort(), jobsBefore);
    } finally {
      s.cleanup();
    }
  });

  test('warn only logs', async () => {
    const s = budgetRepo({ usdPerMonth: 100, onExceeded: 'warn' }, 150);
    try {
      const reason = 'repo budget: $150.00 of $100.00 this month';
      const created: any = await jobCmd(s.root, s.config, 'new', [], { title: 'New', session: 'S' });
      assert.deepEqual(created.repoBudget, { held: false, reason });
      assert.equal(loadJob(s.root, created.id).owner?.session, 'S');
      assert.equal(events(s.root, created.id, 'repo-budget-warn').length, 1);

      const q = createJob(s.root, s.config, { title: 'Queued' });
      const claimed: any = await jobCmd(s.root, s.config, 'claim', [q.id], { session: 'S2' });
      assert.deepEqual(claimed.repoBudget, { held: false, reason });
      assert.equal(loadJob(s.root, q.id).state, 'queued');
      assert.equal(events(s.root, q.id, 'repo-budget-warn').length, 1);
      await jobCmd(s.root, s.config, 'release', [q.id], {});

      const next: any = await nextCmd(s.root, s.config, { claim: true, session: 'S3' });
      assert.equal(next.resumed, true);
      assert.deepEqual(next.repoBudget, { held: false, reason });
      assert.equal(events(s.root, next.id, 'repo-budget-warn').length, 2, 'the claim and the next each logged one');
    } finally {
      s.cleanup();
    }
  });

  test('ack grants a period and releases holds', async () => {
    const s = budgetRepo({ usdPerMonth: 100 }, 150, { daemon: { enabled: true } });
    try {
      s.config.daemon.enabled = true;
      const fine: any = await jobCmd(s.root, s.config, 'new', [], { title: 'Fine' });
      setJob(s.root, fine.id, { stage: 'build' });
      const over = perJobOver(s.root, s.config, 'Over per-job');
      setJob(s.root, over, { stage: 'build' });
      parkForRepoBudget(s.root, over, repoBudgetStatus(s.root, s.config));
      assert.deepEqual(repoBudgetStatus(s.root, s.config).heldJobs.sort(), [fine.id, over].sort());

      const r = await forgeAsync(s.root, ['budget', 'ack', '--period', month(), '--note', 'quarter end']);
      assert.equal(r.status, 0, r.stderr);
      const out = json(r);
      assert.equal(out.acked, month());
      assert.equal(out.status.caps.usdPerMonth, 200, 'the effective cap doubles');
      assert.equal(out.status.held, false);
      const acks = audit(s.root).filter((e) => e.type === 'repo-budget-ack');
      assert.equal(acks.length, 1);
      assert.equal(acks[0].period, month());
      assert.ok((acks[0].actor as any)?.source);

      const f = loadJob(s.root, fine.id);
      assert.deepEqual([f.state, f.stage, f.reason], ['queued', 'build', 'repo budget released']);
      assert.equal(loadJob(s.root, over).state, 'waiting', 'a job over its per-job budget stays held');
      const resumes = listRequests(s.root).filter((x) => x.type === 'resume');
      assert.deepEqual(resumes.map((x) => x.job), [fine.id], 'exactly one resume, for the released job');
      assert.equal(resumes[0].from, 'budget');
      await forgeAsync(s.root, ['budget']);
      assert.equal(listRequests(s.root).filter((x) => x.type === 'resume').length, 1, 'a second release queues no second resume');

      const a = await forgeAsync(s.root, ['audit', '--since', today()]);
      assert.equal(a.status, 0, a.stderr);
      assert.ok(json(a).rows.some((row: any) => row.action === 'repo-budget-ack' && row.job === null));
    } finally {
      s.cleanup();
    }
  });

  test('ack refusals', async () => {
    const s = budgetRepo({ usdPerMonth: 100, usdPerDay: 1000 }, 150);
    try {
      const ack = (...args: string[]) => forgeAsync(s.root, ['budget', 'ack', ...args]);
      const d = new Date();
      const past = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
      const future = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
      assert.equal((await ack('--period', past)).status, 1, 'a past month');
      assert.equal((await ack('--period', future)).status, 1, 'a future month');
      const within = await ack('--period', today());
      assert.equal(within.status, 1, 'the day is within its cap');
      assert.match(within.stderr, new RegExp(`nothing to acknowledge: ${today()} is within its cap`));
      assert.equal((await ack('--period', '2026-13')).status, 2);
      assert.equal((await ack()).status, 2, 'a missing --period');
      assert.equal(audit(s.root).length, 0);

      const held: any = await jobCmd(s.root, s.config, 'new', [], { title: 'Held' });
      budgetCmd(s.root, s.config, held.id, { ack: true });
      await jobCmd(s.root, s.config, 'budget', [held.id], { ack: true });
      assert.equal(loadJob(s.root, held.id).state, 'waiting', 'forge job budget --ack never lifts the repo cap');
    } finally {
      s.cleanup();
    }
  });

  test('release never frees a per-job budget stop', async () => {
    const s = budgetRepo({ usdPerMonth: 100 }, 50);
    try {
      const id = perJobOver(s.root, s.config, 'Spoofed');
      // A session rewrote its per-job stop to look like a repo hold.
      setJob(s.root, id, { state: 'waiting', waitingOn: 'budget', reason: 'repo budget: $1.00 of $0.00 this month' });
      assert.equal((await forgeAsync(s.root, ['budget'])).status, 0);
      assert.equal(loadJob(s.root, id).state, 'waiting', 'forge budget');
      assert.equal((await forgeAsync(s.root, ['sync'])).status, 0);
      assert.equal(loadJob(s.root, id).state, 'waiting', 'forge sync');
      // A new month: nothing spent and nothing held.
      const next = repoBudgetStatus(s.root, s.config, { at: Date.now() + 40 * 86_400_000 });
      assert.deepEqual(releaseRepoHolds(s.root, s.config, next), []);
      assert.equal(loadJob(s.root, id).state, 'waiting', 'a new month');
    } finally {
      s.cleanup();
    }
  });
});
