// The split gate (issue #49): pipeline.split, the split-approval waiting reason, and the prompt and
// orchestrator contracts that carry it. Most of the gate lives in markdown the orchestrator follows,
// so those tests pin the literal instructions rather than running a session.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { defaults, validateConfig } from '../lib/config.ts';
import { createJob, loadJob, readEvents, setJob } from '../lib/jobs.ts';
import { WAITING_ON } from '../lib/schema.ts';
import { WAITING_ON as DASH_WAITING_ON } from '../dashboard/src/lib/types.ts';
import { statusKey } from '../lib/trackers/status.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'bin', 'forge');

test('pipeline.split defaults to ask and validates its values', () => {
  const repo = tempRepo();
  try {
    assert.equal(defaults().pipeline.split, 'ask');
    for (const v of ['ask', 'auto', 'never'] as const) {
      const c = defaults();
      c.pipeline.split = v;
      assert.deepEqual(validateConfig(c, repo.dir).filter((p) => p.startsWith('pipeline.split')), [], v);
    }
    const c: any = defaults();
    c.pipeline.split = 'sometimes';
    assert.ok(validateConfig(c, repo.dir).includes('pipeline.split must be one of ask | auto | never (got "sometimes")'));
  } finally {
    repo.cleanup();
  }
});

test('split-approval is a waiting reason jobs can park on and leave', () => {
  assert.ok(WAITING_ON.includes('split-approval'));
  assert.deepEqual([...DASH_WAITING_ON], [...WAITING_ON]);
  assert.equal(statusKey({ stage: 'plan', state: 'waiting', waitingOn: 'split-approval' }), 'blocked');

  const repo = tempRepo();
  const f = (...args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: repo.dir } });
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
    return r.stdout;
  };
  try {
    const root = repo.dir;
    const answers = path.join(root, '.answers.json');
    fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false } }));
    f('init', 'write', '--answers', answers);
    const a = createJob(root, defaults(), { title: 'Big request', ref: 'big-request' });
    setJob(root, a.id, { stage: 'plan', state: 'waiting', waitingOn: 'split-approval' });
    assert.equal(loadJob(root, a.id).waitingOn, 'split-approval');

    const b = createJob(root, defaults(), { title: 'Other request', ref: 'other-request' });
    f('job', 'set', b.id, '--stage', 'plan', '--state', 'waiting', '--waiting-on', 'split-approval', '--reason', 'planner proposes 2 jobs');
    const job = loadJob(root, b.id);
    assert.equal(job.stage, 'plan');
    assert.equal(job.state, 'waiting');
    assert.equal(job.waitingOn, 'split-approval');
    const t = readEvents(root, b.id).filter((e: any) => e.type === 'transition').at(-1) as any;
    assert.equal(t.to.waitingOn, 'split-approval');
    assert.equal(t.reason, 'planner proposes 2 jobs');

    f('job', 'human', b.id, 'approve-split', '--note', 'go');
    const h = readEvents(root, b.id).filter((e: any) => e.type === 'human').at(-1) as any;
    assert.equal(h.action, 'approve-split');
    assert.equal(h.note, 'go');
  } finally {
    repo.cleanup();
  }
});
