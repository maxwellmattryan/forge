// The simulated orchestrator of step-e2e.test.ts at the issue-link gates: an unlinked job links at
// the spec gate, or parks before build until it is linked. Each test drives its own scratch repo.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { jobDir, loadJob, readEvents } from '../lib/jobs.ts';
import { assertAgents, drive, scratch, stagesOf } from './step-drive.ts';

/** Every wait the job entered, in order: the `waitingOn` of each transition into `waiting`. */
function waitsOf(root: string, id: string): string[] {
  return (readEvents(root, id).filter((e) => e.type === 'transition') as any[]).filter((e) => e.to.state === 'waiting').map((e) => e.to.waitingOn);
}

describe('a job driven by step alone through the issue-link gates', { concurrency: 4 }, () => {
  test('one visit: an unlinked job links at the spec gate', async () => {
    const s = await scratch({ tracker: { kind: 'local' }, pipeline: { specApproval: 'always' } });
    try {
      const { id } = await s.f('job', 'new', '--title', 'Add a hello script', '--body', 'Add hello.sh that prints hi.');
      const steps = { n: 0 };
      let last = await drive(s, id, steps);
      assert.equal(last.action, 'wait');
      assert.equal(last.waitingOn, 'spec-approval');
      assert.deepEqual(waitsOf(s.root, id), ['spec-approval'], 'no issue-link wait before the spec gate');
      assert.equal(loadJob(s.root, id).reason, 'spec ready, issue unlinked');
      const lines = last.tell.split('\n');
      assert.equal(lines.length, 2);
      assert.match(lines[0], /spec ready: .*spec\.md\. \/forge approve/);
      assert.equal(lines[1], `${id} needs an issue: candidates in ${path.join(jobDir(s.root, id), 'issue-candidates.md')} (untrusted). /forge approve ${id} <ref> | new | none [reason]`);
      // reference/commands.md: `/forge approve <id> none <reason>` on an unlinked spec gate.
      const r = await s.f('job', 'human', id, 'approve-spec', '--link', 'none', '--reason', 'tiny', '--note', 'ok');
      assert.equal(r.link.noIssue.reason, 'tiny');
      await s.f('job', 'set', id, '--state', 'running');
      last = await drive(s, id, steps);
      assert.equal(last.action, 'done', JSON.stringify(last));
      assert.deepEqual(stagesOf(s.root, id), ['backlog', 'spec', 'build', 'verify', 'review', 'integrate', 'decide', 'pr', 'done']);
      assert.deepEqual(waitsOf(s.root, id), ['spec-approval']);
      assertAgents(s.root, id);
      assert.ok(steps.n < 60, `${steps.n} steps`);
    } finally {
      s.cleanup();
    }
  });

  test('a spec approved without an issue parks before build', async () => {
    const s = await scratch({ tracker: { kind: 'local' }, pipeline: { specApproval: 'always' } });
    try {
      const { id } = await s.f('job', 'new', '--title', 'Add a hello script', '--body', 'Add hello.sh that prints hi.');
      const steps = { n: 0 };
      let last = await drive(s, id, steps);
      assert.equal(last.waitingOn, 'spec-approval');
      await s.f('job', 'human', id, 'approve-spec', '--note', 'ok');
      await s.f('job', 'set', id, '--state', 'running');
      last = await drive(s, id, steps);
      assert.equal(last.action, 'wait');
      assert.equal(last.waitingOn, 'issue-link');
      const job = loadJob(s.root, id);
      assert.deepEqual([job.stage, job.reason], ['spec', 'link an issue before build']);
      assert.ok(!job.agents.builder, 'the builder never started');
      await s.f('job', 'human', id, 'approve', '--link', 'new');
      assert.ok(loadJob(s.root, id).source?.ref, 'linked to the new issue');
      await s.f('job', 'set', id, '--state', 'running');
      last = await drive(s, id, steps);
      assert.equal(last.action, 'done', JSON.stringify(last));
      assert.deepEqual(stagesOf(s.root, id), ['backlog', 'spec', 'build', 'verify', 'review', 'integrate', 'decide', 'pr', 'done']);
      assert.deepEqual(waitsOf(s.root, id), ['spec-approval', 'issue-link']);
      assertAgents(s.root, id);
    } finally {
      s.cleanup();
    }
  });
});
