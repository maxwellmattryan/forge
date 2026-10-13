import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.mjs';
import { defaults } from '../lib/config.ts';
import { claimJob, createJob, loadJob, roundVerdicts, setJob, recordAgent, progress, parseDecision, touchJob, jobDir } from '../lib/jobs.ts';
import { computeStats } from '../lib/stats.mjs';
import { JOB_SCHEMA_VERSION } from '../lib/schema.ts';
import { sleepSync } from '../lib/util.ts';

test('job lifecycle: ids, transitions, claims, usage, verdict policy', () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const config = defaults();
    const a = createJob(root, config, { title: 'Add dark mode toggle', ref: '42' });
    assert.equal(a.id, '42-add-dark-mode-toggle');
    assert.equal(a.branch, 'forge/42-add-dark-mode-toggle');
    const b = createJob(root, config, { title: 'Add dark mode toggle', ref: '42' });
    assert.equal(b.id, '42-add-dark-mode-toggle-2');
    const c = createJob(root, config, { title: 'Reading time', ref: 'reading-time' });
    assert.equal(c.id, 'reading-time');

    assert.throws(() => setJob(root, a.id, { stage: 'nope' }), /unknown stage/);
    assert.throws(() => setJob(root, a.id, { state: 'waiting' }), /needs --waiting-on/);
    const w = setJob(root, a.id, { stage: 'spec', state: 'waiting', waitingOn: 'spec-approval' });
    assert.equal(w.waitingOn, 'spec-approval');
    const r = setJob(root, a.id, { stage: 'build', state: 'running' });
    assert.equal(r.waitingOn, null, 'leaving waiting clears waitingOn');

    claimJob(root, a.id, 'session-1');
    assert.throws(() => claimJob(root, a.id, 'session-2'), /being driven by session session-1/);
    assert.equal(claimJob(root, a.id, 'session-2', true).owner.session, 'session-2');

    recordAgent(root, a.id, { role: 'builder', phase: 'start', model: 'opus' }, config);
    const after = recordAgent(root, a.id, { role: 'builder', phase: 'end', usage: { input: 1000, output: 2000, cacheRead: 100000, cacheWrite: 5000 } }, config);
    assert.equal(after.usage.totalTokens, 108000);
    assert.ok(after.usage.byModel['claude-opus-5-5'].estCostUsd > 0);

    fs.writeFileSync(path.join(jobDir(root, a.id), 'tasks.md'), '- [x] one\n- [ ] two\n  - [X] nested\n');
    assert.deepEqual(progress(root, a.id), { done: 2, total: 3 });

    const dir = path.join(jobDir(root, a.id), 'review', 'round-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'code.md'), 'VERDICT: PASS\n\n- [nit] naming\n');
    fs.writeFileSync(path.join(dir, 'ui.md'), 'VERDICT: PASS\n\n- [major] contrast\n');
    let v = roundVerdicts(root, a.id, 1, ['code', 'ui', 'tests'], ['blocker', 'major']);
    assert.equal(v.outcome, 'PENDING');
    fs.writeFileSync(path.join(dir, 'tests.md'), 'Looks fine to me\n');
    v = roundVerdicts(root, a.id, 1, ['code', 'ui', 'tests'], ['blocker', 'major']);
    assert.equal(v.reviewers.code.verdict, 'PASS');
    assert.equal(v.reviewers.ui.verdict, 'CHANGES', 'a tagged major overrides a declared PASS');
    assert.equal(v.reviewers.tests.verdict, 'MALFORMED');
    assert.equal(v.outcome, 'MALFORMED');
    const lenient = roundVerdicts(root, a.id, 1, ['code', 'ui'], ['blocker']);
    assert.equal(lenient.outcome, 'PASS', 'blockOn policy decides what forces a round');
    fs.writeFileSync(path.join(dir, 'security.md'), 'Forgot the verdict line\n\n- [blocker] secret in log\n');
    assert.equal(roundVerdicts(root, a.id, 1, ['security'], ['blocker']).reviewers.security.verdict, 'CHANGES', 'tagged blockers decide even without a verdict line');
    const coerced = roundVerdicts(root, a.id, 1, ['tests'], ['blocker'], { malformedAs: 'changes' }).reviewers.tests;
    assert.equal(coerced.verdict, 'CHANGES');
    assert.equal(coerced.coerced, true, 'a second malformed review is counted as CHANGES, not left pending');

    const idir = path.join(jobDir(root, a.id), 'review', 'integration');
    assert.equal(roundVerdicts(root, a.id, 'integration', ['code'], ['blocker', 'major']).outcome, 'PENDING');
    fs.mkdirSync(idir, { recursive: true });
    fs.writeFileSync(path.join(idir, 'code.md'), 'VERDICT: PASS\n\n- [nit] comment\n');
    const integ = roundVerdicts(root, a.id, 'integration', ['code'], ['blocker', 'major']);
    assert.equal(integ.outcome, 'PASS', 'the integration review reads review/integration/, not a round dir');
    assert.equal(integ.round, 'integration');
    assert.equal(integ.reviewers.code.file, path.join('review', 'integration', 'code.md'));
    fs.writeFileSync(path.join(idir, 'code.md'), 'VERDICT: PASS\n\n- [major] dropped a base-side guard\n');
    assert.equal(roundVerdicts(root, a.id, 'integration', ['code'], ['blocker', 'major']).outcome, 'CHANGES');
    fs.writeFileSync(path.join(idir, 'code.md'), 'resolution looks fine\n');
    assert.equal(roundVerdicts(root, a.id, 'integration', ['code'], ['blocker', 'major']).outcome, 'MALFORMED');

    fs.writeFileSync(path.join(jobDir(root, a.id), 'decision.md'), 'ESCALATE: touches the deploy pipeline\n\nRisk: high\n');
    assert.deepEqual(parseDecision(root, a.id), { decision: 'ESCALATE', reason: 'touches the deploy pipeline' });

    setJob(root, a.id, { fields: { 'verdicts.1': { code: 'PASS', ui: 'CHANGES' }, 'verdicts.2': { code: 'PASS', ui: 'PASS' }, decision: 'APPROVE' } });
    const s = computeStats(root);
    assert.equal(s.counts.total, 3);
    assert.equal(s.quality.firstPassReviewRate, 0);
    assert.equal(s.quality.avgRounds, 2);
    assert.equal((s.reviewers.ui as any).changeRate, 0.5);
    assert.equal(loadJob(root, a.id).verdicts['2'].ui, 'PASS');
  } finally {
    repo.cleanup();
  }
});

test('claims stay alive while an agent runs, and heartbeats refresh on touch', () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const config = defaults();
    const job = createJob(root, config, { title: 'Long build' });
    claimJob(root, job.id, 'session-1');
    // Every write refreshes the heartbeat, so a stale one has to be planted behind the CLI's back.
    const plantStaleHeartbeat = () => {
      const file = path.join(jobDir(root, job.id), 'job.json');
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      raw.owner.heartbeat = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      fs.writeFileSync(file, JSON.stringify(raw));
    };
    recordAgent(root, job.id, { role: 'builder', phase: 'start', model: 'opus' }, config);
    plantStaleHeartbeat();
    assert.throws(() => claimJob(root, job.id, 'session-2'), /an agent is still running/, 'a running agent keeps the claim alive past the heartbeat window');
    const before = loadJob(root, job.id).owner.heartbeat;
    sleepSync(5);
    touchJob(root, job.id);
    assert.ok(loadJob(root, job.id).owner.heartbeat > before, 'touch refreshes the heartbeat');
    recordAgent(root, job.id, { role: 'builder', phase: 'end' }, config);
    plantStaleHeartbeat();
    assert.equal(claimJob(root, job.id, 'session-2').owner.session, 'session-2', 'a stale claim with no running agent can be taken over');
  } finally {
    repo.cleanup();
  }
});

test('reads a schema v1 job and migrates its verify results', () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const job = createJob(root, defaults(), { title: 'Old job' });
    const file = path.join(jobDir(root, job.id), 'job.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete raw.verifyRuns;
    fs.writeFileSync(file, JSON.stringify({ ...raw, schemaVersion: 1, verify: { 1: 'FAIL', 2: 'PASS' } }));
    const loaded = loadJob(root, job.id);
    assert.equal(loaded.schemaVersion, JOB_SCHEMA_VERSION);
    assert.deepEqual(
      loaded.verifyRuns.map((r) => [r.round, r.attempt, r.ok, r.sha]),
      [[1, 1, false, null], [2, 1, true, null]],
      'old per-round results become attempt 1 with no sha',
    );
    assert.equal(loaded.verify[1], 'FAIL', 'the compatible field survives');
  } finally {
    repo.cleanup();
  }
});
