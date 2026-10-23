// hooks/write-guard.ts as Claude Code runs it: node on the file, the PreToolUse event on stdin, and
// a minimal env, against a scratch checkout with a job folder and a worktrees root beside it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOOK = path.resolve(import.meta.dirname, '..', '..', '..', 'hooks', 'write-guard.ts');

function scratch(t: any) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-guard-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const jobs = path.join(root, '.forge', 'jobs');
  const job = path.join(jobs, 'j1');
  const wtRoot = path.join(base, 'repo.worktrees');
  const wt = path.join(wtRoot, 'j1');
  for (const d of [path.join(job, '.lock'), path.join(root, '.forge', 'notes'), path.join(wt, 'a')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(job, 'job.json'), '{}\n');
  fs.writeFileSync(path.join(job, 'events.jsonl'), '');
  fs.writeFileSync(path.join(root, '.forge', 'notes', 'learnings.md'), 'x\n');
  const env = { PATH: process.env.PATH, FORGE_DAEMON: '1', FORGE_DAEMON_WRITE_ROOTS: JSON.stringify({ jobs, worktrees: [wtRoot] }) };
  return { base, root, jobs, job, wt, env };
}

function guard(event: unknown, env: Record<string, string | undefined>) {
  const r = spawnSync(process.execPath, [HOOK], { input: typeof event === 'string' ? event : JSON.stringify(event), env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

type S = ReturnType<typeof scratch>;
/** A row's tool call; `link` makes a symlink first, and a row whose link the OS refuses is skipped. */
interface Row {
  name: string;
  tool?: string;
  path: (s: S) => string;
  cwd?: (s: S) => string;
  link?: (s: S) => [target: string, at: string];
}

const write = (name: string, p: (s: S) => string, extra: Partial<Row> = {}): Row => ({ name, path: p, ...extra });

const REFUSED: Row[] = [
  write('learnings (Write)', (s) => path.join(s.root, '.forge', 'notes', 'learnings.md')),
  write('learnings (MultiEdit)', (s) => path.join(s.root, '.forge', 'notes', 'learnings.md'), { tool: 'MultiEdit' }),
  write('~/.ssh/config', () => path.join(os.homedir(), '.ssh', 'config')),
  // Claude Code expands a leading ~ to $HOME, so these land outside the roots whatever the cwd.
  write('a ~ path from the main checkout', () => '~/.ssh/config'),
  write('a ~ path from a worktree', () => '~/.ssh/config', { cwd: (s) => s.wt }),
  write('a ~ path from a job folder', () => '~/.ssh/config', { cwd: (s) => s.job }),
  write('a ~user path from a worktree', () => '~root/.ssh/config', { cwd: (s) => s.wt }),
  write('a worktree .git file', (s) => path.join(s.wt, '.git')),
  write('a .GIT directory in the worktree', (s) => path.join(s.wt, 'a', '.GIT', 'config')),
  write('a .git directory in a job folder', (s) => path.join(s.job, '.git', 'config')),
  write('job.json', (s) => path.join(s.job, 'job.json')),
  write('events.jsonl', (s) => path.join(s.job, 'events.jsonl')),
  write('JOB.JSON', (s) => path.join(s.job, 'JOB.JSON')),
  write('.lock/holder.json', (s) => path.join(s.job, '.lock', 'holder.json')),
  write('a job folder CLAUDE.md', (s) => path.join(s.job, 'CLAUDE.md')),
  write('a nested job folder claude.local.md', (s) => path.join(s.job, 'review', 'claude.local.md')),
  write('a file at the top of .forge/jobs', (s) => path.join(s.jobs, 'stray.json')),
  write('a .. segment in the worktree', (s) => `${s.wt}/a/../b.txt`),
  write('a worktree symlink to .forge/notes', (s) => path.join(s.wt, 'notes', 'learnings.md'), { link: (s) => [path.join(s.root, '.forge', 'notes'), path.join(s.wt, 'notes')] }),
  write('a job folder symlink to job.json', (s) => path.join(s.job, 'alias.json'), { link: (s) => [path.join(s.job, 'job.json'), path.join(s.job, 'alias.json')] }),
  write('a dangling worktree symlink pointing outside', (s) => path.join(s.wt, 'dangling'), { link: (s) => [path.join(s.base, 'gone', 'x'), path.join(s.wt, 'dangling')] }),
];

const ALLOWED: Row[] = [
  write('a new file in the worktree', (s) => path.join(s.wt, 'src', 'a.ts')),
  write('a relative path from the worktree', () => 'src/a.ts', { cwd: (s) => s.wt }),
  write('a notebook in the worktree', (s) => path.join(s.wt, 'n.ipynb'), { tool: 'NotebookEdit' }),
  write('git files that are not .git', (s) => path.join(s.wt, '.github', 'workflows', '.gitignore')),
  write('a review file in the job folder', (s) => path.join(s.job, 'review', 'round-1', 'code.md')),
];

function eventOf(row: Row, s: S) {
  const tool = row.tool ?? 'Write';
  const p = row.path(s);
  return { tool_name: tool, tool_input: tool === 'NotebookEdit' ? { notebook_path: p } : { file_path: p }, cwd: row.cwd?.(s) ?? s.root };
}

/** Makes the row's link; false (with the subtest skipped) where the OS can't. */
function linked(st: any, row: Row, s: S): boolean {
  if (!row.link) return true;
  const [target, at] = row.link(s);
  try {
    fs.symlinkSync(target, at);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
    st.skip('this OS refuses symlinks here');
    return false;
  }
}

test('the write guard confines a daemon session\'s writes', async (t) => {
  for (const [rows, status] of [[REFUSED, 2], [ALLOWED, 0]] as const) {
    for (const row of rows) {
      await t.test(row.name, (st) => {
        const s = scratch(st);
        if (!linked(st, row, s)) return;
        const r = guard(eventOf(row, s), s.env);
        assert.equal(r.status, status, `${row.name}: ${r.stderr}`);
        if (status === 2) assert.ok(r.stderr.includes(JSON.stringify(row.path(s))), `${row.name}: stderr names the path: ${r.stderr}`);
        else assert.equal(r.stderr, '', row.name);
      });
    }
  }
});

test('the write guard fails closed, and only in a daemon session', async (t) => {
  const s = scratch(t);
  const inWorktree = { tool_name: 'Write', tool_input: { file_path: path.join(s.wt, 'x.ts') }, cwd: s.wt };
  const closed: { name: string; event: unknown; env: Record<string, string | undefined> }[] = [
    { name: 'stdin that is not JSON', event: '{', env: s.env },
    { name: 'no file_path', event: { tool_name: 'Write', tool_input: {}, cwd: s.wt }, env: s.env },
    { name: 'no FORGE_DAEMON_WRITE_ROOTS', event: inWorktree, env: { ...s.env, FORGE_DAEMON_WRITE_ROOTS: undefined } },
    { name: 'FORGE_DAEMON_WRITE_ROOTS that is not JSON', event: inWorktree, env: { ...s.env, FORGE_DAEMON_WRITE_ROOTS: '{jobs' } },
    { name: 'FORGE_DAEMON_WRITE_ROOTS with a relative root', event: inWorktree, env: { ...s.env, FORGE_DAEMON_WRITE_ROOTS: JSON.stringify({ jobs: 'jobs', worktrees: [] }) } },
  ];
  for (const row of closed) {
    const r = guard(row.event, row.env);
    assert.equal(r.status, 2, row.name);
    assert.match(r.stderr, /^Blocked by Forge/, row.name);
  }
  assert.equal(guard(inWorktree, s.env).status, 0, 'the same call with valid roots is allowed');
  const human = { PATH: process.env.PATH };
  for (const row of [...REFUSED, ...ALLOWED]) {
    await t.test(`outside a daemon session: ${row.name}`, (st) => {
      const h = scratch(st);
      if (!linked(st, row, h)) return;
      assert.deepEqual(guard(eventOf(row, h), human), { status: 0, stdout: '', stderr: '' }, row.name);
    });
  }
});
