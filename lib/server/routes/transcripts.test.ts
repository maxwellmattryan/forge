// roundAgents: the job detail's agent rows, each with every ended run of its role and their total tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { jobFiles, stateFile } from '#core/paths.ts';
import { EVENT_SCHEMA_VERSION } from '#core/job/schema.ts';
import { JOB_STEPS } from '#core/versions/job.ts';
import { createJob, loadJob, readEvents, recordAgent } from '#core/job/store.ts';
import { roundAgents } from './transcripts.ts';

test('round agents list every run of the role and total them', (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-projects-'));
  t.after(() => fs.rmSync(projects, { recursive: true, force: true }));
  const root = repo.dir;
  const config = defaults();
  const id = createJob(root, config, { title: 'old runs' }).id;

  // A job from the schema before runHistory: the builder ran twice, and only its events say what each run used.
  const old = JSON.parse(fs.readFileSync(stateFile(root, id, 'job.json'), 'utf8'));
  old.schemaVersion = JOB_STEPS.findIndex((s) => s.id === 'agent-run-history') + 1; // the version before runHistory: its step counts the legacy runs
  old.round = 1;
  old.agents = { builder: { runs: 2, status: 'done', model: 'opus', startedAt: '2026-10-02T10:10:00.000Z', endedAt: '2026-10-02T10:20:00.000Z', round: 1 } };
  for (const f of jobFiles(root, id, 'job.json')) fs.writeFileSync(f, JSON.stringify(old));
  const line = (type: string, ts: string, extra: object = {}) => JSON.stringify({ v: EVENT_SCHEMA_VERSION, ts, type, role: 'builder', ...extra });
  const events = [
    line('agent-start', '2026-10-02T10:00:00.000Z', { model: 'opus' }),
    line('agent-end', '2026-10-02T10:05:00.000Z', { usage: { input: 100, output: 20, cacheRead: 1000, cacheWrite: 50, totalTokens: 1170, exact: true } }),
    line('agent-start', '2026-10-02T10:10:00.000Z', { model: 'opus' }),
    line('agent-end', '2026-10-02T10:20:00.000Z', { usage: { totalTokens: 500, toolUses: 0, durationMs: 0 } }),
  ];
  for (const f of jobFiles(root, id, 'events.jsonl')) fs.appendFileSync(f, events.join('\n') + '\n');

  const builder = () => roundAgents(root, loadJob(root, id), readEvents(root, id), projects).find((r) => r.role === 'builder')!;
  let row = builder();
  assert.deepEqual(
    row.runs.map((r) => [r.startedAt, r.endedAt, r.round, r.usage?.totalTokens, r.composition]),
    [
      ['2026-10-02T10:00:00.000Z', '2026-10-02T10:05:00.000Z', null, 1170, null],
      ['2026-10-02T10:10:00.000Z', '2026-10-02T10:20:00.000Z', null, 500, null],
    ],
  );
  assert.deepEqual(row.runs[1]!.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 500 }, 'a --tokens run is all unsplit');
  assert.equal(row.tokens, 1670);

  const composition = { total: 40, forgePrompt: 10, harness: 20, carried: 0, tools: [{ name: 'Read', tokens: 6 }], assistant: 3, user: 1 };
  recordAgent(root, id, { role: 'builder', phase: 'start' }, config);
  recordAgent(root, id, { role: 'builder', phase: 'end', usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 }, composition }, config);
  row = builder();
  assert.deepEqual(
    row.runs.map((r) => [r.round, r.usage?.totalTokens]),
    [
      [null, 1170],
      [null, 500],
      [1, 10],
    ],
    'the legacy runs, then the new one, each once',
  );
  assert.deepEqual(row.runs[2]!.composition, composition);
  assert.equal(row.tokens, 1680);
});
