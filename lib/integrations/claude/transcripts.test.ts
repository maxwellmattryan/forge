// Locating transcripts from job state: a role run's own session file at the job's worktree slug, and
// the refusals that keep a planted agentId or worktree from reaching another session's transcript.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentTranscript, agentTranscriptById, firstToolCallAt, projectSlug } from './transcripts.ts';

type Refs = Parameters<typeof agentTranscriptById>[1];

test('firstToolCallAt reads the head for the first tool call', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-head-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const T0 = Date.parse('2026-10-01T10:00:00.000Z');
  const line = (type: string, sec: number, content: unknown[]) => JSON.stringify({ type, timestamp: new Date(T0 + sec * 1000).toISOString(), message: { content } });
  const tool = (sec: number) => line('assistant', sec, [{ type: 'text', text: 'reading' }, { type: 'tool_use', id: 't', name: 'Read', input: {} }]);
  const at = (text: string, since = T0): number | null => {
    const file = path.join(dir, 'x.jsonl');
    fs.writeFileSync(file, text);
    const fd = fs.openSync(file, 'r');
    try {
      return firstToolCallAt(fd, fs.fstatSync(fd).size, since);
    } finally {
      fs.closeSync(fd);
    }
  };
  const head = [line('user', 0, [{ type: 'tool_use' }]), tool(-5), 'not json', line('assistant', 1, [{ type: 'text', text: 'hi' }])];
  assert.equal(at([...head, tool(3), tool(4)].join('\n') + '\n'), T0 + 3000, 'the first assistant tool call at or after the start');
  assert.equal(at(head.join('\n')), null, 'none');
  assert.equal(at(''), null, 'empty');
  // The head is read in 64 KiB chunks up to a 512 KiB cap: a tool call past the first chunk is found, even
  // when a multi-byte character straddles a chunk boundary; one past the cap is never read; and a last line
  // cut by the cap is dropped even when what fits still parses.
  const KiB = 1024;
  const CAP = 512 * KiB;
  const filler = (bytes: number) => line('user', 0, [{ type: 'text', text: 'x'.repeat(bytes) }]);
  assert.equal(at([filler(100 * KiB), tool(3)].join('\n')), T0 + 3000, 'past the first chunk, inside the cap');
  for (const shift of [0, 1]) {
    const wide = line('assistant', 3, [{ type: 'text', text: 'é'.repeat(30_000) }, { type: 'tool_use', id: 't', name: 'Read', input: {} }]);
    assert.equal(at([filler(100 * KiB + shift), wide].join('\n') + '\n'), T0 + 3000, `a character split across chunks (shift ${shift})`);
  }
  assert.equal(at([filler(CAP), tool(3)].join('\n')), null, 'past the cap');
  const room = CAP - 1 - tool(3).length - 10;
  const short = line('user', 0, [{ type: 'text', text: 'x'.repeat(room - line('user', 0, [{ type: 'text', text: '' }]).length) }]);
  assert.equal(at([short, tool(3) + ' '.repeat(100)].join('\n')), null, 'a cut last line');
  assert.equal(at([short, tool(3), 'x'.repeat(400)].join('\n')), T0 + 3000, 'a whole line inside the cap');
});

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
