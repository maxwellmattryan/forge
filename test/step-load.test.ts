// loadStepInput over a real job dir: the events it keeps reach step, so a rule that reads one works
// outside the in-memory fixtures of test/step.test.ts too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tempRepo } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import { createJob, logEvent, setJob } from '../lib/jobs.ts';
import { loadStepInput, step } from '../lib/step.ts';

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
    assert.equal(r.action.rule, 'PR2');
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
