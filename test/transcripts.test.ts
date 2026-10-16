import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentTranscript, cachedActivity, claudeProjectsDir, lastActivity, openTranscript, ownerTranscript, projectSlug, transcriptProjectDirs } from '../lib/transcripts.ts';

const OWNER = '11111111-2222-4333-8444-555555555555';
const OLD = '66666666-7777-4888-8999-aaaaaaaaaaaa';

/** A scratch root (not realpath'd, so on macOS its realpath differs) and a projects dir beside it. */
function scratch() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-transcripts-'));
  const root = path.join(base, 'repo');
  fs.mkdirSync(root);
  const projects = path.join(base, 'claude', 'projects');
  fs.mkdirSync(projects, { recursive: true });
  const slugDir = path.join(projects, projectSlug(root));
  return { base, root, projects, slugDir, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

const job = (over: Record<string, any> = {}) => ({
  owner: { session: OWNER, host: 'h', since: '2026-10-15T00:00:00.000Z', heartbeat: '2026-10-15T00:00:00.000Z' },
  runs: [{ session: OLD, startedAt: '2026-10-14T00:00:00.000Z' }, { session: OWNER, startedAt: '2026-10-15T00:00:00.000Z' }],
  agents: { 'reviewer:code': { runs: 1, status: 'running', agentId: 'abc123' }, builder: { runs: 1, status: 'done', agentId: 'old999' } } as Record<string, any>,
  worktree: null as string | null,
  ...over,
});

function write(file: string, body = '{"type":"assistant"}\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

const assistant = (content: unknown[], timestamp = '2026-10-15T10:00:00.000Z') => JSON.stringify({ type: 'assistant', timestamp, message: { content } });

describe('transcripts', { concurrency: 4 }, () => {
  test("project dirs are this repo's slugs only", () => {
    const s = scratch();
    try {
      assert.equal(projectSlug('/Users/a.b/c_d e'), '-Users-a-b-c-d-e');
      assert.equal(claudeProjectsDir({ CLAUDE_CONFIG_DIR: '/cfg' }), path.resolve('/cfg', 'projects'));
      assert.equal(claudeProjectsDir({}), path.join(os.homedir(), '.claude', 'projects'));
      const wt = '/tmp/x.worktrees/153-job';
      const dirs = transcriptProjectDirs(s.root, { worktree: wt }, s.projects);
      const expected = [...new Set([s.root, fs.realpathSync(s.root), wt].map((p) => path.join(s.projects, projectSlug(p))))];
      assert.deepEqual(dirs, expected);
      for (const d of dirs) assert.equal(path.dirname(d), s.projects);
      assert.deepEqual(transcriptProjectDirs(s.root, { worktree: null }, s.projects), [...new Set([s.root, fs.realpathSync(s.root)].map((p) => path.join(s.projects, projectSlug(p))))]);
    } finally {
      s.cleanup();
    }
  });

  test('finds agent and owner transcripts by session', () => {
    const s = scratch();
    try {
      const agent = write(path.join(s.slugDir, OWNER, 'subagents', 'agent-abc123.jsonl'));
      const older = write(path.join(s.slugDir, OLD, 'subagents', 'agent-old999.jsonl'));
      const owner = write(path.join(s.slugDir, `${OWNER}.jsonl`));
      const j = job();
      assert.equal(agentTranscript(s.root, j, 'reviewer:code', { projects: s.projects })?.path, fs.realpathSync(agent));
      assert.equal(agentTranscript(s.root, j, 'builder', { projects: s.projects })?.path, fs.realpathSync(older), 'a past run session is tried');
      assert.equal(ownerTranscript(s.root, j, { projects: s.projects })?.path, fs.realpathSync(owner));
      assert.equal(agentTranscript(s.root, j, 'reviewer:none', { projects: s.projects }), null);
      assert.equal(agentTranscript(s.root, j, '__proto__', { projects: s.projects }), null);
      // The worktree's slug is tried too.
      const wt = path.join(s.base, 'wt');
      const inWt = write(path.join(s.projects, projectSlug(wt), OWNER, 'subagents', 'agent-wt1.jsonl'));
      const j2 = job({ worktree: wt, agents: { builder: { runs: 1, status: 'running', agentId: 'wt1' } } });
      assert.equal(agentTranscript(s.root, j2, 'builder', { projects: s.projects })?.path, fs.realpathSync(inWt));
    } finally {
      s.cleanup();
    }
  });

  test('never scans other project dirs', () => {
    const s = scratch();
    try {
      write(path.join(s.projects, '-some-other-repo', OWNER, 'subagents', 'agent-abc123.jsonl'));
      write(path.join(s.projects, '-some-other-repo', `${OWNER}.jsonl`));
      const j = job();
      assert.equal(agentTranscript(s.root, j, 'reviewer:code', { projects: s.projects }), null);
      assert.equal(ownerTranscript(s.root, j, { projects: s.projects }), null);
    } finally {
      s.cleanup();
    }
  });

  test('rejects traversal, symlinks and non-files', () => {
    const s = scratch();
    try {
      write(path.join(s.slugDir, OWNER, 'subagents', 'agent-abc123.jsonl'));
      write(path.join(s.slugDir, 'not-a-uuid.jsonl'));
      write(path.join(s.slugDir, 'not-a-uuid', 'subagents', 'agent-abc123.jsonl'));
      const opts = { projects: s.projects };
      // A session id that is not a uuid.
      const bad = job({ owner: { session: 'not-a-uuid' }, runs: [{ session: 'not-a-uuid' }] });
      assert.equal(ownerTranscript(s.root, bad, opts), null);
      assert.equal(agentTranscript(s.root, bad, 'reviewer:code', opts), null);
      // Agent ids with traversal.
      write(path.join(s.slugDir, OWNER, 'x.jsonl'));
      for (const id of ['../x', 'a/b', '', 'x'.repeat(101), '..']) assert.equal(agentTranscript(s.root, job({ agents: { r: { runs: 1, agentId: id } } }), 'r', opts), null, id);
      // A transcript symlinked to a file outside the projects dir.
      const outside = write(path.join(s.base, 'secret.jsonl'));
      fs.symlinkSync(outside, path.join(s.slugDir, OWNER, 'subagents', 'agent-link1.jsonl'));
      assert.equal(agentTranscript(s.root, job({ agents: { r: { runs: 1, agentId: 'link1' } } }), 'r', opts), null);
      // A symlink to another project's file is refused as well.
      const other = write(path.join(s.projects, '-other', OWNER, 'subagents', 'agent-link2.jsonl'));
      fs.symlinkSync(other, path.join(s.slugDir, OWNER, 'subagents', 'agent-link2.jsonl'));
      assert.equal(agentTranscript(s.root, job({ agents: { r: { runs: 1, agentId: 'link2' } } }), 'r', opts), null);
      // A project dir that is itself a symlink resolving elsewhere.
      const s2 = scratch();
      try {
        const elsewhere = path.join(s2.base, 'elsewhere');
        write(path.join(elsewhere, OWNER, 'subagents', 'agent-abc123.jsonl'));
        write(path.join(elsewhere, `${OWNER}.jsonl`));
        fs.symlinkSync(elsewhere, s2.slugDir);
        assert.equal(agentTranscript(s2.root, job(), 'reviewer:code', { projects: s2.projects }), null);
        assert.equal(ownerTranscript(s2.root, job(), { projects: s2.projects }), null);
      } finally {
        s2.cleanup();
      }
      // A FIFO and a directory in place of the file.
      execFileSync('mkfifo', [path.join(s.slugDir, OWNER, 'subagents', 'agent-fifo1.jsonl')]);
      assert.equal(agentTranscript(s.root, job({ agents: { r: { runs: 1, agentId: 'fifo1' } } }), 'r', opts), null);
      assert.equal(openTranscript(path.join(s.slugDir, OWNER, 'subagents', 'agent-fifo1.jsonl'), s.projects), null, 'opening a FIFO does not hang');
      fs.mkdirSync(path.join(s.slugDir, OWNER, 'subagents', 'agent-dir1.jsonl'));
      assert.equal(agentTranscript(s.root, job({ agents: { r: { runs: 1, agentId: 'dir1' } } }), 'r', opts), null);
      assert.equal(openTranscript(outside, s.projects), null, 'openTranscript confines to the projects dir');
    } finally {
      s.cleanup();
    }
  });

  test('lastActivity summarises the tail', () => {
    const s = scratch();
    try {
      const wt = '/work/repo.worktrees/153';
      const summarise = (body: string, opts: { worktree?: string; root?: string } = {}) => {
        const f = write(path.join(s.slugDir, 'x.jsonl'), body);
        const t = openTranscript(f, s.projects)!;
        try {
          return lastActivity(t.fd, t.size, opts);
        } finally {
          fs.closeSync(t.fd);
        }
      };
      const read = assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${wt}/lib/server.ts` } }]);
      assert.deepEqual(summarise(`${assistant([{ type: 'text', text: 'Looking' }])}\n${read}\n`, { worktree: wt }), { kind: 'tool', text: 'Read lib/server.ts', at: '2026-10-15T10:00:00.000Z' });
      // A tool result after the call doesn't hide it.
      assert.equal(summarise(`${read}\n{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"x"}]}}\n`, { worktree: wt })?.text, 'Read lib/server.ts');
      assert.equal(summarise(assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'npm test\n--more' } }]))?.text, 'Bash npm test');
      assert.equal(summarise(assistant([{ type: 'tool_use', name: 'Grep', input: { pattern: 'foo', path: '/x' } }]))?.text, 'Grep /x');
      const text = summarise(`${read}\n${assistant([{ type: 'text', text: '\n  All   checks\tpass.  \nSecond line' }])}\n`);
      assert.deepEqual(text, { kind: 'text', text: 'All checks pass.', at: '2026-10-15T10:00:00.000Z' });
      const long = summarise(assistant([{ type: 'text', text: 'word '.repeat(100) }]))!;
      assert.equal(long.text.length, 160);
      assert.ok(long.text.endsWith('…'));
      assert.equal(summarise(''), null);
      assert.equal(summarise('not json\n{"broken":\n'), null);
      assert.equal(summarise('{"type":"user","message":{"content":"hi"}}\n'), null);
      // Markup stays text: lastActivity returns it verbatim, and rendering escapes it.
      assert.equal(summarise(assistant([{ type: 'text', text: '<script>alert(1)</script>' }]))?.text, '<script>alert(1)</script>');

      // Only the last 64 KiB is read: a 5 MB transcript is summarised fast.
      const big = path.join(s.slugDir, 'big.jsonl');
      const filler = assistant([{ type: 'text', text: 'x'.repeat(2000) }]) + '\n';
      fs.writeFileSync(big, filler.repeat(Math.ceil((5.5 * 1024 * 1024) / filler.length)) + read + '\n');
      assert.ok(fs.statSync(big).size > 5 * 1024 * 1024);
      const t0 = performance.now();
      const t = openTranscript(big, s.projects)!;
      const got = lastActivity(t.fd, t.size, { worktree: wt });
      fs.closeSync(t.fd);
      const ms = performance.now() - t0;
      assert.equal(got?.text, 'Read lib/server.ts');
      assert.ok(ms < 50, `took ${ms} ms`);
      // The cached form gives the same answer and refuses a file outside the projects dir.
      assert.equal(cachedActivity(big, s.projects, { worktree: wt })?.text, 'Read lib/server.ts');
      assert.equal(cachedActivity(big, s.projects, { worktree: wt })?.text, 'Read lib/server.ts');
      assert.equal(cachedActivity(write(path.join(s.base, 'out.jsonl'), read), s.projects), null);
    } finally {
      s.cleanup();
    }
  });
});
