// The gate runner in-process over fakeClaude children: a malformed verdict asked again once, the hand-offs
// a run records, the title-only revise, failed runs that never leave a request claimed, and the office's
// daily cap. Nothing real is spawned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, fakeClaude, forgeInProcess, jobAt, parkedAt, readyGoal, repoTemplate, waitFor } from '../../../test/helpers.ts';
import type { FakeClaudeChild } from '../../../test/helpers.ts';
import * as yaml from '#core/format/yaml.ts';
import { loadConfig, trustDigest } from '#core/config/load.ts';
import { REQUEUE_REJECTED, enqueue, listRequests } from '#core/job/requests.ts';
import { jobDir, readEvents, setJob } from '#core/job/store.ts';
import { METER_VERSION, appendMeter, readMeter } from '#engine/metrics/meter.ts';
import { confineDigest } from '../session/confine.ts';
import { sessionOptions, type DaemonOptions, type SessionContext } from '../session/contract.ts';
import { createGateRunner } from './run.ts';
import { TITLE_ONLY_FEEDBACK } from './decide.ts';
import type { ClaudeEvent } from '#integrations/claude/types.ts';

const ALL = ['spec-approval', 'split-approval', 'escalation', 'rounds-exhausted', 'conflicts', 'pr-feedback', 'repo-proposal', 'release', 'milestone-approval'];

const scratch = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ daemon: { enabled: true }, foreman: { enabled: true, decides: ALL, reserved: ['payments'], assistants: { enabled: true } } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

/** Edits config.yml before a harness takes its trust snapshot. */
function editConfig(root: string, edit: (c: any) => void): void {
  const file = path.join(root, '.forge', 'config.yml');
  const c = yaml.parse(fs.readFileSync(file, 'utf8'));
  edit(c);
  fs.writeFileSync(file, yaml.stringify(c));
}

/** A runner over `root` with the trust and confine snapshot a pool start takes. */
function harness(root: string, over: DaemonOptions = {}) {
  const fake = fakeClaude();
  const o = sessionOptions({ claude: fake.adapter, graceMs: 20, retryMinMs: 1, retryMaxMs: 1, ...over, env: { ...process.env, FORGE_ROOT: root } });
  const config = () => o.readConfig(root).config;
  const trusted = trustDigest(root);
  const confined = confineDigest(root, config());
  const stops: string[] = [];
  const ctx: SessionContext = {
    trusted: () => trusted,
    confined: () => confined,
    poolWanted: () => true,
    config,
    untrusted: () => void stops.push('untrusted'),
    fatal: (m) => void stops.push(m),
    emit: () => {},
    onResult: () => {},
    onExit: () => {},
    poke: () => {},
    permissionMode: () => null,
    permissionModeRefused: () => {},
    effort: () => ({ level: null, source: 'none' }),
    model: () => null,
  };
  const runner = createGateRunner(root, { ctx, o });
  const take = () => runner.take(config(), listRequests(root, { status: 'pending' }).filter((r) => r.type === 'gate'));
  const settled = () => waitFor(() => runner.state().live === 0, { what: 'every gate run ended' });
  return { fake, runner, take, settled, stops };
}

const cost = (usd: number) => ({ usd, models: { 'claude-sonnet-5-5': { usd, input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } } });
const answer = (c: FakeClaudeChild, text: string, usd = 0): void => c.emit({ kind: 'turn-ended', ok: true, text, cost: usd ? cost(usd) : null } as ClaudeEvent);
const request = (root: string, id: string) => listRequests(root).find((r) => r.id === id)!;
const human = (root: string, job: string) => readEvents(root, job).filter((e) => e.type === 'human');
const handoffs = (root: string, job: string) => readEvents(root, job).filter((e) => e.type === 'foreman-handoff');
const resumes = (root: string, job: string) => listRequests(root).filter((r) => r.type === 'resume' && r.job === job);

/** A job parked at `gate` with a request body (so it is not title-only) and its gate request. */
function parked(root: string, gate: 'spec-approval' | 'escalation' = 'spec-approval', args: Record<string, unknown> = {}) {
  const job = parkedAt(root, gate, { create: { body: 'Add a --json flag to forge status.' } }).id;
  const gid = enqueue(root, null, { type: 'gate', job, args: { gate, reserved: null, ...args }, from: 'forge' }).id;
  return { job, gid };
}

test('a malformed verdict is asked again once', async (t) => {
  const r = scratch();
  t.after(r.cleanup);
  const h = harness(r.dir);
  const a = parked(r.dir);
  h.take();
  assert.equal(h.fake.children.length, 1);
  const c = h.fake.children[0];
  assert.equal(c.scope, '_gates');
  assert.equal(c.briefs.length, 1);
  answer(c, 'I read the spec and it covers the request.');
  assert.equal(c.verdictRetries, 1, 'the fixed retry on the same child');
  answer(c, 'ASSIST: approve · fine now');
  await h.settled();
  assert.deepEqual([h.fake.children.length, c.briefs.length], [1, 1], 'no second brief, no second spawn');
  assert.deepEqual(human(r.dir, a.job).map((e) => [e.action, e.note]), [['approve-spec', 'fine now']]);
  assert.deepEqual([request(r.dir, a.gid).status, request(r.dir, a.gid).result], ['done', 'approve: fine now']);
  assert.equal(resumes(r.dir, a.job).length, 1);

  const b = parked(r.dir);
  h.take();
  const c2 = h.fake.children[1];
  answer(c2, 'ASSIST: approve - looks fine');
  answer(c2, 'Approve.');
  await h.settled();
  assert.equal(c2.verdictRetries, 1);
  assert.deepEqual(human(r.dir, b.job), [], 'a malformed reply never becomes a decision');
  assert.deepEqual(handoffs(r.dir, b.job).map((e) => [e.class, e.reason]), [['escalated', 'malformed verdict']]);
  assert.deepEqual([request(r.dir, b.gid).status, request(r.dir, b.gid).result], ['rejected', 'escalated: malformed verdict']);
  assert.equal(resumes(r.dir, b.job).length, 0);
  assert.equal(h.runner.state().runs[0].outcome, 'escalated');
});

test('a permission request is denied and the run goes on', async (t) => {
  const r = scratch();
  t.after(r.cleanup);
  const h = harness(r.dir);
  const a = parked(r.dir);
  h.take();
  const c = h.fake.children[0];
  c.emit({ kind: 'permission-asked', requestId: 'p1', tool: 'Bash', input: null, description: null, agentId: null, blockedPath: null, rules: [], dirs: [] });
  assert.deepEqual(c.answers, [{ requestId: 'p1', decision: 'deny' }], 'nobody could answer it: denied');
  answer(c, 'ASSIST: approve · fine');
  await h.settled();
  assert.equal(request(r.dir, a.gid).status, 'done');
});

test('the gate log records a start with the child pid, then an end', async (t) => {
  const r = scratch();
  t.after(r.cleanup);
  const h = harness(r.dir);
  const a = parked(r.dir);
  h.take();
  const c = h.fake.children[0];
  answer(c, 'ASSIST: approve · fine');
  await h.settled();
  const lines = fs.readFileSync(path.join(r.dir, '.forge', 'runtime', 'daemons', '_gates.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.event), ['gate-start', 'gate-end']);
  assert.deepEqual([lines[0].request, lines[0].pid, lines[1].outcome], [a.gid, c.pid, 'approve']);
});

test("a verdict does not end the backoff another run's failure started", async (t) => {
  const r = scratch();
  t.after(r.cleanup);
  const h = harness(r.dir, { retryMinMs: 60_000, retryMaxMs: 60_000 });
  const a = parked(r.dir);
  const b = parked(r.dir);
  h.take();
  assert.equal(h.fake.children.length, 2);
  h.fake.children[0].exit(1, null);
  await waitFor(() => h.runner.state().live === 1, { what: 'the first run failed' });
  assert.equal(h.runner.state().held?.reason, 'retry');
  answer(h.fake.children[1], 'ASSIST: approve · fine');
  await h.settled();
  assert.equal(request(r.dir, b.gid).status, 'done');
  assert.equal(h.runner.state().held?.reason, 'retry', 'still waiting out the failure');
  h.take();
  assert.equal(h.fake.children.length, 2, 'the failed request is not retaken at once');
  assert.equal(request(r.dir, a.gid).status, 'pending');
});

test("hand-offs match today's", async (t) => {
  const r = scratch();
  t.after(r.cleanup);
  const h = harness(r.dir);

  // The request's own reserved hit: no child.
  const reserved = parked(r.dir, 'spec-approval', { reserved: 'payments' });
  h.take();
  await h.settled();
  assert.equal(h.fake.children.length, 0, 'reserved: no child');
  assert.deepEqual([request(r.dir, reserved.gid).status, request(r.dir, reserved.gid).result], ['rejected', 'reserved: payments']);
  assert.deepEqual(handoffs(r.dir, reserved.job).map((e) => e.class), ['reserved']);

  // assist says stale: the job no longer waits.
  const moved = jobAt(r.dir, 'spec').id;
  const staleGate = enqueue(r.dir, null, { type: 'gate', job: moved, args: { gate: 'spec-approval', reserved: null }, from: 'forge' }).id;
  h.take();
  await h.settled();
  assert.equal(h.fake.children.length, 0, 'stale: no child');
  assert.deepEqual([request(r.dir, staleGate).status, request(r.dir, staleGate).result], ['done', 'stale']);

  // The policy refuses the decision: a reserved pattern in the reason.
  const refused = parked(r.dir);
  h.take();
  answer(h.fake.children[0], 'ASSIST: approve · the payments flow is covered');
  await h.settled();
  const why = '--actor foreman refused: reserved (payments): left for a human';
  assert.deepEqual([request(r.dir, refused.gid).status, request(r.dir, refused.gid).result], ['rejected', why]);
  assert.deepEqual(handoffs(r.dir, refused.job).map((e) => [e.class, e.reason]), [['refused', why]]);
  assert.deepEqual([human(r.dir, refused.job), resumes(r.dir, refused.job)], [[], []]);

  // The job moved off the gate before the decision: stale, no hand-off.
  const gone = parked(r.dir);
  h.take();
  setJob(r.dir, gone.job, { state: 'running' });
  answer(h.fake.children[1], 'ASSIST: approve · fine');
  await h.settled();
  assert.deepEqual([request(r.dir, gone.gid).status, request(r.dir, gone.gid).result], ['done', 'stale']);
  assert.deepEqual([handoffs(r.dir, gone.job), human(r.dir, gone.job)], [[], []]);

  // An escalation gate's rework: recorded, then the resume.
  const esc = parked(r.dir, 'escalation');
  h.take();
  answer(h.fake.children[2], 'ASSIST: rework · the tests miss AC2');
  await h.settled();
  assert.deepEqual(human(r.dir, esc.job).map((e) => e.action), ['rework']);
  assert.equal(resumes(r.dir, esc.job).length, 1);
  assert.equal(request(r.dir, esc.gid).result, 'rework: the tests miss AC2');
});

test('a release approved by the foreman records one release-approval and nothing else', async (t) => {
  const r = scratch();
  t.after(r.cleanup);
  editConfig(r.dir, (c) => (c.release = { ...c.release, mechanism: 'tag', command: 'true' }));
  const job = jobAt(r.dir, 'done', { create: { body: 'Ship it.' }, pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'MERGED' } }).id;
  const planned = await forgeInProcess(r.dir, ['release', 'plan', '--job', job]);
  assert.equal(planned.status, 0, JSON.stringify(planned.error));
  const gid = listRequests(r.dir).find((x) => x.type === 'gate' && x.args?.gate === 'release')?.id;
  assert.ok(gid, 'release plan queued the gate');
  const h = harness(r.dir);
  h.take();
  answer(h.fake.children[0], 'ASSIST: approve · the plan tags one repo');
  await h.settled();
  const events = readEvents(r.dir, job);
  assert.equal(events.filter((e) => e.type === 'release-approval').length, 1);
  assert.deepEqual([human(r.dir, job), handoffs(r.dir, job), resumes(r.dir, job)], [[], [], []]);
  assert.deepEqual([request(r.dir, gid).status, request(r.dir, gid).result], ['done', 'approve: the plan tags one repo']);
});

test('a milestone draft revised by the foreman queues a revision and no resume', async (t) => {
  const r = scratch();
  t.after(r.cleanup);
  const { request: key, digest } = await readyGoal(r.dir, 'g1', ['--decides', 'milestone-approval']);
  const gid = enqueue(r.dir, null, { type: 'gate', job: null, args: { gate: 'milestone-approval', mandate: 'g1', key, digest, reserved: null }, from: 'forge' }).id;
  const h = harness(r.dir);
  h.take();
  assert.equal(h.fake.children.length, 1);
  answer(h.fake.children[0], 'ASSIST: revise · split the second wave');
  await h.settled();
  assert.deepEqual([request(r.dir, gid).status, request(r.dir, gid).result], ['done', 'revise: split the second wave']);
  const drafts = listRequests(r.dir).filter((x) => x.type === 'draft' && x.args?.foreman === true);
  assert.deepEqual(drafts.map((x) => [x.args?.mandate, x.args?.note]), [['g1', 'split the second wave']]);
  assert.equal(listRequests(r.dir).filter((x) => x.type === 'resume').length, 0);
});

test('a title-only request comes back as revise once', async (t) => {
  const r = scratch();
  t.after(r.cleanup);
  const h = harness(r.dir);
  const job = parkedAt(r.dir, 'spec-approval', { title: 'Speed up forge status' }).id;
  const g1 = enqueue(r.dir, null, { type: 'gate', job, args: { gate: 'spec-approval', reserved: null }, from: 'forge' }).id;
  fs.writeFileSync(path.join(jobDir(r.dir, job), 'feedback.md'), 'old feedback\n');
  h.take();
  answer(h.fake.children[0], 'ASSIST: escalate · the request names no target');
  await h.settled();
  assert.deepEqual(human(r.dir, job).map((e) => [e.action, e.note]), [['revise-spec', 'title-only request: the request names no target']]);
  assert.equal(fs.readFileSync(path.join(jobDir(r.dir, job), 'feedback.md'), 'utf8'), TITLE_ONLY_FEEDBACK);
  assert.equal(resumes(r.dir, job).length, 1);
  assert.equal(request(r.dir, g1).status, 'done');

  // Parked there again with that revise-spec standing: the escalate stands.
  setJob(r.dir, job, { state: 'running' });
  setJob(r.dir, job, { state: 'waiting', waitingOn: 'spec-approval' });
  const g2 = enqueue(r.dir, null, { type: 'gate', job, args: { gate: 'spec-approval', reserved: null }, from: 'forge' }).id;
  h.take();
  answer(h.fake.children[1], 'ASSIST: escalate · still no target');
  await h.settled();
  assert.deepEqual(handoffs(r.dir, job).map((e) => [e.class, e.reason]), [['escalated', 'still no target']]);
  assert.equal(request(r.dir, g2).result, 'escalated: still no target');
  assert.equal(human(r.dir, job).length, 1);

  // A request with a body: the hand-off at once.
  const full = parked(r.dir);
  h.take();
  answer(h.fake.children[2], 'ASSIST: escalate · needs a person');
  await h.settled();
  assert.deepEqual([human(r.dir, full.job), handoffs(r.dir, full.job).map((e) => e.class)], [[], ['escalated']]);
});

test('failed runs are reclaimed', async (t) => {
  const rows: { name: string; opts?: DaemonOptions; act: (c: FakeClaudeChild, h: ReturnType<typeof harness>) => Promise<void> | void; want: { status: string; requeues: number | undefined }; check?: (h: ReturnType<typeof harness>, c: FakeClaudeChild) => void }[] = [
    { name: 'a child that exits without a result', act: (c) => c.exit(1, null), want: { status: 'pending', requeues: 1 } },
    {
      name: 'a usage limit',
      act: (c) => c.emit({ kind: 'turn-ended', ok: false, reason: 'usage limit reached', limit: true, resetsAt: Date.now() + 60_000, budget: false }),
      want: { status: 'pending', requeues: undefined },
      check: (h) => {
        h.take();
        assert.equal(h.fake.children.length, 1, 'no new child before resetsAt');
        assert.equal(h.runner.state().held?.reason, 'limit');
      },
    },
    { name: 'a failed turn', act: (c) => c.emit({ kind: 'turn-ended', ok: false, reason: 'Failed to authenticate', limit: false, resetsAt: null, budget: false }), want: { status: 'pending', requeues: 1 } },
    {
      name: 'a turn past the timeout',
      opts: { turnTimeoutMs: 30 },
      act: () => {},
      want: { status: 'pending', requeues: 1 },
      check: (_h, c) => assert.ok(c.signals.includes('SIGTERM'), 'signalled'),
    },
    { name: 'the pool stops mid-run', act: (_c, h) => h.runner.stop(), want: { status: 'pending', requeues: undefined } },
  ];
  for (const row of rows) {
    const r = scratch();
    t.after(r.cleanup);
    const h = harness(r.dir, row.opts);
    const a = parked(r.dir);
    h.take();
    const c = h.fake.children[0];
    assert.ok(c, row.name);
    await row.act(c, h);
    await h.settled();
    const rec = request(r.dir, a.gid);
    assert.deepEqual({ status: rec.status, requeues: rec.requeues }, row.want, row.name);
    assert.equal(rec.session, undefined, `${row.name}: no claim left`);
    row.check?.(h, c);
  }

  // The second failed run of one request: rejected, and handed to a person.
  const r = scratch();
  t.after(r.cleanup);
  const h = harness(r.dir);
  const a = parked(r.dir);
  h.take();
  h.fake.children[0].exit(1, null);
  await h.settled();
  await waitFor(() => h.runner.state().held === null, { what: 'the backoff over' });
  h.take();
  assert.equal(h.fake.children.length, 2, 'retried after the backoff');
  h.fake.children[1].exit(1, null);
  await h.settled();
  assert.deepEqual([request(r.dir, a.gid).status, request(r.dir, a.gid).result], ['rejected', REQUEUE_REJECTED]);
  assert.deepEqual(handoffs(r.dir, a.job).map((e) => [e.class, e.reason]), [['escalated', 'its gate run failed twice']]);
  assert.equal(h.runner.state().runs[0].outcome, 'failed');
});

test('no run starts at the office cap', async (t) => {
  const r = scratch();
  t.after(r.cleanup);
  editConfig(r.dir, (c) => (c.daemon.dailyUsd = { ...c.daemon.dailyUsd, office: 1 }));
  const rec = (scope: string, usd: number) => appendMeter(r.dir, { v: METER_VERSION, ts: new Date().toISOString(), scope, sessionId: null, spawnId: 's', turn: 1, usd, tokens: 0, models: {}, cum: { usd, models: {} } });
  rec('_office', 0.25);
  const h = harness(r.dir);
  const a = parked(r.dir);
  h.take();
  const c = h.fake.children[0];
  assert.equal(c.argv[c.argv.indexOf('--max-budget-usd') + 1], '0.75', 'the child is capped at what is left today');
  answer(c, 'ASSIST: approve · fine', 0.8);
  await h.settled();
  assert.deepEqual(readMeter(r.dir, '_gates').map((x) => x.usd), [0.8], 'the costed turn is metered to _gates');
  assert.equal(request(r.dir, a.gid).status, 'done');

  const b = parked(r.dir);
  h.take();
  assert.equal(h.fake.children.length, 1, 'no child at the cap');
  assert.equal(h.runner.state().held?.reason, 'daily-cap');
  assert.match(h.runner.state().held?.message ?? '', /the office session and its gate runs spent \$1\.05 of the \$1\.00 daily cap/);
  assert.equal(request(r.dir, b.gid).status, 'pending');
  h.runner.take(loadConfig(r.dir).config, []);
  assert.equal(h.runner.state().held, null, 'no request waits any more: nothing is held');
});
