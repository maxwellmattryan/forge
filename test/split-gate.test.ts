// The split gate (issue #49): pipeline.split, the split-approval waiting reason, and the prompt and
// orchestrator contracts that carry it. `forge job step` decides the gate (rows below run it); the
// human commands and the child-creation path are markdown, so those tests pin the literal text.
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
import { step } from '../lib/step.ts';
import { ag, fixture } from './step-fixture.ts';

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
    const a = createJob(root, defaults(), { title: 'Big request', issues: [{ tracker: 'local', ref: 'big-request', url: null }] });
    setJob(root, a.id, { stage: 'plan', state: 'waiting', waitingOn: 'split-approval' });
    assert.equal(loadJob(root, a.id).waitingOn, 'split-approval');

    const b = createJob(root, defaults(), { title: 'Other request', issues: [{ tracker: 'local', ref: 'other-request', url: null }] });
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

// The split gate's decisions live in `forge job step` (lib/step.ts).
const planned = (split: 'ask' | 'auto' | 'never', splitMode: 'never' | null = null) =>
  fixture({ config: (c) => (c.pipeline.split = split), job: { stage: 'plan', state: 'running', splitMode, agents: { planner: ag(0, 1, 2) } }, plan: { verdict: 'SPLIT', jobs: 3 } });

test('a split under ask waits on split-approval and creates nothing', () => {
  const a = step(planned('ask'));
  assert.equal(a.action, 'run');
  assert.equal(a.rule, 'P3');
  if (a.action !== 'run') return;
  assert.deepEqual(a.command, ['job', 'set', 'j', '--stage', 'plan', '--state', 'waiting', '--waiting-on', 'split-approval', '--reason', 'planner proposes 3 jobs']);
  assert.equal(step(planned('never')).rule, 'P3', 'a SPLIT returned under never waits too');
});

test('a split under auto hands off to split.md', () => {
  const a = step(planned('auto'));
  assert.equal(a.action, 'procedure');
  if (a.action === 'procedure') assert.equal(a.reference, path.join(ROOT, 'skills', 'forge', 'reference', 'split.md'));
});

test('issue <ref> plans with split mode never', () => {
  assert.equal(step(planned('auto', 'never')).rule, 'P3', 'a from-ref job never splits, whatever the config says');
  const spawn = step(fixture({ config: (c) => (c.pipeline.split = 'auto'), job: { stage: 'plan', state: 'running', splitMode: 'never' } }));
  assert.ok(spawn.action === 'spawn' && spawn.brief.split('\n').includes('Split mode: never'));
  const fresh = step(fixture({ config: (c) => (c.pipeline.split = 'auto'), job: { stage: 'plan', state: 'running' } }));
  assert.ok(fresh.action === 'spawn' && fresh.brief.split('\n').includes('Split mode: auto'));
});
