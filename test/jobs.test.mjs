import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.mjs';
import { defaults } from '../lib/config.mjs';
import { claimJob, createJob, loadJob, roundVerdicts, setJob, recordAgent, progress, parseDecision, jobDir } from '../lib/jobs.mjs';
import { computeStats } from '../lib/stats.mjs';

test('job lifecycle: ids, transitions, claims, usage, verdict policy', () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const config = defaults();
    const a = createJob(root, config, { title: 'Add dark mode toggle', ref: '42' });
    assert.equal(a.id, '42-add-dark-mode-toggle');
    assert.equal(a.branch, 'factory/42-add-dark-mode-toggle');
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

    fs.writeFileSync(path.join(jobDir(root, a.id), 'decision.md'), 'ESCALATE: touches the deploy pipeline\n\nRisk: high\n');
    assert.deepEqual(parseDecision(root, a.id), { decision: 'ESCALATE', reason: 'touches the deploy pipeline' });

    setJob(root, a.id, { fields: { 'verdicts.1': { code: 'PASS', ui: 'CHANGES' }, 'verdicts.2': { code: 'PASS', ui: 'PASS' }, decision: 'APPROVE' } });
    const s = computeStats(root);
    assert.equal(s.counts.total, 3);
    assert.equal(s.quality.firstPassReviewRate, 0);
    assert.equal(s.quality.avgRounds, 2);
    assert.equal(s.reviewers.ui.changeRate, 0.5);
    assert.equal(loadJob(root, a.id).verdicts['2'].ui, 'PASS');
  } finally {
    repo.cleanup();
  }
});
