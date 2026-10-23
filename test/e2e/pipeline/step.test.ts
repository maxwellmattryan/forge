// A simulated orchestrator (issue #68): only `forge job step` decides each move. Spawns are played
// by writing each role's output files, runs execute `command`, and the job must reach done, or stop
// at the issue-link gates. Each test drives its own copy of drive.ts's template repo, so they run
// side by side.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { jobDir, loadJob, readEvents } from '#core/job/store.ts';
import { assertAgents, drive, play, scratch, stagesOf } from './drive.ts';
import { token } from '../../secret-fixtures.ts';

/** Every wait the job entered, in order: the `waitingOn` of each transition into `waiting`. */
function waitsOf(root: string, id: string): string[] {
  return (readEvents(root, id).filter((e) => e.type === 'transition') as any[]).filter((e) => e.to.state === 'waiting').map((e) => e.to.waitingOn);
}

describe('a job driven by step alone, and through the issue-link gates', { concurrency: 4 }, () => {
  test('a job runs to done on step alone', async () => {
    const s = await scratch();
    try {
      const { id } = await s.f('job', 'new', '--title', 'Add a hello script', '--body', 'Add hello.sh that prints hi.');
      const steps = { n: 0 };
      const seen: any[] = [];
      const last = await drive(s, id, steps, seen);
      assert.equal(last.action, 'done', JSON.stringify(last));
      assert.equal(last.state, 'done');
      assert.deepEqual(stagesOf(s.root, id), ['backlog', 'spec', 'build', 'verify', 'review', 'integrate', 'decide', 'pr', 'done']);
      assertAgents(s.root, id);
      assert.deepEqual(loadJob(s.root, id).reviewers, ['code', 'tests']);
      // The review panel goes out as one batch, and each lens is started exactly once.
      assert.equal(seen[0].role, 'reviewer:code');
      assert.deepEqual(seen[0].spawns.map((e: any) => e.role), ['reviewer:tests']);
      // This drive has one review round, so one start per lens in the whole log.
      const starts = readEvents(s.root, id).filter((e: any) => e.type === 'agent-start' && String(e.role).startsWith('reviewer:')).map((e: any) => e.role);
      assert.deepEqual(starts.sort(), ['reviewer:code', 'reviewer:tests']);
      assert.ok(steps.n < 60, `${steps.n} steps`);
    } finally {
      s.cleanup();
    }
  });

  test('a secret parks the job on human and approve re-verifies', async () => {
    const s = await scratch();
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
      assert.equal(r.out.ran[0].rule, 'SC1b');
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
      assert.deepEqual(r.out.ran.map((x: any) => x.rule), ['SC1b']);
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
      assert.deepEqual(stagesOf(s.root, id), ['backlog', 'spec', 'build', 'verify', 'review', 'integrate', 'decide', 'pr', 'done']);
      assertAgents(s.root, id);
      assert.ok(steps.n < 60, `${steps.n} steps`);
    } finally {
      s.cleanup();
    }
  });

  // The issue-link gates. In the same block as the tests above: two sequential blocks would wait
  // for the slowest of the first before any of these started.
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
      assert.ok(loadJob(s.root, id).issues[0]?.ref, 'linked to the new issue');
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
