// Locating transcripts from job state: a role run's own session file at the job's worktree slug, and
// the refusals that keep a planted agentId or worktree from reaching another session's transcript.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentTranscript, agentTranscriptById, projectSlug } from './transcripts.ts';

type Refs = Parameters<typeof agentTranscriptById>[1];

test("a role run's session transcript is found only under the job's own worktree", (t) => {
  // The worktree is reached through a link, so its given and its real path always differ.
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-transcripts-')));
  t.after(() => fs.rmSync(real, { recursive: true, force: true }));
  fs.mkdirSync(path.join(real, 'base'));
  fs.symlinkSync(path.join(real, 'base'), path.join(real, 'link'));
  const root = path.join(real, 'link', 'repo');
  const worktrees = path.join(real, 'link', 'repo.worktrees');
  const wt = path.join(worktrees, 'J1');
  const wtReal = path.join(real, 'base', 'repo.worktrees', 'J1');
  fs.mkdirSync(wt, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  const projects = path.join(real, 'projects');
  fs.mkdirSync(projects);
  const id = '33333333-3333-4333-8333-333333333333';
  const driver = '44444444-4444-4444-8444-444444444444';
  const job = (o: Partial<Refs> = {}): Refs => ({ id: 'J1', worktree: wt, lease: { driver } as Refs['lease'], runs: [], agents: {}, ...o }) as Refs;
  const opts = { projects, worktrees };
  const slugDir = (cwd: string) => path.join(projects, projectSlug(cwd));
  const plant = (cwd: string, name = `${id}.jsonl`) => {
    fs.mkdirSync(slugDir(cwd), { recursive: true });
    fs.writeFileSync(path.join(slugDir(cwd), name), '{}\n');
    return fs.realpathSync(path.join(slugDir(cwd), name));
  };
  const reset = () => {
    for (const e of fs.readdirSync(projects)) fs.rmSync(path.join(projects, e), { recursive: true, force: true });
  };

  // Found at the worktree's slug, as given and as resolved, and through the role's record.
  const given = plant(wt);
  assert.equal(agentTranscriptById(root, job(), id, opts)?.path, given, 'the given path');
  assert.equal(agentTranscript(root, job({ agents: { verifier: { agentId: id } } as unknown as Refs['agents'] }), 'verifier', opts)?.path, given, "the role's agentId");
  reset();
  const resolved = plant(wtReal);
  assert.equal(agentTranscriptById(root, job(), id, opts)?.path, resolved, 'the real path');
  reset();

  const nulls: { name: string; setup: () => void; job?: Refs; id?: string }[] = [
    { name: 'an id that is not a uuid', setup: () => plant(wt, 'abc123.jsonl'), id: 'abc123' },
    { name: "a file only under the root's slug dir", setup: () => (plant(root), plant(fs.realpathSync(root))) },
    {
      name: 'a worktree outside the worktrees root',
      setup: () => {
        fs.mkdirSync(path.join(real, 'elsewhere', 'J1'), { recursive: true });
        plant(path.join(real, 'elsewhere', 'J1'));
      },
      job: job({ worktree: path.join(real, 'elsewhere', 'J1') }),
    },
    {
      name: 'a slug dir that is a link',
      setup: () => {
        fs.mkdirSync(path.join(real, 'decoy'), { recursive: true });
        fs.writeFileSync(path.join(real, 'decoy', `${id}.jsonl`), '{}\n');
        fs.symlinkSync(path.join(real, 'decoy'), slugDir(wt));
      },
    },
    {
      name: 'a file that links outside its slug dir',
      setup: () => {
        fs.writeFileSync(path.join(real, 'outside.jsonl'), '{}\n');
        fs.mkdirSync(slugDir(wt), { recursive: true });
        fs.symlinkSync(path.join(real, 'outside.jsonl'), path.join(slugDir(wt), `${id}.jsonl`));
      },
    },
  ];
  for (const row of nulls) {
    row.setup();
    assert.equal(agentTranscriptById(root, row.job ?? job(), row.id ?? id, opts), null, row.name);
    reset();
  }

  // The subagent lookup under the job's sessions is unchanged.
  fs.mkdirSync(path.join(slugDir(root), driver, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(slugDir(root), driver, 'subagents', 'agent-a1b2.jsonl'), '{}\n');
  assert.equal(agentTranscriptById(root, job(), 'a1b2', opts)?.path, fs.realpathSync(path.join(slugDir(root), driver, 'subagents', 'agent-a1b2.jsonl')), 'a subagent');
});
