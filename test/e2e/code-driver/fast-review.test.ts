// review.startAfter fast under `daemon.driver: code`, end to end: the panel starts on the partial pass of
// `verify: [build, [test]]`, the full verify runs alongside it, and its late failure (a `test` that fails once)
// cancels the round's lens runs and sends the round back to the builder; the next pass reviews again, in the same
// round, and the job reaches the PR gate. Every role is a role run of the stub claude (test/fixtures/fake-roles.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { codeDriverRig, editConfigFile, forgeSync, waitFor } from '../../helpers.ts';
import { enqueue, listRequests } from '#core/job/requests.ts';
import { loadJob, readEvents } from '#core/job/store.ts';
import { loadConfig } from '#core/config/load.ts';

const FLOW_MS = 180_000;

test('under review.startAfter fast the panel starts after build and a late test failure sends the round back with its lenses cancelled', { timeout: 300_000 }, async (t) => {
  const rig = codeDriverRig(t);
  const { root, pool } = rig;
  // Outside the worktree, so no run of it dirties the tree it is checked on.
  const runs = path.join(path.dirname(root), 'test-runs');
  editConfigFile(root, (c) => {
    c.review.startAfter = 'fast';
    c.verify = ['build', ['test']];
    c.commands.build = 'true';
    c.commands.test = `n=$(( $(cat '${runs}' 2>/dev/null || echo 0) + 1 )); echo $n > '${runs}'; [ $n -gt 1 ]`;
  });
  const forge = (...args: string[]) => {
    const r = forgeSync(root, args, rig.env);
    assert.equal(r.status, 0, `forge ${args.join(' ')}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const { id } = forge('job', 'new', '--title', 'add a file', '--body', 'Add one file called added.txt.');
  enqueue(root, loadConfig(root).config, { type: 'resume', job: id, from: 'dashboard' });
  pool.start('boot');

  await waitFor(() => loadJob(root, id).waitingOn === 'spec-approval', { timeoutMs: FLOW_MS, what: 'the spec gate' });
  await waitFor(() => pool.state().jobs[id]?.status !== 'busy', { what: 'the first turn to end' });
  enqueue(root, loadConfig(root).config, { type: 'approve', job: id, text: 'none a test job', from: 'dashboard' });
  await waitFor(
    () => {
      const j = loadJob(root, id);
      return j.stage === 'pr' && j.waitingOn === 'pr-review' && !listRequests(root).some((r) => r.job === id && r.status !== 'done' && r.status !== 'rejected');
    },
    { timeoutMs: FLOW_MS, what: 'the PR gate with every request closed' },
  );
  await waitFor(() => pool.state().jobs[id]?.status !== 'busy', { what: 'the last turn to end' });

  const events = readEvents(root, id);
  const firstFail = events.findIndex((e) => e.type === 'command' && e.name === 'test' && e.ok === false);
  assert.ok(firstFail >= 0, 'the first full verify failed on test');
  const firstReviewer = events.findIndex((e) => e.type === 'agent-start' && String(e.role).startsWith('reviewer:'));
  assert.ok(firstReviewer >= 0 && firstReviewer < firstFail, 'a reviewer started before test ran');
  assert.ok(events.some((e) => e.type === 'agent-cancelled' && e.round === 1), 'the late failure cancelled a lens run of round 1');
  const job = loadJob(root, id);
  // The late failure sends the round back, not on: the second panel reviewed the second partial pass in the same
  // round, and that review is current (reviewCurrent), so no commit-after-review round 2 follows.
  assert.equal(job.round, 1, 'the job stayed in round 1');
  assert.ok(!events.some((e) => e.type === 'round' && e.round === 2), 'no second round opened');
  assert.equal(events.filter((e) => e.type === 'panel' && e.round === 1).length, 2, 'exactly two panels ran in round 1');
  assert.ok((job.agents.builder?.runHistory ?? []).filter((r) => r.round === 1).length >= 2, 'the builder ran again in round 1');
  assert.ok(
    events.slice(firstFail).some((e) => e.type === 'command' && e.name === 'build' && e.cached === true && e.durationMs === 0),
    "the next round's full verify reused the partial run's build",
  );
  const runsOf = (job.verifyRuns ?? []).filter((r) => r.round === 1);
  assert.ok(
    runsOf.some((r) => r.partial === true) && runsOf.at(-1)?.ok === true && runsOf.at(-1)?.partial === undefined,
    JSON.stringify(runsOf),
  );
});
