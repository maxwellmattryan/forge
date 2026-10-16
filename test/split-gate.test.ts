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

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const between = (text: string, from: string, to: string) => {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `missing ${from}`);
  const end = text.indexOf(to, start + from.length);
  return end > start ? text.slice(start, end) : text.slice(start);
};
// The split gate's decisions live in `forge job step` (lib/step.ts); the human commands and the
// child-creation procedure live in the orchestrator's references.
const COMMANDS = read('skills/forge/reference/commands.md');
const SPLIT = read('skills/forge/reference/split.md');
const approveRow = (gate: string) => {
  const line = between(COMMANDS, '## `approve', '\n## ').split('\n').find((l) => l.startsWith(`| \`${gate}\``));
  assert.ok(line, `no approve row for ${gate}`);
  return line;
};
const planned = (split: 'ask' | 'auto' | 'never', splitMode: 'never' | null = null) =>
  fixture({ config: (c) => (c.pipeline.split = split), job: { stage: 'plan', state: 'running', splitMode, agents: { planner: ag(0, 1, 2) } }, plan: { verdict: 'SPLIT', jobs: 3 } });

test('a split under ask waits on split-approval and creates nothing', () => {
  const a = step(planned('ask'));
  assert.equal(a.action, 'run');
  assert.equal(a.rule, 'P3');
  if (a.action !== 'run') return;
  assert.deepEqual(a.command, ['job', 'set', 'j', '--stage', 'plan', '--state', 'waiting', '--waiting-on', 'split-approval', '--reason', 'planner proposes 3 jobs']);
  assert.equal(step(planned('never')).rule, 'P3', 'a SPLIT returned under never waits too');

  const approve = approveRow('split-approval');
  assert.ok(approve.includes('approve-split') && approve.includes('reference/split.md'));
  const revise = between(COMMANDS, '## `revise', '\n## ');
  for (const s of ['split-approval', 'revise-split', 'split mode `never`', '--stage plan --state running']) assert.ok(revise.includes(s), s);
});

test('split.md keeps today\'s split path under auto', () => {
  const a = step(planned('auto'));
  assert.equal(a.action, 'procedure');
  if (a.action === 'procedure') assert.equal(a.reference, path.join(ROOT, 'skills', 'forge', 'reference', 'split.md'));
  for (const s of ['forge tracker create --title … --body … --parent <ref>', 'forge job new --title … --body … --parent <id>', 'dependsOn', '--waiting-on external --reason "split into N jobs"'])
    assert.ok(SPLIT.includes(s), s);
});

test('issue <ref> plans with split mode never', () => {
  assert.equal(step(planned('auto', 'never')).rule, 'P3', 'a from-ref job never splits, whatever the config says');
  const spawn = step(fixture({ config: (c) => (c.pipeline.split = 'auto'), job: { stage: 'plan', state: 'running', splitMode: 'never' } }));
  assert.ok(spawn.action === 'spawn' && spawn.brief.split('\n').includes('Split mode: never'));
  const fresh = step(fixture({ config: (c) => (c.pipeline.split = 'auto'), job: { stage: 'plan', state: 'running' } }));
  assert.ok(fresh.action === 'spawn' && fresh.brief.split('\n').includes('Split mode: auto'));
  assert.ok(read('skills/forge/SKILL.md').split('\n').some((l) => l.startsWith('| `issue <ref>`') && l.includes('forge job from-ref')));
  // The planner half: under never the plan stays one job and a split opinion is only advice.
  const planner = read('agents/planner.md');
  assert.ok(planner.includes('Split mode'));
  assert.ok(planner.includes('`never`: the human chose this boundary, so the plan is always `PLAN: SINGLE`'));
  assert.ok(planner.includes('External line starting `Recommend splitting:`'));
  assert.ok(planner.includes('`feedback.md`'));
});

test('prompts carry phases from plan to tasks to commits', () => {
  const template = between(read('agents/planner.md'), '## Write `plan.md`', '## Finish');
  assert.ok(template.includes('## Phases          (only for SINGLE)'));
  const writer = read('agents/spec-writer.md');
  assert.ok(writer.includes('When `plan.md` has `## Phases`, group `## Tasks` under `### Phase <n>: <title>` headings'));
  const builder = read('agents/builder.md');
  assert.ok(builder.includes('commit at the end of each phase with build and tests green'));
});
