import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempRepo } from './helpers.mjs';
import { readEvents } from '../lib/jobs.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

test('forge job verdicts --round integration: mini review without touching job.json verdicts', () => {
  const repo = tempRepo();
  const env = { ...process.env, FORGE_ROOT: repo.dir };
  const f = (...args) => {
    const out = execFileSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env, stdio: 'pipe' });
    try {
      return JSON.parse(out);
    } catch {
      return out.trim();
    }
  };
  /** Runs a command expected to fail and returns its stderr. */
  const fails = (...args) => {
    try {
      execFileSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env, stdio: 'pipe' });
    } catch (e) {
      assert.notEqual(e.status, 0);
      return String(e.stderr) + String(e.stdout);
    }
    assert.fail(`expected failure: ${args.join(' ')}`);
  };
  try {
    const answers = path.join(repo.dir, '..', `answers-${path.basename(repo.dir)}.json`);
    fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' } }));
    f('init', 'write', '--answers', answers);
    fs.rmSync(answers, { force: true });
    const job = f('job', 'new', '--title', 'Integration review');
    const id = job.id;
    f('job', 'set', id, '--field', 'reviewers=["code","tests"]');
    f('job', 'round', id);
    const jobFile = path.join(repo.dir, '.forge', 'jobs', id, 'job.json');
    const snapshot = () => {
      const j = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
      return { verdicts: j.verdicts, round: j.round };
    };
    const before = snapshot();
    const integrationEvents = () => readEvents(repo.dir, id).filter((e) => e.type === 'integration-review');

    const paths = f('job', 'paths', id);
    const reviewFile = path.join(paths.jobDir, 'review', 'integration', 'code.md');
    assert.equal(paths.integrationReview, reviewFile);

    let v = f('job', 'verdicts', id, '--round', 'integration', '--compact');
    assert.equal(v.complete, false);
    assert.equal(v.outcome, 'PENDING');
    assert.equal(integrationEvents().length, 0, 'a pending review logs nothing');

    fs.mkdirSync(path.dirname(reviewFile), { recursive: true });
    fs.writeFileSync(reviewFile, 'VERDICT: PASS\n\n- [nit] tidy\n');
    v = f('job', 'verdicts', id, '--round', 'integration', '--compact');
    assert.equal(v.round, 'integration');
    assert.equal(v.complete, true);
    assert.equal(v.outcome, 'PASS');
    assert.deepEqual(v.reviewers, { code: 'PASS' }, 'defaults to the code lens, not job.reviewers');
    assert.ok('sha' in v);
    let events = integrationEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, 'PASS');
    assert.deepEqual(events[0].reviewers, { code: 'PASS' });

    fs.writeFileSync(reviewFile, 'VERDICT: CHANGES\n\n- [blocker] lost the base-side null check\n');
    v = f('job', 'verdicts', id, '--round', 'integration', '--compact');
    assert.equal(v.outcome, 'CHANGES');
    assert.equal(v.reviewers.code, 'CHANGES(1)');

    fs.writeFileSync(reviewFile, 'resolution looks fine\n');
    v = f('job', 'verdicts', id, '--round', 'integration', '--compact');
    assert.equal(v.outcome, 'MALFORMED');
    v = f('job', 'verdicts', id, '--round', 'integration', '--compact', '--malformed', 'changes');
    assert.equal(v.outcome, 'CHANGES');
    events = readEvents(repo.dir, id);
    assert.equal(events.filter((e) => e.type === 'integration-review').at(-1).coerced[0], 'code');
    assert.ok(events.some((e) => e.type === 'note' && /^integration review: malformed review\(s\) from code counted as CHANGES/.test(e.text)));
    assert.equal(events.filter((e) => e.type === 'verdicts').length, 0, 'integration reviews never log numbered-round verdicts');

    assert.deepEqual(snapshot(), before, 'job.json verdicts and round are untouched');

    for (const bad of ['0', 'abc', '1.5']) assert.match(fails('job', 'verdicts', id, '--round', bad), /--round must be a positive integer or "integration"/);

    const roundDir = path.join(paths.jobDir, 'review', 'round-1');
    fs.mkdirSync(roundDir, { recursive: true });
    fs.writeFileSync(path.join(roundDir, 'code.md'), 'VERDICT: PASS\n');
    fs.writeFileSync(path.join(roundDir, 'tests.md'), 'VERDICT: PASS\n');
    v = f('job', 'verdicts', id, '--compact');
    assert.deepEqual({ round: v.round, outcome: v.outcome, reviewers: v.reviewers }, { round: 1, outcome: 'PASS', reviewers: { code: 'PASS', tests: 'PASS' } });
    assert.deepEqual(snapshot().verdicts, { 1: { code: 'PASS', tests: 'PASS' } }, 'numbered rounds still record job.verdicts');
    assert.equal(f('job', 'verdicts', id, '--round', '2', '--compact').outcome, 'PENDING');
  } finally {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.worktrees`, { recursive: true, force: true });
  }
});
