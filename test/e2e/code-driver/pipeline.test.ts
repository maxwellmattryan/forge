// One job, end to end, under `daemon.driver: code`: from a queued resume through intake, the spec gate, build, verify,
// review and decide to the PR gate, with every role a role run of the stub claude (test/fixtures/fake-roles.mjs writes
// its output) and no orchestrator session. The hand-off times it logs are printed for build.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { codeDriverRig, forgeSync, waitFor } from '../../helpers.ts';
import { enqueue, listRequests } from '#core/job/requests.ts';
import { leaseStatus, loadJob, readEvents } from '#core/job/store.ts';
import { loadConfig } from '#core/config/load.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FLOW_MS = 120_000;

test('a job goes from intake to the PR gate with no orchestrator session', { timeout: 300_000 }, async (t) => {
  const rig = codeDriverRig(t);
  const { root, pool } = rig;
  const forge = (...args: string[]) => {
    const r = forgeSync(root, args, rig.env);
    assert.equal(r.status, 0, `forge ${args.join(' ')}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const { id } = forge('job', 'new', '--title', 'add a file', '--body', 'Add one file called added.txt.');
  enqueue(root, loadConfig(root).config, { type: 'resume', job: id, from: 'dashboard' });
  pool.start('boot');

  // Intake and the spec, then the spec gate.
  await waitFor(() => loadJob(root, id).waitingOn === 'spec-approval', { timeoutMs: FLOW_MS, what: 'the spec gate' });
  forge('job', 'human', id, 'approve-spec', '--link', 'none', '--reason', 'a test job');
  enqueue(root, loadConfig(root).config, { type: 'resume', job: id, from: 'dashboard' });

  // Build, verify, review and decide, then the PR gate.
  await waitFor(
    () => {
      const j = loadJob(root, id);
      return j.stage === 'pr' && j.waitingOn === 'pr-review' && !listRequests(root).some((r) => r.job === id && r.status !== 'done' && r.status !== 'rejected');
    },
    { timeoutMs: FLOW_MS, what: 'the PR gate with every request closed' },
  );
  await waitFor(() => pool.state().jobs[id]?.status !== 'busy', { what: 'the last turn to end' });

  // No orchestrator session: the in-memory adapter started no child for the job, and every stub start was a role run.
  assert.deepEqual(rig.sessions.children.filter((c) => c.scope === id), [], 'no session child for the job');
  const starts = rig.stub().filter((r) => Array.isArray(r.argv));
  assert.ok(starts.length >= 4, `${starts.length} role runs`);
  for (const s of starts) assert.match(s.argv[s.argv.indexOf('--agent') + 1] ?? '', /^forge:[a-z-]+$/, s.argv.join(' '));

  const events = readEvents(root, id);
  const roles = (type: string) => events.filter((e) => e.type === type).map((e) => e.role).sort();
  assert.deepEqual(roles('agent-start'), roles('agent-end'), 'every start has its end');
  assert.ok(['spec-writer', 'builder', 'approver'].every((r) => roles('agent-start').includes(r)) && roles('agent-start').some((r) => r.startsWith('reviewer:')), roles('agent-start').join(', '));
  for (const e of events.filter((x) => x.type === 'agent-end')) assert.match(String(e.agentId), UUID, `${e.role}'s agentId`);
  assert.ok(events.some((e) => e.type === 'advance-ran'), 'advance-ran events');
  assert.deepEqual(listRequests(root).filter((r) => r.job === id && r.status === 'pending'), [], 'every resume is closed');
  assert.notEqual(leaseStatus(loadJob(root, id)).status, 'live', 'the lease is not live');

  // The hand-off metric: every role reply after a turn's first carries one.
  const log = rig.log(id);
  const handoffs: number[] = [];
  let firstOfTurn = true;
  for (const l of log) {
    if (l.event === 'driver-start') firstOfTurn = true;
    if (l.event !== 'role-reply') continue;
    if (!firstOfTurn) {
      assert.equal(typeof l.handoffMs, 'number', JSON.stringify(l));
      assert.ok(l.handoffMs >= 0, JSON.stringify(l));
    }
    if (typeof l.handoffMs === 'number') handoffs.push(l.handoffMs);
    firstOfTurn = false;
  }
  assert.ok(handoffs.length >= 2, `${handoffs.length} hand-offs`);
  const sorted = [...handoffs].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  t.diagnostic(`handoffMs n=${sorted.length} median=${at(0.5)} p90=${at(0.9)} all=${JSON.stringify(handoffs)}`);
});
