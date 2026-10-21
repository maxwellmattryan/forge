// loadStepInput over a real job dir: the events it keeps reach step, so a rule that reads one works
// outside the in-memory fixtures of test/step.test.ts too.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, repoTemplate, tempRepo } from './helpers.ts';
import { FOREMAN_ACTOR } from '../lib/actor.ts';
import { budgetCmd } from '../lib/budget.ts';
import { defaults } from '../lib/config.ts';
import { createJob, logEvent, logHumanEvent, setJob } from '../lib/jobs.ts';
import { loadStepInput, step } from '../lib/step.ts';
import type { EventActor, JobChange, StepAction } from '../lib/types.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

/** A job at stage pr with a verify that passed a minute ago, then a later `pr-head-pulled`. */
function pulledJob(pulled: string) {
  const repo = tempRepo();
  const config = defaults();
  config.tracker.kind = 'none';
  const id = createJob(repo.dir, config, { title: 'Pulled head' }).id;
  const at = new Date(Date.now() - 60_000).toISOString();
  setJob(repo.dir, id, { stage: 'pr', state: 'running', fields: { round: 1, verifyRuns: [{ round: 1, attempt: 1, sha: 'a'.repeat(40), ok: true, at, file: 'verify/round-1.md', failure: null }] } });
  logEvent(repo.dir, id, 'pr-head-pulled', { head: 'b'.repeat(40), pulled });
  return { id, action: step(loadStepInput(repo.dir, config, id)), cleanup: repo.cleanup };
}

test('loadStepInput keeps pr-head-pulled: a merged pull re-verifies (PR2)', () => {
  const r = pulledJob('merge');
  try {
    assert.equal(r.action.rule, 'PR2b');
    assert.equal(r.action.action, 'run');
    assert.deepEqual((r.action as any).command, ['verify', r.id]);
  } finally {
    r.cleanup();
  }
});

test('loadStepInput: a conflicting pull parks on human (PR11)', () => {
  const r = pulledJob('conflicts');
  try {
    assert.equal(r.action.rule, 'PR11');
    const cmd = (r.action as any).command as string[];
    assert.deepEqual(cmd.slice(0, 7), ['job', 'set', r.id, '--state', 'waiting', '--waiting-on', 'human']);
    assert.equal(cmd[7], '--reason');
    assert.match(cmd[8], new RegExp(`forge verify ${r.id}$`));
  } finally {
    r.cleanup();
  }
});

// ---- Answered gates (GA): parks made by setJob, decisions logged as `forge job human` logs them.

const PERSON: EventActor = { login: 'alice', source: 'env' };
const plainRepo = repoTemplate(() => {});

/** A scratch job running in `stage`, with helpers to park it, log a decision and step it. */
function gateJob(stage: JobChange['stage'], fields: Record<string, unknown> = {}) {
  const repo = plainRepo();
  const config = defaults();
  config.tracker.kind = 'none';
  const id = createJob(repo.dir, config, { title: 'Gate' }).id;
  setJob(repo.dir, id, { stage, state: 'running', fields: { round: 1, ...fields } });
  return {
    id,
    root: repo.dir,
    park: (waitingOn: JobChange['waitingOn'], reason = 'r') => setJob(repo.dir, id, { state: 'waiting', waitingOn, reason }),
    set: (change: JobChange) => setJob(repo.dir, id, change),
    decide: (action: string, actor = PERSON) => logHumanEvent(repo.dir, id, 'human', { action, note: 'ok' }, actor),
    input: () => loadStepInput(repo.dir, config, id),
    step: (): StepAction => step(loadStepInput(repo.dir, config, id)),
    cleanup: repo.cleanup,
  };
}

const setTo = (id: string, stage?: string) => ['job', 'set', id, ...(stage ? ['--stage', stage] : []), '--state', 'running'];

test('answered gates move the job from a real events.jsonl', () => {
  const cases: { name: string; stage: JobChange['stage']; on: JobChange['waitingOn']; action: string; rule: string; to?: string; actor?: EventActor }[] = [
    { name: 'rounds-exhausted in review + approve', stage: 'review', on: 'rounds-exhausted', action: 'approve', rule: 'GA2', to: 'integrate', actor: FOREMAN_ACTOR },
    { name: 'escalation in integrate + approve', stage: 'integrate', on: 'escalation', action: 'approve', rule: 'GA2b', to: 'decide' },
    { name: 'infra + approve', stage: 'decide', on: 'infra', action: 'approve', rule: 'GA3', to: 'integrate' },
    { name: 'conflicts + approve', stage: 'integrate', on: 'conflicts', action: 'approve', rule: 'GA4', to: 'integrate' },
    { name: 'conflicts + rework', stage: 'integrate', on: 'conflicts', action: 'rework', rule: 'GA4', to: 'integrate' },
    { name: 'spec-approval + approve-spec', stage: 'spec', on: 'spec-approval', action: 'approve-spec', rule: 'GA1' },
    { name: 'escalation in build + rework', stage: 'build', on: 'escalation', action: 'rework', rule: 'GA8', to: 'build' },
  ];
  for (const c of cases) {
    const j = gateJob(c.stage);
    try {
      j.park(c.on);
      assert.equal(j.step().rule, 'G4b', `${c.name}: waits before the decision`);
      j.decide(c.action, c.actor);
      const a = j.step() as any;
      assert.equal(a.rule, c.rule, c.name);
      assert.equal(a.action, 'run', c.name);
      assert.deepEqual(a.command, setTo(j.id, c.to), c.name);
    } finally {
      j.cleanup();
    }
  }
});

test('an approve at an earlier park does not answer a later one', () => {
  const j = gateJob('decide');
  try {
    j.park('escalation');
    j.decide('approve');
    assert.equal(j.step().rule, 'GA2');
    j.set({ stage: 'integrate', state: 'running' });
    j.park('escalation');
    const a = j.step() as any;
    assert.equal(a.rule, 'G4b');
    assert.equal(a.waitingOn, 'escalation');
  } finally {
    j.cleanup();
  }
  // A budget acknowledgement's approve never clears the escalation that follows it.
  const b = gateJob('decide');
  try {
    b.park('budget', 'budget exceeded: usd 2.00/1.00');
    b.decide('approve');
    b.set({ state: 'running' });
    b.park('escalation');
    assert.equal(b.step().rule, 'G4b');
  } finally {
    b.cleanup();
  }
});

test('a gate whose follow-up already ran is not answered twice', () => {
  const j = gateJob('decide');
  try {
    j.park('escalation');
    j.decide('approve');
    const a = j.step() as any;
    assert.equal(a.rule, 'GA2');
    // The follow-up, run as `forge job advance` would: the job is running in integrate again.
    j.set({ stage: 'integrate', state: 'running' });
    const next = j.step();
    assert.doesNotMatch(next.rule, /^GA|^G4/, `the stage decides now, not ${next.rule}`);
  } finally {
    j.cleanup();
  }
});

test('loadStepInput computes budgetExceeded only at a budget park', () => {
  const j = gateJob('build', { 'usage.estCostUsd': 5, 'budget.limits.usd': 1 });
  try {
    assert.equal(j.input().budgetExceeded, null, 'running: not computed');
    j.park('budget', 'budget exceeded: usd 5.00/1.00');
    assert.deepEqual(j.input().budgetExceeded, ['usd']);
    j.decide('approve');
    assert.equal(j.step().rule, 'G4b', 'an approve while usd is still over waits');
    budgetCmd(j.root, defaults(), j.id, { ack: true });
    assert.deepEqual(j.input().budgetExceeded, []);
    const a = j.step() as any;
    assert.equal(a.rule, 'GA7');
    assert.deepEqual(a.command, setTo(j.id));
  } finally {
    j.cleanup();
  }
});

const initRepo = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'none' }, pr: { enabled: false } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

describe('answered gates through the CLI', { concurrency: 4 }, () => {
  test('a logged approve at an escalation moves the job (GA2)', async () => {
    const r = initRepo();
    const env = { FORGE_DAEMON: undefined, FORGE_DAEMON_SCOPE: undefined };
    const cli = async (...args: string[]) => {
      const res = await forgeAsync(r.dir, args, env);
      assert.equal(res.status, 0, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
      return JSON.parse(res.stdout);
    };
    try {
      const id = createJob(r.dir, defaults(), { title: 'Escalated' }).id;
      setJob(r.dir, id, { stage: 'decide', state: 'running', fields: { round: 1 } });
      await cli('job', 'set', id, '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'approver escalated');
      assert.equal((await cli('job', 'step', id)).rule, 'G4b');
      await cli('job', 'human', id, 'approve', '--note', 'ok');
      const a = await cli('job', 'step', id);
      assert.equal(a.action, 'run');
      assert.equal(a.rule, 'GA2');
      assert.deepEqual(a.command, ['job', 'set', id, '--stage', 'integrate', '--state', 'running']);
    } finally {
      r.cleanup();
    }
  });
});
