// The pool under `daemon.driver: code` (lib/office/code/job-driver.ts): its claim under a stable id, the requests it
// applies in code, the split, retro and adopted-PR rows it runs, the one turn it hands to a session (RC1), parks for role
// children that die, role failures, another session's lease, a role child's permission prompt answered from the pool,
// and a stop. Sessions are in-memory (fakeClaude); role runs are the stub claude.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { codeDriverRig, editConfigFile, forgeInProcess, jobAt, pidGone, waitFor, withLease, type CodeDriverRig } from '../../helpers.ts';
import { loadConfig } from '#core/config/load.ts';
import { RESUME_TAKEN_UP, enqueue, listRequests } from '#core/job/requests.ts';
import { leaseStatus, loadJob, readEvents, setJob } from '#core/job/store.ts';
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
    // RC1, the one procedure left: a job at decide whose diff changes a reviewer prompt, with recall fixtures in the main checkout.
    const { id } = jobAt(root, 'decide');
    assert.equal((await forgeInProcess(root, ['worktree', 'create', id])).status, 0);
    const wt = loadJob(root, id).worktree!;
    fs.mkdirSync(path.join(wt, 'agents'));
    fs.writeFileSync(path.join(wt, 'agents', 'reviewer.md'), '# a changed reviewer prompt\n');
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: wt, stdio: 'pipe' });
    git('add', 'agents/reviewer.md');
    git('commit', '-qm', 'change a reviewer prompt');
    const fixture = path.join(root, '.forge', 'evals', 'recall', 'one');
    fs.mkdirSync(fixture, { recursive: true });
    fs.writeFileSync(path.join(fixture, 'fixture.yml'), 'title: a clean change\nlenses: [code]\n');
    fs.writeFileSync(path.join(fixture, 'diff.patch'), 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n');
    assert.equal((await forgeInProcess(root, ['job', 'claim', id, '--session', 'probe'])).status, 0);
    const step = (await forgeInProcess(root, ['job', 'advance', id, '--session', 'probe'])).data as any;
    assert.deepEqual([step?.action, step?.rule], ['procedure', 'RC1'], JSON.stringify(step));
    assert.equal((await forgeInProcess(root, ['job', 'release', id])).status, 0);
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
    assert.ok(!rig.log(id).some((l) => l.event === 'fallback'), 'the hand-off is no fallback');
  });

  test('requests are applied in code', async (t) => {
    const add = (rig: CodeDriverRig, type: string, job: string, o: { text?: string; from?: string } = {}) => enqueue(rig.root, loadConfig(rig.root).config, { type, job, text: o.text ?? null, from: o.from ?? 'dashboard' });
    type Row = { name: string; arrange: (rig: CodeDriverRig) => Promise<{ id: string; req: string }>; check: (rig: CodeDriverRig, id: string, req: string) => Promise<void> };
    const rows: Row[] = [
      {
        name: "a dashboard approve at the spec gate starts the builder",
        arrange: async (rig) => {
          const { id } = jobAt(rig.root, 'backlog', { state: 'queued' });
          resume(rig, id);
          rig.pool.start('boot');
          await waitFor(() => loadJob(rig.root, id).waitingOn === 'spec-approval', { timeoutMs: 60_000, what: 'the spec gate' });
          await turnEnded(rig, id);
          return { id, req: add(rig, 'approve', id, { text: 'none a test job' }).id };
        },
        check: async (rig, id, req) => {
          await waitFor(() => rig.log(id).some((l) => l.event === 'role-start' && l.role === 'builder'), { timeoutMs: 60_000, what: "the builder's role-start" });
          const applied = rig.log(id).find((l) => l.event === 'applied' && l.request === req);
          assert.deepEqual([applied?.requestType, applied?.status, applied?.createdAt], ['approve', 'done', request(rig, req).createdAt]);
          assert.ok(readEvents(rig.root, id).some((e) => e.type === 'human' && e.action === 'approve-spec'));
        },
      },
      {
        name: 'a cancel on a waiting job cancels it',
        arrange: async (rig) => {
          const { id } = jobAt(rig.root, 'decide', { state: 'waiting', waitingOn: 'escalation', reason: 'approver escalated' });
          return { id, req: add(rig, 'cancel', id, { text: 'not needed after all' }).id };
        },
        check: async (rig, id, req) => {
          await turnEnded(rig, id);
          assert.deepEqual([loadJob(rig.root, id).state, loadJob(rig.root, id).reason, request(rig, req).status], ['cancelled', 'not needed after all', 'done']);
          assert.ok(!rig.log(id).some((l) => l.event === 'role-start'), 'no runner');
        },
      },
      {
        name: 'a resume on a failed job runs it again',
        arrange: async (rig) => {
          const id = await atBuild(rig);
          setJob(rig.root, id, { state: 'failed', reason: 'it broke' });
          return { id, req: resume(rig, id).id };
        },
        check: async (rig, id, req) => {
          await waitFor(() => rig.log(id).some((l) => l.event === 'role-start' && l.role === 'builder'), { timeoutMs: 60_000, what: 'the builder after the retry' });
          assert.equal(rig.log(id).find((l) => l.event === 'applied')?.status, 'done');
          await turnEnded(rig, id);
          assert.equal(request(rig, req).status, 'done');
        },
      },
      {
        name: "an approve from a daemon scope is rejected and moves nothing",
        arrange: async (rig) => {
          const { id } = jobAt(rig.root, 'decide', { state: 'waiting', waitingOn: 'escalation', reason: 'approver escalated' });
          return { id, req: add(rig, 'approve', id, { from: 'daemon:x', text: 'ship it' }).id };
        },
        check: async (rig, id, req) => {
          await turnEnded(rig, id);
          assert.deepEqual([request(rig, req).status, request(rig, req).result], ['rejected', 'human decisions come from a person (this approve came from daemon:x)']);
          const job = loadJob(rig.root, id);
          assert.deepEqual([job.stage, job.state, job.waitingOn], ['decide', 'waiting', 'escalation']);
          assert.ok(!readEvents(rig.root, id).some((e) => e.type === 'human'), 'no decision recorded');
        },
      },
      {
        name: 'a cancel on a job its dependency blocks still cancels it',
        arrange: async (rig) => {
          const dep = jobAt(rig.root, 'backlog', { title: 'the dependency', state: 'queued' }).id;
          const { id } = jobAt(rig.root, 'build', { fields: { dependsOn: [dep] } });
          return { id, req: add(rig, 'cancel', id).id };
        },
        check: async (rig, id, req) => {
          await turnEnded(rig, id);
          assert.ok(rig.log(id).some((l) => l.event === 'claim' && l.claimed === false), 'the claim was refused');
          assert.deepEqual([loadJob(rig.root, id).state, request(rig, req).status], ['cancelled', 'done']);
        },
      },
    ];
    for (const row of rows) {
      const rig = codeDriverRig(t);
      const { id, req } = await row.arrange(rig);
      rig.pool.start('boot');
      await row.check(rig, id, req);
      assert.deepEqual(rig.sessions.children.filter((c) => c.scope === id), [], `${row.name}: no session child`);
      assert.ok(!rig.log(id).some((l) => l.event === 'fallback'), `${row.name}: no fallback line`);
      await rig.pool.close();
    }
  });

  test('the split runs in code', async (t) => {
    const rig = codeDriverRig(t, { env: { FAKE_PLAN_SPLIT: '1' } });
    const { root, pool } = rig;
    editConfigFile(root, (c) => {
      c.tracker.kind = 'none';
      c.pipeline.plan = 'always';
      c.pipeline.split = 'auto';
    });
    const { id } = jobAt(root, 'backlog', { state: 'queued' });
    resume(rig, id);
    pool.start('boot');
    await waitFor(() => loadJob(root, id).waitingOn === 'external', { timeoutMs: 60_000, what: 'the umbrella park' });
    const parent = loadJob(root, id);
    assert.deepEqual([parent.stage, parent.reason, parent.children.length], ['plan', 'split into 2 jobs', 2]);
    const [first, second] = parent.children.map((c) => loadJob(root, c));
    assert.deepEqual(second.dependsOn, [first.id]);
    // The resumes are queued after the park, so the park alone does not mean they exist yet.
    const resumes = () => listRequests(root).filter((r) => r.from === 'forge' && r.type === 'resume').map((r) => r.job);
    await waitFor(() => resumes().length > 0, { what: "the unblocked child's resume" });
    assert.deepEqual(resumes(), [first.id], 'a resume for the unblocked child only');
    await turnEnded(rig, id);
    assert.deepEqual(rig.sessions.children.filter((c) => c.scope === id), [], 'no session child');
  });

  test('a retro runs in code', async (t) => {
    for (const row of ['a retro with a spec', 'a retro that proposes nothing'] as const) {
      const rig = codeDriverRig(t, { env: row === 'a retro that proposes nothing' ? { FAKE_RETRO_EMPTY: '1' } : {} });
      const { root, pool } = rig;
      const { id } = jobAt(root, 'backlog', { state: 'queued', create: { kind: 'retro' } });
      resume(rig, id);
      pool.start('boot');
      if (row === 'a retro with a spec') await waitFor(() => loadJob(root, id).waitingOn === 'spec-approval', { timeoutMs: 60_000, what: `${row}: the spec gate` });
      else await waitFor(() => loadJob(root, id).state === 'cancelled', { timeoutMs: 60_000, what: `${row}: the cancel` });
      await turnEnded(rig, id);
      const ran = rig.log(id).filter((l) => l.event === 'ran').map((l) => l.rule);
      assert.ok(['K1b', 'K1c'].every((r) => ran.includes(r)), `${row}: ${ran.join(', ')}`);
      assert.ok(rig.log(id).some((l) => l.event === 'role-start' && l.role === 'retro'), `${row}: the retro ran`);
      if (row === 'a retro that proposes nothing') assert.equal(loadJob(root, id).reason, 'the retro proposed nothing: it wrote no spec.md');
      else assert.equal(loadJob(root, id).stage, 'spec');
      assert.deepEqual(rig.sessions.children.filter((c) => c.scope === id), [], `${row}: no session child`);
      await pool.close();
    }
  });

  test('a retro runs each digest batch once, in order', async (t) => {
    // `retro prepare` left two batches: each digest is a real role run, so its `agent-start` holds the job-dir-relative output K1d matches.
    const rig = codeDriverRig(t);
    const { root, pool } = rig;
    const { id } = jobAt(root, 'backlog', { state: 'queued', create: { kind: 'retro' } });
    const dir = path.join(root, '.forge', 'jobs', id);
    fs.mkdirSync(path.join(dir, 'digest'));
    fs.writeFileSync(path.join(dir, 'stats.json'), '{}\n');
    for (const n of [1, 2]) fs.writeFileSync(path.join(dir, 'digest', `batch-${n}.md`), `# Batch ${n}\n`);
    resume(rig, id);
    pool.start('boot');
    await waitFor(() => loadJob(root, id).waitingOn === 'spec-approval', { timeoutMs: 60_000, what: 'the spec gate' });
    await turnEnded(rig, id);
    assert.deepEqual(
      readEvents(root, id).filter((e) => e.type === 'agent-start').map((e) => [e.role, e.output]),
      [['digest', 'friction-1.md'], ['digest', 'friction-2.md'], ['retro', 'spec.md']],
    );
    assert.deepEqual(rig.log(id).filter((l) => l.event === 'role-start').map((l) => l.role), ['digest', 'digest', 'retro']);
    assert.ok(['friction-1.md', 'friction-2.md'].every((f) => fs.existsSync(path.join(dir, f))), 'each digest wrote its friction file');
    assert.deepEqual(rig.sessions.children.filter((c) => c.scope === id), [], 'no session child');
  });

  test('an adopted PR is read in code', async (t) => {
    const rig = codeDriverRig(t);
    const { root, pool } = rig;
    editConfigFile(root, (c) => void (c.tracker.kind = 'none'));
    const { id, branch } = jobAt(root, 'backlog', { state: 'queued' });
    const pr = { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, isCrossRepository: false, headRefName: branch, baseRefName: 'main' };
    rig.gh.set('pr list', JSON.stringify([pr]));
    rig.gh.set('pr view', JSON.stringify({ ...pr, headRefOid: null, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, statusCheckRollup: [], mergedAt: null }));
    rig.gh.set('api graphql', JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] } } } } }));
    resume(rig, id);
    pool.start('boot');
    await waitFor(() => loadJob(root, id).waitingOn === 'pr-review', { timeoutMs: 60_000, what: 'the pr-review park' });
    const job = loadJob(root, id);
    assert.deepEqual([job.stage, job.state, job.reason], ['pr', 'waiting', 'adopted PR 7 waits on review']);
    assert.ok(readEvents(root, id).some((e) => e.type === 'pr-synced'), 'a pr-synced event');
    await turnEnded(rig, id);
    assert.deepEqual(rig.sessions.children.filter((c) => c.scope === id), [], 'no session child');
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
