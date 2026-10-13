import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempRepo } from './helpers.mjs';
import { defaults, validateConfig } from '../lib/config.ts';
import { createJob, jobDir, loadJob, readEvents, setJob } from '../lib/jobs.ts';
import { budgetCmd, enforceBudget, exceededKeys, formatReason } from '../lib/budget.mjs';
import { jobCmd } from '../lib/commands/job.mjs';
import { migrate } from '../lib/commands/init.mjs';
import { API_VERSION, BUDGET_KEYS, JOB_SCHEMA_VERSION, WAITING_ON } from '../lib/schema.ts';
import { API_VERSION as DASH_API_VERSION } from '../dashboard/src/lib/types.ts';
import { WAIT_LABEL } from '../dashboard/src/lib/labels.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

/** A repo with one job and a config whose budget the test mutates. */
function setup() {
  const repo = tempRepo();
  const config = defaults();
  const job = createJob(repo.dir, config, { title: 'Budgeted job' });
  setJob(repo.dir, job.id, { stage: 'build', state: 'running' });
  const agentEnd = (flags) => jobCmd(repo.dir, config, 'agent', [job.id, 'end'], { role: 'builder', ...flags });
  const count = (type) => readEvents(repo.dir, job.id).filter((e) => e.type === type).length;
  return { repo, root: repo.dir, config, id: job.id, agentEnd, count };
}

test('AC1/AC2/AC16: defaults, validation, waitingOn and versions', () => {
  const d = defaults();
  assert.deepEqual(d.pipeline.budget, { tokens: null, usd: null, minutes: null, changedLines: null, verifyRetries: 2 });
  const budgetProblems = (budget) => {
    const c = defaults();
    Object.assign(c.pipeline.budget, budget);
    return validateConfig(c, process.cwd()).filter((p) => p.includes('pipeline.budget'));
  };
  assert.deepEqual(budgetProblems({}), []);
  assert.equal(budgetProblems({ usd: -1 }).length, 1);
  assert.equal(budgetProblems({ verifyRetries: 1.5 }).length, 1);
  assert.equal(budgetProblems({ tokens: 'lots' }).length, 1);
  assert.deepEqual(budgetProblems({ tokens: null, usd: 2.5, verifyRetries: 0 }), []);
  assert.ok(WAITING_ON.includes('budget'));
  assert.equal(JOB_SCHEMA_VERSION, 3);
  assert.equal(API_VERSION, 4);
  assert.deepEqual(BUDGET_KEYS, ['tokens', 'usd', 'minutes', 'changedLines', 'verifyRetries']);
  assert.equal(DASH_API_VERSION, 4);
  assert.equal(DASH_API_VERSION, API_VERSION);
  assert.equal(WAIT_LABEL.budget, 'Budget exceeded');
  const { repo, root, id } = setup();
  try {
    setJob(root, id, { state: 'waiting', waitingOn: 'budget', reason: 'x' });
    assert.equal(loadJob(root, id).waitingOn, 'budget');
  } finally {
    repo.cleanup();
  }
});

test('reasons list keys in fixed order with per-key formatting; acks apply per key and round', () => {
  const limits = { tokens: 10, usd: 1, minutes: 2, changedLines: null, verifyRetries: 2 };
  const used = { tokens: 11, usd: 1.234, minutes: 2.25, changedLines: 999, verifyRetries: 3 };
  const ex = exceededKeys(limits, used, {}, 1);
  assert.deepEqual(ex.map((e) => e.key), ['tokens', 'usd', 'minutes', 'verifyRetries'], 'a null limit never trips');
  assert.equal(formatReason(ex), 'budget exceeded: tokens 11/10, usd 1.23/1.00, minutes 2.3/2.0, verifyRetries 3/2');
  assert.deepEqual(exceededKeys(limits, { ...used, tokens: null }, {}, 1).map((e) => e.key)[0], 'usd', 'an unmeasured key never trips');
  assert.deepEqual(exceededKeys({ ...limits, tokens: 10 }, { ...used, tokens: 10 }, {}, 1).map((e) => e.key)[0], 'usd', 'equal to the limit is not over it');
  const acked = exceededKeys(limits, used, { verifyRetries: { used: 3, round: 1 } }, 1);
  assert.ok(!acked.some((e) => e.key === 'verifyRetries'));
  const nextRound = exceededKeys(limits, used, { verifyRetries: { used: 3, round: 1 } }, 2);
  assert.ok(nextRound.some((e) => e.key === 'verifyRetries'), 'a verifyRetries ack belongs to its round');
});

test('AC3/AC9/AC11/AC14: tokens stop at agent end, repeat checkpoints stay quiet, ack grants one more budget', async () => {
  const { repo, root, config, id, agentEnd, count } = setup();
  try {
    config.pipeline.budget.tokens = 1000;
    const under = await agentEnd({ tokens: 500 });
    assert.ok(!('budget' in under), 'AC8: no budget key under budget');
    const lc = loadJob(root, id).budget.lastCheck;
    assert.equal(lc.checkpoint, 'agent-end');
    assert.deepEqual(Object.keys(lc.used).sort(), [...BUDGET_KEYS].sort(), 'AC14: lastCheck has every used key');

    const over = await agentEnd({ tokens: 1000 });
    assert.deepEqual(over.budget, { stopped: true, reason: 'budget exceeded: tokens 1500/1000', exceeded: [{ key: 'tokens', used: 1500, limit: 1000 }] });
    let job = loadJob(root, id);
    assert.equal(job.state, 'waiting');
    assert.equal(job.waitingOn, 'budget');
    assert.equal(job.stage, 'build', 'the stage is kept');
    assert.equal(job.reason, 'budget exceeded: tokens 1500/1000');
    assert.equal(count('budget'), 1);
    const transitions = count('transition');

    // A parallel reviewer finishing after the stop (AC9).
    const again = enforceBudget(root, config, id, 'agent-end');
    assert.equal(again.stopped, true);
    assert.equal(count('budget'), 1);
    assert.equal(count('transition'), transitions);
    assert.equal(loadJob(root, id).waitingOn, 'budget');

    // AC11: acknowledge, resume, spend within one more budget, then trip again.
    const ack = budgetCmd(root, config, id, { ack: true });
    assert.deepEqual(ack.acked, ['tokens']);
    assert.deepEqual(ack.stillExceeded, []);
    assert.deepEqual(ack.ack.tokens, { used: 1500, round: 0 });
    assert.equal(count('budget-ack'), 1);
    assert.equal(loadJob(root, id).state, 'waiting', 'budget never changes state');
    assert.deepEqual(budgetCmd(root, config, id, { ack: true }).acked, [], 'nothing exceeded: ack is a no-op');
    setJob(root, id, { state: 'running' });
    assert.ok(!('budget' in (await agentEnd({ tokens: 400 }))), '400 past the ack is within budget');
    assert.ok(!('budget' in (await agentEnd({ tokens: 600 }))), 'exactly one more budget is still within it');
    const tripped = await agentEnd({ tokens: 1 });
    assert.equal(tripped.budget.stopped, true);
    job = loadJob(root, id);
    assert.equal(job.waitingOn, 'budget');
    assert.equal(job.usage.totalTokens, 2501);
  } finally {
    repo.cleanup();
  }
});

test('AC4/AC5: usd and agent minutes stop the job', async () => {
  const { repo, root, config, id, agentEnd } = setup();
  try {
    await agentEnd({ tokens: 100000, model: 'sonnet' });
    const cost = loadJob(root, id).usage.estCostUsd;
    assert.ok(cost > 0);
    config.pipeline.budget.usd = cost / 2;
    const r = enforceBudget(root, config, id, 'agent-end');
    assert.deepEqual(r.exceeded.map((e) => e.key), ['usd']);
    assert.match(r.reason, /^budget exceeded: usd \d+\.\d{2}\/\d+\.\d{2}$/);
  } finally {
    repo.cleanup();
  }
  const s = setup();
  try {
    s.config.pipeline.budget.minutes = 2;
    await s.agentEnd({ 'duration-ms': 60000 });
    const r = await jobCmd(s.root, s.config, 'agent', [s.id, 'end'], { role: 'reviewer:code', 'duration-ms': 61000 });
    assert.deepEqual(r.budget.exceeded, [{ key: 'minutes', used: 2.0167, limit: 2 }], 'agent minutes sum across roles');
    assert.equal(r.budget.reason, 'budget exceeded: minutes 2.0/2.0');
  } finally {
    s.repo.cleanup();
  }
});

test('AC8/AC10/AC12: rounds increment under budget, terminal jobs never move, raising and overrides', async () => {
  const { repo, root, config, id, agentEnd } = setup();
  try {
    const r1 = await jobCmd(root, config, 'round', [id], {});
    assert.deepEqual(r1, { round: 1, maxRounds: 3, exhausted: false });
    config.pipeline.budget.tokens = 1000;
    await agentEnd({ tokens: 1500 });
    assert.equal(loadJob(root, id).waitingOn, 'budget');

    assert.throws(() => budgetCmd(root, config, id, { set: ['bogus=1'] }), /allowed keys: tokens, usd, minutes, changedLines, verifyRetries/);
    assert.throws(() => budgetCmd(root, config, id, { set: ['usd=-2'] }), /allowed keys/);
    assert.throws(() => budgetCmd(root, config, id, { set: ['verifyRetries=1.5'] }), /non-negative integer/);
    const raised = await jobCmd(root, config, 'budget', [id], { set: 'tokens=5000' });
    assert.deepEqual(raised.stillExceeded, []);
    assert.deepEqual(raised.exceeded, []);
    assert.equal(raised.limits.tokens, 5000);
    assert.equal(loadJob(root, id).budget.limits.tokens, 5000);
    assert.equal(readEvents(root, id).filter((e) => e.type === 'budget-set').length, 1);
    setJob(root, id, { state: 'running' });
    const r2 = await jobCmd(root, config, 'round', [id], {});
    assert.equal(r2.round, 2);
    assert.ok(!('budget' in r2));

    // An explicit null override wins over the config limit.
    config.pipeline.budget.tokens = 10;
    assert.equal(budgetCmd(root, config, id, { set: ['tokens=null'] }).limits.tokens, null);
    assert.equal(enforceBudget(root, config, id, 'round'), null);
    const reset = budgetCmd(root, config, id, { set: ['tokens=default'] });
    assert.equal(reset.limits.tokens, 10);
    assert.ok(!('tokens' in loadJob(root, id).budget.limits));
    assert.deepEqual(reset.stillExceeded, ['tokens']);

    // The round does not move while over budget.
    const stopped = await jobCmd(root, config, 'round', [id], {});
    assert.equal(stopped.round, 2);
    assert.equal(stopped.budget.stopped, true);
    assert.equal(loadJob(root, id).round, 2);

    for (const state of ['done', 'cancelled', 'failed']) {
      setJob(root, id, { state });
      assert.equal(enforceBudget(root, config, id, 'round'), null);
      assert.ok(!('budget' in (await agentEnd({ tokens: 1 }))));
      assert.equal(loadJob(root, id).state, state);
    }
  } finally {
    repo.cleanup();
  }
});

test('AC6/AC7/AC13: changed lines and verify retries through the CLI', () => {
  const repo = tempRepo();
  const env = { ...process.env, FORGE_ROOT: repo.dir };
  const f = (...args) => {
    const out = execFileSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env });
    try {
      return JSON.parse(out);
    } catch {
      return out.trim();
    }
  };
  const failingVerify = (id) => {
    try {
      f('verify', id);
    } catch (e) {
      assert.equal(e.status, 1, 'verify exits 1 only because verify failed');
      return JSON.parse(e.stdout);
    }
    assert.fail('verify should have failed');
  };
  const wtRoot = `../${path.basename(repo.dir)}.wt`;
  try {
    const answers = path.join(repo.dir, '..', `answers-${path.basename(repo.dir)}.json`);
    fs.writeFileSync(answers, JSON.stringify({ commands: { build: 'true', test: 'false', lint: 'true' }, worktrees: { root: wtRoot } }));
    assert.equal(f('init', 'write', '--answers', answers).ok, true);
    fs.rmSync(answers);
    const { id } = f('job', 'new', '--title', 'Budget CLI');
    const wt = f('worktree', 'create', id);
    f('job', 'set', id, '--stage', 'build', '--state', 'running');
    assert.equal(loadJob(repo.dir, id).budget.lastCheck, null);
    assert.equal(f('job', 'budget', id).used.changedLines, 0);

    fs.writeFileSync(path.join(wt.path, 'thirty.txt'), Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n');
    execFileSync('git', ['add', '-A'], { cwd: wt.path });
    execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'thirty'], { cwd: wt.path });

    // AC6
    f('job', 'budget', id, '--set', 'changedLines=10');
    const round = f('job', 'round', id);
    assert.equal(round.round, 0, 'the round is not incremented');
    assert.deepEqual(round.budget.exceeded, [{ key: 'changedLines', used: 30, limit: 10 }]);
    assert.equal(loadJob(repo.dir, id).round, 0);
    f('job', 'budget', id, '--set', 'changedLines=default');
    f('job', 'set', id, '--state', 'running');
    assert.equal(f('job', 'round', id).round, 1);

    // AC7
    assert.ok(!('budget' in failingVerify(id)));
    assert.ok(!('budget' in failingVerify(id)));
    const third = failingVerify(id);
    assert.deepEqual(third.budget.exceeded, [{ key: 'verifyRetries', used: 3, limit: 2 }]);
    let job = loadJob(repo.dir, id);
    assert.equal(job.verifyRetries['1'], 3);
    assert.equal(job.waitingOn, 'budget');
    assert.equal(job.budget.lastCheck.checkpoint, 'verify');

    // AC13: the ack holds for round 1 only.
    assert.deepEqual(f('job', 'budget', id, '--ack').acked, ['verifyRetries']);
    f('job', 'set', id, '--state', 'running');
    assert.ok(!('budget' in failingVerify(id)), 'acked: one more full set of retries this round');
    assert.equal(f('job', 'round', id).round, 2);
    assert.ok(!('budget' in failingVerify(id)));
    assert.ok(!('budget' in failingVerify(id)));
    assert.equal(failingVerify(id).budget.exceeded[0].used, 3, 'round 2 trips on its own third failure');
    job = loadJob(repo.dir, id);
    assert.deepEqual(job.verifyRetries, { 1: 4, 2: 3 });
  } finally {
    repo.cleanup();
    fs.rmSync(path.resolve(repo.dir, wtRoot), { recursive: true, force: true });
  }
});

test('AC15: v2 and v1 jobs read as v3 and forge migrate rewrites them', () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const v2 = createJob(root, defaults(), { title: 'Two' });
    const v1 = createJob(root, defaults(), { title: 'One' });
    const fileOf = (id) => path.join(jobDir(root, id), 'job.json');
    const rewrite = (id, edit) => {
      const raw = JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
      delete raw.budget;
      delete raw.verifyRetries;
      fs.writeFileSync(fileOf(id), JSON.stringify(edit(raw)));
    };
    const run = (round, attempt, ok) => ({ round, attempt, sha: null, ok, at: null, file: `verify/round-${round}.md` });
    rewrite(v2.id, (raw) => ({ ...raw, schemaVersion: 2, verifyRuns: [run(1, 1, false), run(1, 2, false), run(1, 3, true), run(2, 1, false), run(2, 2, true)] }));
    rewrite(v1.id, (raw) => {
      delete raw.verifyRuns;
      return { ...raw, schemaVersion: 1, verify: { 1: 'FAIL', 2: 'PASS' } };
    });

    const two = loadJob(root, v2.id);
    assert.equal(two.schemaVersion, 3);
    assert.deepEqual(two.verifyRetries, { 1: 2, 2: 1 });
    assert.deepEqual(two.budget, { limits: {}, ack: {}, lastCheck: null });
    assert.equal(two.verifyRuns.length, 5, 'nothing is lost');
    const one = loadJob(root, v1.id);
    assert.equal(one.schemaVersion, 3);
    assert.deepEqual(one.verifyRetries, { 1: 1 });

    const { changed } = migrate(root);
    assert.equal(changed.length, 2);
    for (const id of [v2.id, v1.id]) {
      const raw = JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
      assert.equal(raw.schemaVersion, 3);
      assert.ok(raw.budget && raw.verifyRetries);
    }
  } finally {
    repo.cleanup();
  }
});
