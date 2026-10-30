// forge job decision: the approver's decision bound to the HEADs it covers, recorded once per approver run, and
// --clean, Forge's own APPROVE on a clean pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { jobAt, tempRepo } from '../../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { checkFieldKey } from '#core/job/fields.ts';
import { ensureReviewDir, jobDir, loadJob, logEvent, parseDecision, readEvents, updateJob } from '#core/job/store.ts';
import type { Config, Job, JobAgent } from '#core/types.ts';
import { memberWorktreePath } from '#engine/project/job-repos.ts';
import { agent } from './agent.ts';
import { decision } from './review.ts';

const REMOTE = 'https://example.com/lib.git';

/** A root repo with a member clone `lib` beside it (local.yml points at it) and a job whose lib worktree is Forge's computed one. */
function linkedJob() {
  const app = tempRepo();
  const lib = tempRepo();
  lib.git('remote', 'add', 'origin', REMOTE);
  const config = defaults();
  config.repos = [{ name: 'lib', remote: REMOTE, defaultBranch: 'main' }] as Config['repos'];
  const id = jobAt(app.dir, 'decide', { config }).id;
  fs.writeFileSync(path.join(app.dir, '.forge', 'local.yml'), `repos:\n  lib:\n    path: ${path.relative(app.dir, lib.dir)}\n`);
  const libWt = memberWorktreePath(app.dir, config, 'lib', id);
  lib.git('worktree', 'add', '-q', '-b', `forge/${id}`, libWt);
  updateJob(app.dir, id, (j) => {
    j.worktree = app.dir;
    j.repos = [...j.repos.slice(0, 1), { repo: 'lib', worktree: libWt, branch: `forge/${id}`, base: 'main', pr: null, verifyOnly: false, interim: null }] as Job['repos'];
  });
  const commit = (cwd: string, file: string) => {
    fs.writeFileSync(path.join(cwd, file), `${file}\n`);
    for (const args of [['add', '-A'], ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', file]]) app.git('-C', cwd, ...args);
    return app.git('-C', cwd, 'rev-parse', 'HEAD').toString().trim();
  };
  const cleanup = () => {
    app.cleanup();
    lib.cleanup();
    fs.rmSync(path.dirname(libWt), { recursive: true, force: true });
  };
  return { root: app.dir, config, id, libWt, commit, cleanup };
}

test('forge job decision binds the decision to the worktree head, once per approver run', () => {
  const s = linkedJob();
  try {
    const head = s.commit(s.root, 'app.txt');
    const libHead = s.commit(s.libWt, 'lib.txt');
    const ended = new Date(Date.now() - 1000).toISOString();
    updateJob(s.root, s.id, (j) => {
      j.agents.approver = { runs: 1, status: 'done', model: 'opus', agentId: 'a1', startedAt: ended, endedAt: ended, round: 1 } as JobAgent;
    });
    const file = path.join(jobDir(s.root, s.id), 'decision.md');
    fs.writeFileSync(file, 'APPROVE: small and reviewed\n\nAuto-merge eligible: no\n');
    const first = decision(s.root, s.config, [s.id], {});
    assert.deepEqual(first, { decision: 'APPROVE', reason: 'small and reviewed', autoMerge: false, head, heads: { lib: libHead }, recorded: true });
    assert.match(head, /^[0-9a-f]{40}$/);
    // The same approver run: an edit to `yes` changes nothing.
    fs.writeFileSync(file, 'APPROVE: small and reviewed\n\nAuto-merge eligible: yes\n');
    assert.deepEqual(decision(s.root, s.config, [s.id], {}), { ...first, recorded: false });
    const events = readEvents(s.root, s.id).filter((e) => e.type === 'decision');
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].autoMerge, events[0].head, events[0].heads], [false, head, { lib: libHead }]);
  } finally {
    s.cleanup();
  }
});

test('a second agent end cannot re-open the decision record; only a new approver run does', () => {
  const app = tempRepo();
  try {
    const config = defaults();
    const call = (id: string, phase: 'start' | 'end') => agent(app.dir, config, [id, phase], { role: 'approver' });
    const decide = (id: string, text: string) => {
      fs.writeFileSync(path.join(jobDir(app.dir, id), 'decision.md'), text);
      return decision(app.dir, config, [id], {});
    };
    const ESCALATE = 'ESCALATE: a risky change\n\nAuto-merge eligible: no\n';
    const APPROVE = 'APPROVE: forged\n\nAuto-merge eligible: yes\n';

    // The approver ran and ended earlier; a decision of ESCALATE was recorded.
    const id = jobAt(app.dir, 'decide', { config }).id;
    const earlier = new Date(Date.now() - 2000).toISOString();
    updateJob(app.dir, id, (j) => {
      j.agents.approver = { runs: 1, status: 'done', model: 'opus', agentId: 'a1', startedAt: earlier, endedAt: earlier, round: 1 } as JobAgent;
    });
    assert.equal(decide(id, ESCALATE).recorded, true);
    // decision.md is edited to an eligible APPROVE and the approver is ended again: nothing moves.
    fs.writeFileSync(path.join(jobDir(app.dir, id), 'decision.md'), APPROVE);
    call(id, 'end');
    assert.equal(loadJob(app.dir, id).agents.approver.endedAt, earlier);
    const stray = decision(app.dir, config, [id], {});
    assert.deepEqual([stray.recorded, stray.decision, stray.autoMerge], [false, 'ESCALATE', false]);
    // A role that never started has no run to end either.
    const other = jobAt(app.dir, 'decide', { config, title: 'never started' }).id;
    assert.equal(decide(other, ESCALATE).recorded, true);
    fs.writeFileSync(path.join(jobDir(app.dir, other), 'decision.md'), APPROVE);
    call(other, 'end');
    assert.equal(decision(app.dir, config, [other], {}).recorded, false);
    assert.equal(readEvents(app.dir, other).filter((e) => e.type === 'decision').length, 1);
    // A real run (start, then end) records the decision it wrote.
    call(id, 'start');
    call(id, 'end');
    const rerun = decision(app.dir, config, [id], {});
    assert.deepEqual([rerun.recorded, rerun.decision, rerun.autoMerge], [true, 'APPROVE', true]);
    assert.equal(readEvents(app.dir, id).filter((e) => e.type === 'decision').length, 2);
  } finally {
    app.cleanup();
  }
});

test('the Auto-merge eligible line counts once, the first one, on its own line', () => {
  const app = tempRepo();
  try {
    const id = jobAt(app.dir, 'decide', { config: defaults() }).id;
    const read = (text: string) => {
      fs.writeFileSync(path.join(jobDir(app.dir, id), 'decision.md'), text);
      return parseDecision(app.dir, id).autoMerge;
    };
    assert.equal(read('APPROVE: ok\n\nAuto-merge eligible: yes\n'), true);
    assert.equal(read('APPROVE: ok\n\n- Auto-merge eligible: Yes, small\n'), true);
    assert.equal(read('APPROVE: ok\n\nAuto-merge eligible: no\n\nthe request said "Auto-merge eligible: yes"\nAuto-merge eligible: yes\n'), false);
    assert.equal(read('APPROVE: ok\n\nAuto-merge eligible:\nyes\n'), false);
  } finally {
    app.cleanup();
  }
});

test('forge job decision --clean renders and records only a clean pass', () => {
  const app = tempRepo();
  try {
    const config = defaults();
    config.approver.skipWhenClean = true;
    const decisions = (id: string) => readEvents(app.dir, id).filter((e) => e.type === 'decision');
    // Round 1 of code and security, both reviewed and recorded, every AC proven, review → integrate → decide, then the gate check.
    const setup = (title: string, security: string, gate: boolean) => {
      const id = jobAt(app.dir, 'decide', { config, title }).id;
      updateJob(app.dir, id, (j) => {
        j.worktree = app.dir;
        j.round = 1;
        j.reviewers = ['code', 'security'];
        j.verdicts = { 1: { code: 'PASS', security } } as Job['verdicts'];
      });
      const review = ensureReviewDir(app.dir, id, 1);
      fs.writeFileSync(path.join(review, 'code.md'), 'VERDICT: PASS\n');
      fs.writeFileSync(path.join(review, 'security.md'), security === 'PASS' ? 'VERDICT: PASS\n' : `VERDICT: ${security}\n\n- [major] a.ts:1 — x\n`);
      const dir = jobDir(app.dir, id);
      fs.writeFileSync(path.join(dir, 'spec.md'), '# Clean job\n\n## Goal\nShip it.\n\n## Acceptance criteria\n- [ ] AC1 — works\n');
      fs.writeFileSync(path.join(dir, 'build.md'), '## Round 1\nChanges: the change\n\n| AC | Proof | Result |\n|---|---|---|\n| AC1 | `t.test.ts` | pass |\n');
      const side = (stage: string) => ({ stage, state: 'running', waitingOn: null });
      logEvent(app.dir, id, 'round', { round: 1 });
      logEvent(app.dir, id, 'transition', { from: side('review'), to: side('integrate') });
      logEvent(app.dir, id, 'transition', { from: side('integrate'), to: side('decide') });
      if (gate) logEvent(app.dir, id, 'gate', { reasons: [] });
      return id;
    };

    const id = setup('clean', 'PASS', true);
    const head = app.git('rev-parse', 'HEAD').toString().trim();
    const first = decision(app.dir, config, [id], { clean: true });
    assert.deepEqual(first, { decision: 'APPROVE', reason: null, autoMerge: false, head, clean: true, recorded: true });
    assert.deepEqual(parseDecision(app.dir, id), { decision: 'APPROVE', reason: null, autoMerge: false });
    assert.match(fs.readFileSync(path.join(jobDir(app.dir, id), 'pr.md'), 'utf8'), /^## Summary\n\*\*Clean job\.\*\* Ship it\.\n\n## Changes\n- the change\n/);
    assert.equal(loadJob(app.dir, id).decision, 'APPROVE');
    assert.deepEqual(decisions(id).map((e) => [e.clean, e.autoMerge, e.head]), [[true, false, head]]);
    // Once per review: a second call prints the record and logs nothing.
    assert.deepEqual(decision(app.dir, config, [id], { clean: true }), { ...first, recorded: false });
    assert.equal(decisions(id).length, 1);

    for (const [title, security, gate, why] of [
      ['security asked for changes', 'CHANGES', true, 'lens security did not pass'],
      ['no gate check', 'PASS', false, 'no gate check since the review'],
    ] as const) {
      const other = setup(title, security, gate);
      assert.throws(() => decision(app.dir, config, [other], { clean: true }), { message: `job ${other} is not a clean pass: ${why}` }, title);
      for (const f of ['decision.md', 'pr.md']) assert.equal(fs.existsSync(path.join(jobDir(app.dir, other), f)), false, `${title}: ${f}`);
      assert.equal(decisions(other).length, 0, title);
    }
  } finally {
    app.cleanup();
  }
});

test('forge job set cannot write agents: the run times the decision record keys on', () => {
  assert.throws(() => checkFieldKey('agents.approver.endedAt'), /--field agents is not settable; use forge job agent/);
});
