// The simulated orchestrator the step end-to-end suite uses (issue #68): only `forge job step`
// decides each move, spawns are played by writing each role's output files, and runs execute `command`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, forgeSync, repoTemplate } from '../../helpers.ts';
import { jobDir, loadJob, readEvents } from '../../../lib/jobs.ts';

/** What every scratch repo is initialised with; a test's own answers replace these keys whole. */
const BASE = {
  tracker: { kind: 'none' },
  pr: { enabled: false },
  commands: { build: 'true', lint: 'true', test: 'test -f hello.sh' },
  worktrees: { root: '../{repo}.wt' },
  pipeline: { specApproval: 'never' },
};

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify(BASE));
  const r = forgeSync(dir, ['init', 'write', '--answers', answers]);
  if (r.status !== 0) throw new Error(`forge init write exited ${r.status}: ${r.stderr}${r.stdout}`);
  fs.rmSync(answers);
});

/** A copy of the initialised template; `answers` (merged over BASE) re-initialise it with `init write --force`. */
export async function scratch(answers: Record<string, unknown> = {}) {
  const repo = template();
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
  const answersFile = `${repo.dir}.answers.json`;
  if (Object.keys(answers).length) {
    fs.writeFileSync(answersFile, JSON.stringify({ ...BASE, ...answers }));
    await f('init', 'write', '--force', '--answers', answersFile);
  }
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
    fs.rmSync(answersFile, { force: true });
  };
  return { root: repo.dir, f, raw, cleanup };
}

export type Scratch = Awaited<ReturnType<typeof scratch>>;

/** Plays one agent: writes what the role is contracted to write, then returns its reply line. */
export function play(s: Scratch, id: string, a: any): string {
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

/** Drives the job with step alone until done or a human gate; returns the last action and the step count. Every RV4 action is pushed onto `seen`. */
export async function drive(s: Scratch, id: string, steps: { n: number }, seen: any[] = []): Promise<any> {
  const pending: any[] = [];
  const finish = async (a: any) => {
    const summary = play(s, id, a);
    await s.f('job', 'agent', id, 'end', '--role', a.role, '--summary', summary, '--tokens', '100', '--tool-uses', '1', '--duration-ms', '1000');
  };
  while (steps.n < 60) {
    steps.n++;
    const a = await s.f('job', 'step', id);
    if (a.action === 'spawn') {
      if (a.rule === 'RV4') seen.push(a);
      // A batch (RV4 `spawns`) is started together, as a session launches it in one message.
      for (const one of [a, ...(a.spawns ?? [])]) await s.f(...one.start);
      // Parallel spawns are left running, as a session would, until step says to wait on them.
      if (a.parallel) pending.push(a, ...(a.spawns ?? []));
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

export function stagesOf(root: string, id: string): string[] {
  const t = readEvents(root, id).filter((e) => e.type === 'transition') as any[];
  const out = [t[0].from.stage];
  for (const e of t) if (e.to.stage !== out.at(-1)) out.push(e.to.stage);
  return out;
}

export function assertAgents(root: string, id: string) {
  const job = loadJob(root, id);
  for (const role of ['spec-writer', 'builder', 'reviewer:code', 'reviewer:tests', 'approver']) {
    assert.equal(job.agents[role]?.status, 'done', `${role} ran`);
    assert.notEqual(job.agents[role]?.outputMissing, true, `${role} wrote its output`);
  }
}
