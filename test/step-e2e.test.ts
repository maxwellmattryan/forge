// A simulated orchestrator (issue #68): only `forge job step` decides each move. Spawns are played
// by writing each role's output files, runs execute `command`, and the job must reach done.
// Each test drives its own scratch repo, so they run side by side; the issue-link gate cases live in
// step-e2e-issue-link.test.ts, so the two halves also run as separate files.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { jobDir, loadJob, readEvents } from '../lib/jobs.ts';
import { assertAgents, drive, play, scratch, stagesOf } from './step-drive.ts';
import { token } from './secret-fixtures.ts';

describe('a job driven by step alone', { concurrency: 4 }, () => {
  test('a job runs to done on step alone', async () => {
    const s = await scratch({ pipeline: { specApproval: 'never' } });
    try {
      const { id } = await s.f('job', 'new', '--title', 'Add a hello script', '--body', 'Add hello.sh that prints hi.');
      const steps = { n: 0 };
      const last = await drive(s, id, steps);
      assert.equal(last.action, 'done', JSON.stringify(last));
      assert.equal(last.state, 'done');
      assert.deepEqual(stagesOf(s.root, id), ['backlog', 'spec', 'build', 'verify', 'review', 'decide', 'integrate', 'pr', 'done']);
      assertAgents(s.root, id);
      assert.deepEqual(loadJob(s.root, id).reviewers, ['code', 'tests']);
      assert.ok(steps.n < 60, `${steps.n} steps`);
    } finally {
      s.cleanup();
    }
  });

  test('a secret parks the job on human and approve re-verifies', async () => {
    const s = await scratch({ pipeline: { specApproval: 'never' } });
    try {
      const { id } = await s.f('job', 'new', '--title', 'Add a hello script', '--body', 'Add hello.sh that prints hi.');
      const key = token.aws('e2e');
      // Step alone up to the builder; the builder also commits a key.
      for (let n = 0; ; n++) {
        assert.ok(n < 20, 'reached the builder');
        const a = await s.f('job', 'step', id);
        if (a.action === 'run') {
          await s.raw(...a.command);
          continue;
        }
        assert.equal(a.action, 'spawn', JSON.stringify(a));
        await s.f(...a.start);
        const summary = play(s, id, a);
        if (a.role === 'builder') {
          const wt = loadJob(s.root, id).worktree!;
          fs.writeFileSync(path.join(wt, 'creds.txt'), `aws ${key}\n`);
          execFileSync('git', ['add', '-A'], { cwd: wt });
          execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', 'add creds'], { cwd: wt });
        }
        await s.f('job', 'agent', id, 'end', '--role', a.role, '--summary', summary);
        if (a.role === 'builder') break;
      }
      await s.f('job', 'claim', id, '--session', 'S');
      const advance = async () => {
        const r = await s.raw('job', 'advance', id, '--session', 'S');
        return { status: r.status, out: JSON.parse(r.stdout) };
      };
      let r = await advance();
      assert.equal(r.status, 1, 'verify failed');
      assert.equal(r.out.ran.at(-1).rule, 'V1');
      r = await advance();
      assert.equal(r.out.action, 'wait', JSON.stringify(r.out));
      assert.equal(r.out.waitingOn, 'human');
      assert.equal(r.out.ran[0].rule, 'SC1');
      assert.match(r.out.tell, new RegExp(`^${id} stopped on a possible secret \\(secret scan blocked verify round 1\\)`));
      let job = loadJob(s.root, id);
      assert.deepEqual([job.stage, job.state, job.waitingOn, job.reason], ['verify', 'waiting', 'human', 'secret scan blocked verify round 1']);
      // Approving without removing the value parks it again: an approval never bypasses a finding.
      await s.f('job', 'human', id, 'approve');
      await s.f('job', 'set', id, '--state', 'running');
      r = await advance();
      assert.equal(r.status, 1, 'the scan ran again and failed');
      assert.deepEqual(r.out.ran.map((x: any) => x.rule), ['SC2']);
      r = await advance();
      assert.deepEqual(r.out.ran.map((x: any) => x.rule), ['SC1']);
      assert.equal(r.out.waitingOn, 'human', JSON.stringify(r.out));

      // The human rewrites the branch without the key, approves, and the next advance re-verifies.
      execFileSync('git', ['reset', '-q', '--hard', 'HEAD~1'], { cwd: loadJob(s.root, id).worktree! });
      await s.f('job', 'human', id, 'approve');
      await s.f('job', 'set', id, '--state', 'running');
      r = await advance();
      assert.equal(r.status, 0, JSON.stringify(r.out));
      assert.equal(r.out.ran[0].rule, 'SC2');
      job = loadJob(s.root, id);
      assert.equal(job.stage, 'review');
      assert.equal(job.verifyRuns.at(-1)!.ok, true);
      assert.ok(!fs.readFileSync(path.join(jobDir(s.root, id), 'events.jsonl'), 'utf8').includes(key));
    } finally {
      s.cleanup();
    }
  });

  test('a UI lens starts the dev server once and stops it once', async () => {
    const s = await scratch({
      pipeline: { specApproval: 'never' },
      commands: { build: 'true', lint: 'true', test: 'test -f hello.sh', dev: 'sleep 30' },
      review: { panel: [{ name: 'code', always: true }, { name: 'tests', always: true }, { name: 'ui', when: 'hello.sh' }] },
    });
    let id = '';
    try {
      id = (await s.f('job', 'new', '--title', 'Add a hello script', '--body', 'Add hello.sh that prints hi.')).id;
      const steps = { n: 0 };
      const last = await drive(s, id, steps);
      assert.equal(last.action, 'done', JSON.stringify(last));
      const job = loadJob(s.root, id);
      assert.deepEqual(job.reviewers, ['code', 'tests', 'ui']);
      assert.equal(job.agents['reviewer:ui']?.status, 'done');
      const events = readEvents(s.root, id);
      assert.equal(events.filter((e) => e.type === 'background-start').length, 1, 'started once');
      assert.equal(events.filter((e) => e.type === 'background-stop').length, 1, 'stopped once');
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(jobDir(s.root, id), 'runtime.json'), 'utf8')), {});
      assert.ok(steps.n < 60, `${steps.n} steps`);
    } finally {
      // A failed run must not leave the dev server behind.
      if (id) await s.raw('stop', id);
      s.cleanup();
    }
  });

  test('spec gate pauses and resumes', async () => {
    const s = await scratch({ pipeline: { specApproval: 'always' } });
    try {
      const { id } = await s.f('job', 'new', '--title', 'Add a hello script', '--body', 'Add hello.sh that prints hi.');
      const steps = { n: 0 };
      let last = await drive(s, id, steps);
      assert.equal(last.action, 'wait');
      assert.equal(last.waitingOn, 'spec-approval');
      assert.match(last.tell, /spec ready: .*spec\.md\. \/forge approve/);
      assert.deepEqual(await s.f('job', 'step', id), last, 'the gate holds');
      // reference/commands.md: approve on spec-approval; step, not the resume, moves it to build.
      await s.f('job', 'human', id, 'approve-spec', '--note', 'ok');
      await s.f('job', 'set', id, '--state', 'running');
      last = await drive(s, id, steps);
      assert.equal(last.action, 'done', JSON.stringify(last));
      assert.deepEqual(stagesOf(s.root, id), ['backlog', 'spec', 'build', 'verify', 'review', 'decide', 'integrate', 'pr', 'done']);
      assertAgents(s.root, id);
      assert.ok(steps.n < 60, `${steps.n} steps`);
    } finally {
      s.cleanup();
    }
  });
});
