// The pool under `daemon.driver: code` (lib/office/code/job-driver.ts): its claim under a stable id, the turns it hands
// to a session, parks for role children that die, role failures, another session's lease, a role child's permission
// prompt answered from the pool, and a stop. Sessions are in-memory (fakeClaude); role runs are the stub claude.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { codeDriverRig, forgeInProcess, jobAt, pidGone, waitFor, withLease, type CodeDriverRig } from '../../helpers.ts';
import { loadConfig } from '#core/config/load.ts';
import { RESUME_TAKEN_UP, enqueue, listRequests } from '#core/job/requests.ts';
import { leaseStatus, loadJob, readEvents } from '#core/job/store.ts';
import { whoDrives } from '#office/driver.ts';
import { HANDOFF_TEXT } from '#office/code/job-driver.ts';
import { TRUST_CHANGED } from '#office/session/launch.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OTHER = '22222222-2222-4222-8222-222222222222';
const ACTOR = { login: 'al', source: 'dashboard' } as const;
const SPEC = '# Spec\n\nSize: S\nComplexity: low\nNeeds design: no\nNeeds infra: none\n\n## Acceptance criteria\n- [ ] AC1 — the file exists · Proven by: command `test -f added.txt`\n';

const resume = (rig: CodeDriverRig, job: string) => enqueue(rig.root, loadConfig(rig.root).config, { type: 'resume', job, from: 'dashboard' });
const request = (rig: CodeDriverRig, id: string) => listRequests(rig.root).find((r) => r.id === id)!;
const turnEnded = (rig: CodeDriverRig, job: string, n = 1) => waitFor(() => rig.log(job).filter((l) => l.event === 'driver-end').length >= n, { timeoutMs: 60_000, what: `code turn ${n} to end` });

/** A running job at build whose next step is the builder (B4), with its worktree and spec. */
async function atBuild(rig: CodeDriverRig): Promise<string> {
  const { id } = jobAt(rig.root, 'build');
  assert.equal((await forgeInProcess(rig.root, ['worktree', 'create', id])).status, 0);
  fs.writeFileSync(path.join(rig.root, '.forge', 'jobs', id, 'spec.md'), SPEC);
  assert.equal((await forgeInProcess(rig.root, ['job', 'round', id])).status, 0);
  const step = (await forgeInProcess(rig.root, ['job', 'step', id])).data as any;
  assert.deepEqual([step.action, step.role], ['spawn', 'builder'], JSON.stringify(step));
  return id;
}

describe('the code driver', { concurrency: 4 }, () => {
  test('the code driver claims under its stable id', async (t) => {
    // The spec-writer's reply is held, so the turn is caught mid-run.
    const rig = codeDriverRig(t, { env: { FAKE_CLAUDE_DELAY_MS: '1500' } });
    const { root, pool } = rig;
    const { id } = jobAt(root, 'backlog', { state: 'queued' });
    const r = resume(rig, id);
    pool.start('boot');
    await waitFor(() => rig.log(id).some((l) => l.event === 'role-start'), { timeoutMs: 30_000, what: 'the spec-writer to start' });
    const driver = rig.driverId(id);
    assert.match(String(driver), UUID);
    const job = loadJob(root, id);
    assert.equal(job.lease.driver, driver, 'claimed under the driver id');
    assert.equal(whoDrives(job, pool.facts(id)).jobSession, true, "the job's own session drives it");
    assert.deepEqual([pool.state().jobs[id].status, pool.state().jobs[id].sessionId, pool.state().jobs[id].running], ['busy', driver, true]);
    await waitFor(() => loadJob(root, id).waitingOn === 'spec-approval', { timeoutMs: 30_000, what: 'the spec gate' });
    await turnEnded(rig, id);
    assert.deepEqual([request(rig, r.id).status, request(rig, r.id).result], ['done', RESUME_TAKEN_UP]);
    assert.notEqual(leaseStatus(loadJob(root, id)).status, 'live');
    assert.equal(rig.driverId(id), driver, 'the record keeps the id');
    assert.deepEqual(
      rig.log(id).map((l) => l.event).filter((e) => ['driver-start', 'claim', 'role-start', 'role-reply', 'role-end', 'driver-end'].includes(e)),
      ['driver-start', 'claim', 'role-start', 'role-reply', 'role-end', 'driver-end'],
    );
    assert.ok(rig.log(id).every((l) => typeof l.message === 'string' || !['driver-start', 'claim', 'ran', 'role-start', 'role-end', 'driver-end'].includes(l.event)), 'each driver line reads');
  });

  test('a procedure hands the job to a session', async (t) => {
    const rig = codeDriverRig(t);
    const { root, pool } = rig;
    const { id } = jobAt(root, 'backlog', { create: { kind: 'retro' } });
    const r = resume(rig, id);
    pool.start('boot');
    await waitFor(() => rig.sessions.children.some((c) => c.scope === id && c.turns === 1), { timeoutMs: 30_000, what: 'the session turn' });
    // The log stream may still hold the last lines.
    await waitFor(() => rig.log(id).some((l) => l.event === 'handoff'), { what: 'the handoff line' });
    assert.ok(rig.log(id).some((l) => l.event === 'claim' && l.epoch !== undefined), 'the driver claimed it first');
    assert.equal(request(rig, r.id).status, 'done', "the turn's resume was taken up");
    const handed = listRequests(root).filter((x) => x.job === id && x.from === 'code-driver');
    assert.equal(handed.length, 1);
    assert.deepEqual([handed[0].type, handed[0].status, handed[0].text], ['resume', 'pending', HANDOFF_TEXT]);
    const [session] = rig.sessions.children.filter((c) => c.scope === id);
    assert.equal(session.turns, 1, 'one turn');
    await waitFor(() => rig.log(id).some((l) => l.event === 'turn'), { what: "the session's turn line" });
    assert.deepEqual(rig.log(id).filter((l) => l.event === 'turn').map((l) => l.requests), [1], 'given the one hand-off request');
    assert.deepEqual(pool.state().jobs[id].status, 'busy');
    const job = loadJob(root, id);
    assert.ok(job.lease.driver === null || leaseStatus(job).status !== 'live', 'the driver let the job go');
  });

  test('unported requests fall back to a session', async (t) => {
    for (const row of ['an approve request', 'a resume on a failed job'] as const) {
      const rig = codeDriverRig(t);
      const { root, pool } = rig;
      const { id } = row === 'an approve request' ? jobAt(root, 'spec', { state: 'waiting', waitingOn: 'spec-approval' }) : jobAt(root, 'build', { state: 'failed' });
      const r = enqueue(root, loadConfig(root).config, row === 'an approve request' ? { type: 'approve', job: id, from: 'dashboard' } : { type: 'resume', job: id, from: 'dashboard' });
      pool.start('boot');
      await waitFor(() => rig.sessions.children.some((c) => c.scope === id && c.turns === 1), { timeoutMs: 30_000, what: `${row}: the session turn` });
      assert.equal(request(rig, r.id).status, 'pending', `${row}: the session claims it, not the driver`);
      await waitFor(() => rig.log(id).some((l) => l.event === 'fallback'), { what: `${row}: the fallback line` });
      assert.ok(!rig.log(id).some((l) => l.event === 'claim' || l.event === 'driver-start'), `${row}: no claim`);
      assert.ok(!readEvents(root, id).some((e) => e.type === 'claimed'), `${row}: no claimed event`);
      assert.deepEqual(rig.stub(), [], `${row}: no forge child ran a role`);
      await pool.close();
    }
  });

  test('a killed role child parks the job', async (t) => {
    // The role child exits at once with 137: the runner records the builder failed, exit 5, and the driver parks.
    const exited = codeDriverRig(t, { env: { FAKE_CLAUDE_EXIT: '137' } });
    const a = await atBuild(exited);
    resume(exited, a);
    exited.pool.start('boot');
    await waitFor(() => loadJob(exited.root, a).state === 'waiting', { timeoutMs: 30_000, what: 'the park' });
    const parked = loadJob(exited.root, a);
    assert.equal(parked.waitingOn, 'escalation');
    assert.match(parked.reason ?? '', /^code driver: .*builder/);
    assert.deepEqual(parked.agents.builder?.status, 'failed', 'failed, not lost');
    await turnEnded(exited, a);
    assert.notEqual(leaseStatus(loadJob(exited.root, a)).status, 'live');

    // The runner itself killed mid-run: its role child is stopped through the pid it reported, and the builder is lost.
    const killed = codeDriverRig(t, { env: { FAKE_CLAUDE_NO_RESULT: '1' } });
    const b = await atBuild(killed);
    resume(killed, b);
    killed.pool.start('boot');
    const start = await waitFor(() => killed.log(b).find((l) => l.event === 'role-start'), { timeoutMs: 30_000, what: 'the runner' });
    const child = await waitFor(() => killed.stub().find((s) => Array.isArray(s.argv)), { timeoutMs: 30_000, what: 'the role child' });
    await waitFor(() => killed.stub().some((s) => s.pid === child.pid && typeof s.stdin === 'string'), { what: 'the brief' });
    process.kill(start.pid, 'SIGKILL');
    await waitFor(() => loadJob(killed.root, b).state === 'waiting', { timeoutMs: 30_000, what: 'the park' });
    const lost = loadJob(killed.root, b);
    assert.equal(lost.waitingOn, 'escalation');
    assert.match(lost.reason ?? '', /^code driver: .*builder.*SIGKILL/);
    assert.equal(lost.agents.builder?.status, 'lost');
    assert.match(lost.agents.builder?.summary ?? '', /^code driver: /);
    await waitFor(() => pidGone(child.pid), { timeoutMs: 5000, what: "the stub's pid to be gone" });
  });

  test('role failures map to moves', async (t) => {
    type Row = { name: string; env?: NodeJS.ProcessEnv | ((root: string) => NodeJS.ProcessEnv); before?: (rig: CodeDriverRig, id: string) => void; check: (rig: CodeDriverRig, id: string, req: string) => Promise<void> };
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const rows: Row[] = [
      {
        name: 'auth twice parks',
        env: { FAKE_CLAUDE_RESULT_ERROR: 'OAuth token has expired · Please run /login' },
        check: async (rig, id) => {
          await waitFor(() => loadJob(rig.root, id).state === 'waiting', { timeoutMs: 30_000, what: 'the park' });
          assert.match(loadJob(rig.root, id).reason ?? '', /^code driver: builder failed twice: auth: /);
        },
      },
      {
        name: 'a usage limit waits for its reset',
        env: { FAKE_CLAUDE_RATE_LIMIT: String(resetsAt), FAKE_CLAUDE_RESULT_ERROR: "You've hit your usage limit" },
        check: async (rig, id, req) => {
          await turnEnded(rig, id);
          const retry = rig.log(id).find((l) => l.event === 'retry');
          assert.equal(retry?.at, new Date(resetsAt * 1000).toISOString());
          assert.equal(loadJob(rig.root, id).state, 'running', 'nothing parked');
          assert.equal(request(rig, req).status, 'pending', 'the request stays');
          assert.notEqual(leaseStatus(loadJob(rig.root, id)).status, 'live');
          // Ticks go by and no turn starts before the reset.
          await new Promise((r) => setTimeout(r, 500));
          assert.equal(rig.log(id).filter((l) => l.event === 'driver-start').length, 1);
        },
      },
      {
        // The stub writes it before its result: a trusted file changed during the run.
        name: 'a role that rewrites the config stops the pool',
        env: (root) => {
          const file = path.join(root, '.forge', 'config.yml');
          return { FAKE_CLAUDE_WRITE: `${file}=${fs.readFileSync(file, 'utf8')}\n# changed by the role\n` };
        },
        check: async (rig) => {
          await waitFor(() => rig.pool.state().lastError === TRUST_CHANGED, { timeoutMs: 30_000, what: 'the trust stop' });
          assert.equal(rig.pool.state().wanted, false);
        },
      },
      {
        // AC13: another session's live lease.
        name: "another session's lease rejects the turn",
        before: (rig, id) => void withLease(rig.root, id, OTHER),
        check: async (rig, id, req) => {
          await turnEnded(rig, id);
          assert.deepEqual([request(rig, req).status, request(rig, req).result], ['rejected', `job is driven by session ${OTHER}`]);
          assert.ok(!rig.log(id).some((l) => l.event === 'role-start'), 'no runner');
          assert.deepEqual(rig.stub(), []);
        },
      },
    ];
    for (const row of rows) {
      const rig = codeDriverRig(t, { env: row.env });
      const id = await atBuild(rig);
      row.before?.(rig, id);
      const req = resume(rig, id).id;
      rig.pool.start('boot');
      await row.check(rig, id, req);
      await rig.pool.close();
    }
  });

  test("a role child's permission prompt is answered from the pool", async (t) => {
    const rig = codeDriverRig(t, { env: { FAKE_CLAUDE_ASK: 'cp a b' } });
    const { root, pool } = rig;
    const id = await atBuild(rig);
    resume(rig, id);
    pool.start('boot');
    const prompt = await waitFor(() => pool.state().jobs[id]?.permissions[0], { timeoutMs: 30_000, what: 'the prompt' });
    assert.deepEqual([pool.state().jobs[id].permissions.length, prompt.role, prompt.tool, JSON.parse(prompt.input).command], [1, 'builder', 'Bash', 'cp a b']);
    assert.equal(pool.answerPermission(id, prompt.id, 'allow', ACTOR), true);
    await waitFor(() => loadJob(root, id).agents.builder?.status === 'done', { timeoutMs: 30_000, what: 'the builder to end' });
    const answer = rig.stub().map((s) => (typeof s.stdin === 'string' ? JSON.parse(s.stdin) : null)).find((l) => l?.type === 'control_response');
    assert.equal(answer?.response?.response?.behavior, 'allow');
    const audit = readEvents(root, id).find((e) => e.type === 'daemon-permission');
    assert.deepEqual([audit?.tool, audit?.decision], ['Bash', 'allow']);
    // The panel asks too, and nobody answers: the stop interrupts it.
    await pool.stopSession(id);
  });

  test('stopping a code turn interrupts its runners', async (t) => {
    // Long enough for a runner on a loaded machine to record its role's end before any SIGKILL.
    const graceMs = 10_000;
    const rig = codeDriverRig(t, { env: { FAKE_CLAUDE_NO_RESULT: '1' }, graceMs });
    const { root, pool } = rig;
    const id = await atBuild(rig);
    const req = resume(rig, id).id;
    pool.start('boot');
    const runner = await waitFor(() => rig.log(id).find((l) => l.event === 'role-start'), { timeoutMs: 30_000, what: 'the runner' });
    const child = await waitFor(() => rig.stub().find((s) => Array.isArray(s.argv)), { timeoutMs: 30_000, what: 'the role child' });
    await waitFor(() => rig.stub().some((s) => s.pid === child.pid && typeof s.stdin === 'string'), { what: 'the brief' });
    const stopped = Date.now();
    await pool.stopSession(id);
    const builder = loadJob(root, id).agents.builder;
    assert.equal(builder?.status, 'failed');
    assert.match(builder?.summary ?? '', /^interrupted: /);
    await waitFor(() => pidGone(runner.pid) && pidGone(child.pid), { timeoutMs: Math.max(100, graceMs * 2 - (Date.now() - stopped)), what: 'no runner or stub alive' });
    assert.notEqual(leaseStatus(loadJob(root, id)).status, 'live', 'the lease expired');
    assert.equal(request(rig, req).status, 'pending', 'the request stays');
  });
});
