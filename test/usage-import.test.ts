import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import { createJob, jobDir, loadJob } from '../lib/jobs.ts';
import { JOB_SCHEMA_VERSION } from '../lib/schema.ts';
import { importClaudeCodeTranscript } from '../lib/usage.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const FIXTURE = path.resolve(import.meta.dirname, 'fixtures', 'transcript-resumed.jsonl');
const AGENT = 'a1b2c3d4';

// The fixture is one builder transcript: round 1, then the SendMessage resume appended to it.
const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);
const resumeAt = lines.findIndex((l) => l.includes('Rework round 2'));
const round1 = lines.slice(0, resumeAt).join('\n') + '\n';
const round2 = lines.slice(resumeAt).join('\n') + '\n';
const round1End = JSON.parse(lines[resumeAt - 1]).timestamp;

/** A fake ~/.claude/projects holding agent-<AGENT>.jsonl with `body`; returns the projects dir and the file. */
function projects(body: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-home-'));
  const dir = path.join(home, '.claude', 'projects', '-scratch', 'session-1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agent-${AGENT}.jsonl`);
  fs.writeFileSync(file, body);
  return { home, dir: path.join(home, '.claude', 'projects'), file };
}

const counts = (u) => ({ input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, totalTokens: u.totalTokens, toolUses: u.toolUses, durationMs: u.durationMs });

test('a resumed transcript imports only what follows the cursor', () => {
  const full = projects(round1 + round2);
  const only1 = projects(round1);
  const only2 = projects(round2);
  try {
    const all = importClaudeCodeTranscript(AGENT, { projectsDir: full.dir })!;
    const first = importClaudeCodeTranscript(AGENT, { projectsDir: only1.dir })!;
    const second = importClaudeCodeTranscript(AGENT, { projectsDir: full.dir, since: first.through })!;
    assert.equal(first.through, round1End);
    assert.equal(second.through, JSON.parse(lines.at(-1)!).timestamp);
    assert.deepEqual(counts(second), counts(importClaudeCodeTranscript(AGENT, { projectsDir: only2.dir })!), 'second import counts round 2 alone');
    assert.deepEqual({ input: second.input, cacheRead: second.cacheRead, cacheWrite: second.cacheWrite, toolUses: second.toolUses }, { input: 25, cacheRead: 3200, cacheWrite: 310, toolUses: 1 });
    assert.equal(second.durationMs, 90_000, 'the resume prompt to the last line, not the whole file');
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'toolUses'] as const) assert.equal(first[k] + second[k], all[k], k);

    const none = importClaudeCodeTranscript(AGENT, { projectsDir: full.dir, since: second.through })!;
    assert.deepEqual(counts(none), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, toolUses: 0, durationMs: 0 });
    assert.equal(none.through, second.through);
  } finally {
    for (const p of [full, only1, only2]) fs.rmSync(p.home, { recursive: true, force: true });
  }
});

test('forge job agent end --import records only the resumed round', () => {
  const repo = tempRepo();
  const home = projects(round1);
  const f = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: repo.dir, HOME: home.home } }));
  try {
    const answers = path.join(home.home, 'answers.json');
    fs.writeFileSync(answers, '{}');
    f('init', 'write', '--answers', answers);
    const { id } = f('job', 'new', '--title', 'Resumed builder');
    const end = () => f('job', 'agent', id, 'end', '--role', 'builder', '--agent-id', AGENT, '--import');

    f('job', 'agent', id, 'start', '--role', 'builder', '--model', 'opus');
    const r1 = end();
    assert.equal(r1.usage.since, undefined);
    assert.equal(loadJob(repo.dir, id).agents.builder.importedThrough?.[AGENT], round1End);

    fs.appendFileSync(home.file, round2);
    f('job', 'agent', id, 'start', '--role', 'builder', '--model', 'opus');
    const r2 = end();
    assert.equal(r2.usage.since, round1End);

    const all = importClaudeCodeTranscript(AGENT, { projectsDir: home.dir })!;
    const job = loadJob(repo.dir, id);
    assert.equal(r1.usage.tokens + r2.usage.tokens, all.totalTokens);
    assert.equal(job.usage.totalTokens, all.totalTokens, 'round 1 is not counted twice');
    assert.equal(job.usage.byRole.builder.runs, 2);
    assert.equal(job.usage.byRole.builder.durationMs, 60_000 + 90_000);
    assert.equal(job.agents.builder.importedThrough?.[AGENT], JSON.parse(lines.at(-1)!).timestamp);
  } finally {
    repo.cleanup();
    fs.rmSync(home.home, { recursive: true, force: true });
  }
});

test('v3 jobs gain an import cursor at each ended agent', () => {
  const repo = tempRepo();
  try {
    const job = createJob(repo.dir, defaults(), { title: 'Old' });
    const file = path.join(jobDir(repo.dir, job.id), 'job.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.schemaVersion = 3;
    raw.agents = {
      builder: { runs: 1, status: 'done', agentId: AGENT, endedAt: '2026-10-01T10:02:00.000Z' },
      'reviewer:code': { runs: 1, status: 'running', agentId: null, endedAt: null },
    };
    fs.writeFileSync(file, JSON.stringify(raw));
    const loaded = loadJob(repo.dir, job.id);
    assert.equal(loaded.schemaVersion, JOB_SCHEMA_VERSION);
    assert.deepEqual(loaded.agents.builder.importedThrough, { [AGENT]: '2026-10-01T10:02:00.000Z' });
    assert.equal(loaded.agents['reviewer:code'].importedThrough, undefined);
  } finally {
    repo.cleanup();
  }
});
