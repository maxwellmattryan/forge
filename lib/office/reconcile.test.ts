// The reconciler's bounds, in-process: what counts as progress for its mark, and the absolute ceiling on
// resumes per stage. Events are appended with explicit timestamps so no pass depends on the clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { jobAt, tempRepo } from '../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { ackRequest, listRequests } from '#core/job/requests.ts';
import { loadJob, readEvents } from '#core/job/store.ts';
import { EVENT_SCHEMA_VERSION } from '#core/job/schema.ts';
import { jobFiles, paths } from '#core/paths.ts';
import { appendMeter } from '#engine/metrics/meter.ts';
import { MAX_RESUMES_PER_STAGE, progressMark, reconcile } from './reconcile.ts';

const config = defaults();
const AT = Date.parse('2026-10-24T12:00:00.000Z');

/** Appends one event with its own timestamp, the way a session's CLI call would log it. */
function append(root: string, id: string, type: string, ts: string, extra: Record<string, unknown> = {}): void {
  for (const file of jobFiles(root, id, 'events.jsonl')) fs.appendFileSync(file, JSON.stringify({ v: EVENT_SCHEMA_VERSION, ts, type, ...extra }) + '\n');
}

/** Marks the job's open resumes handled, so the next pass finds it undriven again. */
function handleResumes(root: string, id: string): void {
  for (const r of listRequests(root).filter((x) => x.job === id && x.type === 'resume' && x.status === 'pending')) ackRequest(root, r.id, { status: 'done' });
}

const reconcileActions = (root: string, id: string) => readEvents(root, id).filter((e) => e.type === 'reconcile').map((e) => e.action);
const memory = (root: string) => JSON.parse(fs.readFileSync(path.join(paths(root).runtime, 'reconcile.json'), 'utf8'));

test('only metered agent ends count as progress', async () => {
  const rows: [string, string, Record<string, unknown>][] = [
    ['an agent start', 'agent-start', { role: 'builder' }],
    ['a human event', 'human', { action: 'approve' }],
    ['an agent end without usage', 'agent-end', { role: 'builder' }],
  ];
  for (const [name, type, extra] of rows) {
    const repo = tempRepo();
    try {
      const id = jobAt(repo.dir, 'build', { title: name }).id;
      assert.deepEqual((await reconcile(repo.dir, config, { at: AT })).resumed, [id], name);
      handleResumes(repo.dir, id);
      append(repo.dir, id, type, '2099-01-01T00:00:00.000Z', extra);
      const second = await reconcile(repo.dir, config, { at: AT + 1000 });
      assert.deepEqual([second.resumed, second.escalated], [[], [id]], `${name}: no second resume`);
      const job = loadJob(repo.dir, id);
      assert.deepEqual([job.state, job.waitingOn, job.reason], ['waiting', 'escalation', 'undriven at build: resumed once with no progress since'], name);
    } finally {
      repo.cleanup();
    }
  }
  // The same appended line with usage is progress: a second resume, not an escalation.
  const repo = tempRepo();
  try {
    const id = jobAt(repo.dir, 'build', { title: 'metered' }).id;
    await reconcile(repo.dir, config, { at: AT });
    handleResumes(repo.dir, id);
    append(repo.dir, id, 'agent-end', '2099-01-01T00:00:00.000Z', { role: 'builder', usage: { totalTokens: 10 } });
    assert.deepEqual((await reconcile(repo.dir, config, { at: AT + 1000 })).resumed, [id]);
  } finally {
    repo.cleanup();
  }
});

test('a metered turn counts as progress', async () => {
  const repo = tempRepo();
  try {
    const id = jobAt(repo.dir, 'build', { title: 'metered turn' }).id;
    assert.deepEqual((await reconcile(repo.dir, config, { at: AT })).resumed, [id]);
    handleResumes(repo.dir, id);
    const ts = '2099-01-01T00:00:00.000Z';
    appendMeter(repo.dir, { v: 1, ts, scope: id, sessionId: null, spawnId: 's', turn: 1, usd: 1, tokens: 0, models: {}, cum: { usd: 1, models: {} } });
    const second = await reconcile(repo.dir, config, { at: AT + 1000 });
    assert.deepEqual([second.resumed, second.escalated], [[id], []], 'a record after the resume: resumed again');
    handleResumes(repo.dir, id);
    const third = await reconcile(repo.dir, config, { at: AT + 2000 });
    assert.deepEqual([third.resumed, third.escalated], [[], [id]], 'no new record: escalated');
    const events = readEvents(repo.dir, id);
    assert.equal(progressMark(events, null), progressMark(events), 'no meter: the events-only mark');
    assert.equal(progressMark(events, ts), ts, 'a later metered turn moves the mark');
    assert.equal(progressMark([], null), null);
  } finally {
    repo.cleanup();
  }
});

test('a job is resumed at most three times per stage', async () => {
  const repo = tempRepo();
  try {
    const id = jobAt(repo.dir, 'build', { title: 'metered every turn' }).id;
    const passes: { resumed: string[]; escalated: string[] }[] = [];
    for (let i = 0; i <= MAX_RESUMES_PER_STAGE; i++) {
      handleResumes(repo.dir, id);
      append(repo.dir, id, 'agent-end', `2099-01-01T00:00:0${i}.000Z`, { role: 'builder', usage: { totalTokens: 10 } });
      passes.push(await reconcile(repo.dir, config, { at: AT + i * 1000 }));
    }
    assert.deepEqual(
      passes.map((p) => [p.resumed, p.escalated]),
      [[[id], []], [[id], []], [[id], []], [[], [id]]],
    );
    assert.equal(loadJob(repo.dir, id).reason, 'undriven at build: resumed 3 times at this stage');
    assert.equal(memory(repo.dir).jobs[id], undefined, 'the record is deleted');
    assert.deepEqual(reconcileActions(repo.dir, id), ['resume', 'resume', 'resume', 'escalate']);
  } finally {
    repo.cleanup();
  }
});

test('a record without a valid resumes count stands for one resume', async () => {
  // An older Forge wrote no count; a session could write a bad one. Either way two more resumes reach the ceiling.
  const rows: [string, unknown][] = [
    ['no resumes', undefined],
    ['a string count', '3'],
    ['a zero count', 0],
  ];
  for (const [name, resumes] of rows) {
    const repo = tempRepo();
    try {
      const id = jobAt(repo.dir, 'build', { title: name }).id;
      append(repo.dir, id, 'agent-end', '2099-01-01T00:00:00.000Z', { role: 'builder', usage: { totalTokens: 10 } });
      await reconcile(repo.dir, config, { at: AT });
      const mem = memory(repo.dir);
      if (resumes === undefined) delete mem.jobs[id].resumes;
      else mem.jobs[id].resumes = resumes;
      fs.writeFileSync(path.join(paths(repo.dir).runtime, 'reconcile.json'), JSON.stringify(mem));
      const passes: { resumed: string[]; escalated: string[] }[] = [];
      for (let i = 1; i <= 3; i++) {
        handleResumes(repo.dir, id);
        append(repo.dir, id, 'agent-end', `2099-01-01T00:00:0${i}.000Z`, { role: 'builder', usage: { totalTokens: 10 } });
        passes.push(await reconcile(repo.dir, config, { at: AT + i * 1000 }));
      }
      assert.deepEqual(
        passes.map((p) => [p.resumed, p.escalated]),
        [[[id], []], [[id], []], [[], [id]]],
        name,
      );
      assert.equal(loadJob(repo.dir, id).reason, 'undriven at build: resumed 3 times at this stage', name);
    } finally {
      repo.cleanup();
    }
  }
});
