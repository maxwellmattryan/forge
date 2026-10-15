// A simulated orchestrator (issue #68): only `forge job step` decides each move. Spawns are played
// by writing each role's output files, runs execute `command`, and the job must reach done.
// Each test drives its own scratch repo, so they run side by side.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, tempRepo } from './helpers.ts';
import { jobDir, loadJob, readEvents } from '../lib/jobs.ts';

async function scratch(answers: Record<string, unknown>) {
  const repo = tempRepo();
  const raw = (...args: string[]) => forgeAsync(repo.dir, args);
  const f = async (...args: string[]) => {
    const r = await raw(...args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}${r.stdout}`);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return r.stdout.trim();
    }
  };
  const answersFile = path.join(path.dirname(repo.dir), `answers-${path.basename(repo.dir)}.json`);
  fs.writeFileSync(
    answersFile,
    JSON.stringify({ tracker: { kind: 'none' }, pr: { enabled: false }, commands: { build: 'true', lint: 'true', test: 'test -f hello.sh' }, worktrees: { root: `../${path.basename(repo.dir)}.wt` }, ...answers }),
  );
  await f('init', 'write', '--answers', answersFile);
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
    fs.rmSync(answersFile, { force: true });
  };
  return { root: repo.dir, f, raw, cleanup };
}

type Scratch = Awaited<ReturnType<typeof scratch>>;

/** Plays one agent: writes what the role is contracted to write, then returns its reply line. */
function play(s: Scratch, id: string, a: any): string {
  const dir = jobDir(s.root, id);
  const job = loadJob(s.root, id);
  switch (a.role) {
    case 'spec-writer':
      fs.writeFileSync(
        path.join(dir, 'spec.md'),
        '# Add a hello script\n\nSize: S\nServices: -\nNeeds design: no\nSuggested reviewers: tests\n\n## Acceptance criteria\n- [ ] AC1: `hello.sh` exists · Proven by: verify\n\n## Approach\n- `hello.sh`\n\n## Tasks\n- [ ] write hello.sh\n',
      );
      return 'SPEC: done · size S · design no';
    case 'builder': {
      const wt = job.worktree!;
      fs.writeFileSync(path.join(wt, 'hello.sh'), 'echo hi\n');
      execFileSync('git', ['add', '-A'], { cwd: wt });
      execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', 'feat: hello'], { cwd: wt });
      fs.writeFileSync(path.join(dir, 'tasks.md'), '- [x] write hello.sh\n');
      fs.writeFileSync(path.join(dir, 'build.md'), `## Round ${job.round}\nChanges: hello.sh\n\n| AC | Proof | Result |\n|---|---|---|\n| AC1 | verify | pass |\n`);
      return 'BUILD: done · 1 commit · tasks 1/1 · tests pass';
    }
    case 'approver':
      fs.writeFileSync(path.join(dir, 'decision.md'), 'APPROVE: small and verified\nAuto-merge eligible: no\n');
      fs.writeFileSync(path.join(dir, 'pr.md'), 'Adds hello.sh.\n');
      return 'APPROVE';
    default:
      if (String(a.role).startsWith('reviewer:')) {
        fs.writeFileSync(a.output, 'VERDICT: PASS\n\nNo findings.\n');
        return 'VERDICT: PASS';
      }
      throw new Error(`no player for ${a.role}`);
  }
}

/** Drives the job with step alone until done or a human gate; returns the last action and the step count. */
async function drive(s: Scratch, id: string, steps: { n: number }): Promise<any> {
  const pending: any[] = [];
  const finish = async (a: any) => {
    const summary = play(s, id, a);
    await s.f('job', 'agent', id, 'end', '--role', a.role, '--summary', summary, '--tokens', '100', '--tool-uses', '1', '--duration-ms', '1000');
  };
  while (steps.n < 60) {
    steps.n++;
    const a = await s.f('job', 'step', id);
    if (a.action === 'spawn') {
      await s.f(...a.start);
      // Parallel spawns are left running, as a session would, until step says to wait on them.
      if (a.parallel) pending.push(a);
      else await finish(a);
      continue;
    }
    if (a.action === 'wait' && a.waitingOn === 'agents') {
      assert.ok(pending.length, `waiting on agents nobody started: ${JSON.stringify(a)}`);
      for (const p of pending.splice(0)) await finish(p);
      continue;
    }
    if (a.action === 'run') {
      const r = await s.raw(...a.command);
      if (r.status !== 0) {
        const again = await s.f('job', 'step', id);
        assert.notDeepEqual(again, a, `${a.shell} failed and step repeated it: ${r.stderr}${r.stdout}`);
      }
      continue;
    }
    return a;
  }
  assert.fail(`no end after ${steps.n} steps`);
}

function stagesOf(root: string, id: string): string[] {
  const t = readEvents(root, id).filter((e) => e.type === 'transition') as any[];
  const out = [t[0].from.stage];
  for (const e of t) if (e.to.stage !== out.at(-1)) out.push(e.to.stage);
  return out;
}

function assertAgents(root: string, id: string) {
  const job = loadJob(root, id);
  for (const role of ['spec-writer', 'builder', 'reviewer:code', 'reviewer:tests', 'approver']) {
    assert.equal(job.agents[role]?.status, 'done', `${role} ran`);
    assert.notEqual(job.agents[role]?.outputMissing, true, `${role} wrote its output`);
  }
}

/** Every wait the job entered, in order: the `waitingOn` of each transition into `waiting`. */
function waitsOf(root: string, id: string): string[] {
  return (readEvents(root, id).filter((e) => e.type === 'transition') as any[]).filter((e) => e.to.state === 'waiting').map((e) => e.to.waitingOn);
}

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
      assert.deepEqual(stagesOf(s.root, id), ['backlog', 'spec', 'build', 'verify', 'review', 'decide', 'integrate', 'pr', 'done']);
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
      assert.deepEqual(stagesOf(s.root, id), ['backlog', 'spec', 'build', 'verify', 'review', 'decide', 'integrate', 'pr', 'done']);
      assert.deepEqual(waitsOf(s.root, id), ['spec-approval', 'issue-link']);
      assertAgents(s.root, id);
    } finally {
      s.cleanup();
    }
  });
});
