// A simulated orchestrator (issue #68): only `forge job step` decides each move. Spawns are played
// by writing each role's output files, runs execute `command`, and the job must reach done.
// Each test drives its own scratch repo, so they run side by side; the issue-link gate cases live in
// step-e2e-issue-link.test.ts, so the two halves also run as separate files.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { jobDir, loadJob, readEvents } from '../lib/jobs.ts';
import { assertAgents, drive, scratch, stagesOf } from './step-drive.ts';

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
