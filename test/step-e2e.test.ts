// A simulated orchestrator (issue #68): only `forge job step` decides each move. Spawns are played
// by writing each role's output files, runs execute `command`, and the job must reach done.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { jobDir, loadJob, readEvents } from '../lib/jobs.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

function scratch(answers: Record<string, unknown>) {
  const repo = tempRepo();
  const env = { ...process.env, FORGE_ROOT: repo.dir };
  const raw = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env });
  const f = (...args: string[]) => {
    const r = raw(...args);
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
  f('init', 'write', '--answers', answersFile);
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
    fs.rmSync(answersFile, { force: true });
  };
  return { root: repo.dir, f, raw, cleanup };
}

type Scratch = ReturnType<typeof scratch>;

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
function drive(s: Scratch, id: string, steps: { n: number }): any {
  const pending: any[] = [];
  const finish = (a: any) => {
    const summary = play(s, id, a);
    s.f('job', 'agent', id, 'end', '--role', a.role, '--summary', summary, '--tokens', '100', '--tool-uses', '1', '--duration-ms', '1000');
  };
  while (steps.n < 60) {
    steps.n++;
    const a = s.f('job', 'step', id);
    if (a.action === 'spawn') {
      s.f(...a.start);
      // Parallel spawns are left running, as a session would, until step says to wait on them.
      if (a.parallel) pending.push(a);
      else finish(a);
      continue;
    }
    if (a.action === 'wait' && a.waitingOn === 'agents') {
      assert.ok(pending.length, `waiting on agents nobody started: ${JSON.stringify(a)}`);
      for (const p of pending.splice(0)) finish(p);
      continue;
    }
    if (a.action === 'run') {
      const r = s.raw(...a.command);
      if (r.status !== 0) {
        const again = s.f('job', 'step', id);
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

test('a job runs to done on step alone', () => {
  const s = scratch({ pipeline: { specApproval: 'never' } });
  try {
    const { id } = s.f('job', 'new', '--title', 'Add a hello script', '--body', 'Add hello.sh that prints hi.');
    const steps = { n: 0 };
    const last = drive(s, id, steps);
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

test('a UI lens starts the dev server once and stops it once', () => {
  const s = scratch({
    pipeline: { specApproval: 'never' },
    commands: { build: 'true', lint: 'true', test: 'test -f hello.sh', dev: 'sleep 30' },
    review: { panel: [{ name: 'code', always: true }, { name: 'tests', always: true }, { name: 'ui', when: 'hello.sh' }] },
  });
  let id = '';
  try {
    id = s.f('job', 'new', '--title', 'Add a hello script', '--body', 'Add hello.sh that prints hi.').id;
    const steps = { n: 0 };
    const last = drive(s, id, steps);
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
    if (id) s.raw('stop', id);
    s.cleanup();
  }
});

test('spec gate pauses and resumes', () => {
  const s = scratch({ pipeline: { specApproval: 'always' } });
  try {
    const { id } = s.f('job', 'new', '--title', 'Add a hello script', '--body', 'Add hello.sh that prints hi.');
    const steps = { n: 0 };
    let last = drive(s, id, steps);
    assert.equal(last.action, 'wait');
    assert.equal(last.waitingOn, 'spec-approval');
    assert.match(last.tell, /spec ready: .*spec\.md\. \/forge approve/);
    assert.deepEqual(s.f('job', 'step', id), last, 'the gate holds');
    // reference/commands.md: approve on spec-approval.
    s.f('job', 'human', id, 'approve-spec', '--note', 'ok');
    s.f('job', 'set', id, '--stage', 'build', '--state', 'running');
    last = drive(s, id, steps);
    assert.equal(last.action, 'done', JSON.stringify(last));
    assert.deepEqual(stagesOf(s.root, id), ['backlog', 'spec', 'build', 'verify', 'review', 'decide', 'integrate', 'pr', 'done']);
    assertAgents(s.root, id);
    assert.ok(steps.n < 60, `${steps.n} steps`);
  } finally {
    s.cleanup();
  }
});
