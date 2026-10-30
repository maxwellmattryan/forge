// createPool's intake runner in-process: each inbox request is answered by `forge` children (a stub
// runForge that records args and env, or real bin/forge children), never a claude session; `next` runs
// readiness triage once as a one-shot forge:triage child (a fakeClaude child). docs/architecture/daemon.md ›
// Intake runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, fakeClaude, forgeAsync, repoTemplate, tempRepo, waitFor } from '../../helpers.ts';
import * as yaml from '#core/format/yaml.ts';
import { CONFIG_SCHEMA_VERSION } from '#core/job/schema.ts';
import { loadConfig } from '#core/config/load.ts';
import { REQUEUE_REJECTED, enqueue, listRequests } from '#core/job/requests.ts';
import { readInfo, sessionFiles } from '#core/job/session-files.ts';
import { leaseStatus, loadJob } from '#core/job/store.ts';
import { slugify } from '#core/text.ts';
import { readMeter } from '#engine/metrics/meter.ts';
import { createPool } from '#office/pool.ts';
import type { PoolOptions } from '#office/modes.ts';
import { createMachineSlots } from '#office/slots.ts';
import { writeRoots } from '#office/session/confine.ts';
import { TRUST_CHANGED } from '#office/session/launch.ts';
import type { ForgeCall, ForgeCaller } from '#office/inbox/children.ts';
import type { ClaudeEvent } from '#integrations/claude/types.ts';
import type { ForgeRequest } from '#core/types.ts';

const noPass = async (): Promise<string | null> => null;

/** A temp repo whose config.yml is `extra` over an enabled daemon; removed after the test (after its pool closes). */
function daemonRepo(t: any, extra: Record<string, unknown> = {}) {
  const repo = tempRepo();
  const root = repo.dir;
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  const { daemon, ...rest } = extra as { daemon?: Record<string, unknown> };
  fs.writeFileSync(path.join(root, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, daemon: { enabled: true, command: 'claude {session}', ...daemon }, ...rest }));
  t.after(repo.cleanup);
  return root;
}

interface Stub {
  calls: { args: string[]; env: NodeJS.ProcessEnv; signal: AbortSignal }[];
  runForge: ForgeCaller;
}

/** A runForge stand-in: records each call and answers with `answer`'s result over a zero exit with no output. */
function stub(answer: (args: string[], n: number) => Partial<ForgeCall> | Promise<Partial<ForgeCall>> = () => ({ json: {} })): Stub {
  const calls: Stub['calls'] = [];
  const runForge: ForgeCaller = async (args, o) => {
    calls.push({ args, env: o.env, signal: o.stop.signal });
    return { code: 0, signal: null, json: null, error: null, ms: 1, ...(await answer(args, calls.length)) };
  };
  return { calls, runForge };
}

/** A pool over `root`, closed after the test (before its repo is removed: t.after runs last-in first-out). */
function poolFor(t: any, root: string, opts: PoolOptions) {
  const p = createPool(root, { pollMs: 3_600_000, syncMs: 0, reconcileMs: 0, graceMs: 20, runPass: noPass, ...opts });
  t.after(() => p.close());
  return p;
}

const intakeId = (root: string): string => readInfo(sessionFiles(root, '_inbox').info).intakeSessionId;
const request = (root: string, id: string): ForgeRequest => listRequests(root).find((r) => r.id === id)!;
const closed = (root: string, id: string) => ['done', 'rejected'].includes(request(root, id)?.status);
const logged = (pool: ReturnType<typeof createPool>, event: string): Record<string, any>[] =>
  pool
    .recent('_inbox')
    .map((l) => JSON.parse(l.line))
    .filter((x) => x.event === event);

/** A request file as a hand-written one would be: past enqueue's checks. */
function writeRequest(root: string, rec: Partial<ForgeRequest> & { type: string }): string {
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const dir = path.join(root, '.forge', 'runtime', 'requests');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, job: null, text: null, args: {}, from: 'cli', status: 'pending', createdAt: new Date().toISOString(), ...rec }));
  return id;
}

test('a sync request is answered by a forge child, with no claude session', async (t) => {
  const root = daemonRepo(t);
  const { config } = loadConfig(root);
  const r = enqueue(root, config, { type: 'sync', from: 'dashboard' });
  const s = stub(() => ({ json: { synced: 0, results: [], requests: 0, integrating: [] } }));
  const fake = fakeClaude();
  const pool = poolFor(t, root, { claude: fake.adapter, runForge: s.runForge, env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test' } });
  pool.start();
  await waitFor(() => closed(root, r.id), { what: 'the sync request acked' });
  const S = intakeId(root);
  assert.match(S, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ status: request(root, r.id).status, result: request(root, r.id).result, session: request(root, r.id).session }, { status: 'done', result: 'synced 0; 0 requests queued', session: S });
  assert.deepEqual(s.calls.map((c) => c.args), [['sync']]);
  const env = s.calls[0]!.env;
  assert.deepEqual([env.FORGE_DAEMON, env.FORGE_MODE, env.FORGE_ROOT, env.FORGE_DAEMON_SCOPE], ['1', 'agent', root, '_inbox']);
  assert.equal(env.FORGE_DAEMON_TRUST, pool.trusted());
  assert.deepEqual(JSON.parse(env.FORGE_DAEMON_WRITE_ROOTS!), writeRoots(root, config));
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'no API key under subscription auth');
  assert.deepEqual(fake.children, []);
});

/** Answers a `next` plan: triage with nothing pending, each `next` call from `results` in turn, every hand-off ok. */
const nextPlan = (results: unknown[]) => {
  let i = 0;
  return (args: string[]): Partial<ForgeCall> => (args[0] === 'tracker' ? { json: { batch: null, pending: 0, items: [], skipped: 0 } } : args[0] === 'next' ? { json: results[i++] } : { json: { released: true } });
};
const claim = (S: string) => ['next', '--claim', `--session=${S}`];
const resume = (id: string, S: string | null, intake: string | null) => ['requests', 'add', 'resume', `--job=${id}`, ...(intake ? [`--intake=${intake}`] : []), ...(S ? [`--session=${S}`] : [])];
const TRIAGE = ['tracker', 'triage', '--limit=10'];

test('the intake runner answers each request type', async (t) => {
  type Row = {
    name: string;
    req: Partial<ForgeRequest> & { type: string };
    answer?: (args: string[], n: number) => Partial<ForgeCall>;
    calls: (S: string) => string[][];
    status: 'done' | 'rejected';
    result: string | RegExp;
  };
  const evalAnswer = (args: string[]): Partial<ForgeCall> => (args[0] === 'eval' ? { json: { id: '20261030-120000', tasks: [{ job: 'e1' }, { job: 'e2' }] } } : { json: {} });
  const rows: Row[] = [
    { name: '(a) next n 2', req: { type: 'next', args: { n: 2 } }, answer: nextPlan([{ id: 'a' }, { id: 'b' }]), calls: (S) => [TRIAGE, claim(S), resume('a', S, 'next'), claim(S), resume('b', S, 'next')], status: 'done', result: 'handed off to a, b' },
    { name: '(b) next with no more work', req: { type: 'next', args: { n: 2 } }, answer: nextPlan([{ id: 'a' }, { item: null }]), calls: (S) => [TRIAGE, claim(S), resume('a', S, 'next'), claim(S)], status: 'done', result: 'handed off to a' },
    { name: 'next with no ready work', req: { type: 'next' }, answer: nextPlan([{ item: null }]), calls: (S) => [TRIAGE, claim(S)], status: 'done', result: 'no ready work' },
    { name: '(c) next held by the repo budget', req: { type: 'next' }, answer: nextPlan([{ held: true, repoBudget: { reason: 'repo budget: $5.00 of $5.00 this month' } }]), calls: (S) => [TRIAGE, claim(S)], status: 'done', result: 'held: repo budget: $5.00 of $5.00 this month' },
    ...[0, 11, '2'].map((n): Row => ({ name: `(d) next with n ${JSON.stringify(n)}`, req: { type: 'next', args: { n } }, calls: () => [], status: 'rejected', result: 'args.n must be an integer from 1 to 10' })),
    { name: '(e) run', req: { type: 'run', args: { ref: '12' } }, answer: (a) => ({ json: a[0] === 'job' ? { id: 'j12', ref: '12' } : {} }), calls: (S) => [['job', 'from-ref', `--session=${S}`, '--', '12'], resume('j12', S, 'run')], status: 'done', result: 'handed off to j12' },
    { name: '(f) run held', req: { type: 'run', args: { ref: '12' } }, answer: () => ({ code: 4, error: 'repo budget: $5.00 of $5.00 this month' }), calls: (S) => [['job', 'from-ref', `--session=${S}`, '--', '12']], status: 'done', result: 'held: repo budget: $5.00 of $5.00 this month' },
    { name: 'run refused', req: { type: 'run', args: { ref: '12' } }, answer: () => ({ code: 1, error: 'no issue 12' }), calls: (S) => [['job', 'from-ref', `--session=${S}`, '--', '12']], status: 'rejected', result: 'no issue 12' },
    // AC3: no child runs for a ref that is missing, empty, too long, multi-line or flag-shaped.
    ...[undefined, '', 'x'.repeat(201), '12\nmore', '--now'].map((ref): Row => ({ name: `run with ref ${JSON.stringify(ref)?.slice(0, 20)}`, req: { type: 'run', args: ref === undefined ? {} : { ref } }, calls: () => [], status: 'rejected', result: 'a run request needs args.ref, a tracker ref' })),
    {
      name: '(g) a mandate retro',
      req: { type: 'retro', args: { mandate: 'm-1a2b3c4d' } },
      answer: (a) => ({ json: a[0] === 'job' ? { id: 'r1' } : {} }),
      calls: (S) => [['job', 'new', '--kind=retro', '--title=Forge retro: mandate m-1a2b3c4d', `--session=${S}`], ['retro', 'prepare', 'r1', '--mandate=m-1a2b3c4d'], resume('r1', S, null)],
      status: 'done',
      result: 'handed off to r1',
    },
    {
      name: 'a retro whose prepare fails',
      req: { type: 'retro' },
      answer: (a) => (a[0] === 'retro' ? { code: 1, error: 'no stats' } : { json: a[0] === 'job' ? { id: 'r2' } : {} }),
      calls: (S) => [['job', 'new', '--kind=retro', `--title=Forge retro ${new Date().toISOString().slice(0, 10)}`, `--session=${S}`], ['retro', 'prepare', 'r2'], resume('r2', S, null)],
      status: 'done',
      result: 'handed off to r2; retro prepare failed: no stats',
    },
    { name: '(h) eval-run', req: { type: 'eval-run', args: { tags: 'a', label: '' } }, answer: evalAnswer, calls: () => [['eval', 'start', '--tags=a'], resume('e1', null, null), resume('e2', null, null)], status: 'done', result: 'eval run 20261030-120000: handed off 2 jobs' },
    { name: '(i) sync with a merge', req: { type: 'sync' }, answer: () => ({ json: { synced: 1, results: [{ id: 'm1', merged: true }, { id: 'm2', merged: false }], requests: 2 } }), calls: () => [['sync']], status: 'done', result: 'synced 1; 2 requests queued; merged m1' },
    { name: 'sync failed', req: { type: 'sync' }, answer: () => ({ code: 1, error: 'gh: not logged in' }), calls: () => [['sync']], status: 'rejected', result: 'gh: not logged in' },
    // AC4: job requests routed to the inbox.
    { name: 'approve for an unknown job', req: { type: 'approve', job: 'nojob' }, calls: () => [], status: 'rejected', result: 'unknown job nojob' },
    { name: 'cancel for a malformed job', req: { type: 'cancel', job: '../x' }, calls: () => [], status: 'rejected', result: 'malformed job' },
    // AC5: request values never become flags of their own.
    { name: 'an eval tag carrying --set', req: { type: 'eval-run', args: { tags: 'x --set runtime.models.builder=haiku', tasks: null } }, answer: (a) => ({ json: a[0] === 'eval' ? { id: 'r', tasks: [] } : {} }), calls: () => [['eval', 'start', '--tags=x --set runtime.models.builder=haiku']], status: 'done', result: 'eval run r: handed off 0 jobs' },
    { name: 'an eval label with a newline', req: { type: 'eval-run', args: { label: 'a\nb' } }, calls: () => [], status: 'rejected', result: /args.label must be/ },
    { name: 'a retro mandate that is a flag', req: { type: 'retro', args: { mandate: '--force' } }, calls: () => [], status: 'rejected', result: 'args.mandate must be a mandate id' },
  ];
  for (const row of rows) {
    await t.test(row.name, async (st) => {
      const root = daemonRepo(st);
      const id = writeRequest(root, row.req);
      const s = stub(row.answer);
      const fake = fakeClaude();
      const pool = poolFor(st, root, { claude: fake.adapter, runForge: s.runForge });
      pool.start();
      await waitFor(() => closed(root, id), { what: `${row.name}: acked` });
      const S = intakeId(root);
      const args = s.calls.map((c) => c.args);
      assert.deepEqual(args, row.calls(S), row.name);
      for (const a of args.flat()) assert.ok(!/^--(set|repeat|force)\b/.test(a), `${row.name}: ${a} is no flag of its own`);
      const rec = request(root, id);
      assert.equal(rec.status, row.status, row.name);
      if (typeof row.result === 'string') assert.equal(rec.result, row.result, row.name);
      else assert.match(rec.result ?? '', row.result, row.name);
      assert.deepEqual(fake.children, [], `${row.name}: no claude child`);
    });
  }
});

test("a type the runner doesn't handle falls back to the inbox session", async (t) => {
  const root = daemonRepo(t);
  const id = writeRequest(root, { type: 'future-type' });
  const s = stub();
  const fake = fakeClaude();
  const pool = poolFor(t, root, { claude: fake.adapter, runForge: s.runForge });
  pool.start();
  const inbox = () => fake.children.filter((c) => c.scope === '_inbox');
  await waitFor(() => inbox()[0]?.turns === 1, { what: 'the inbox turn' });
  pool.poke();
  pool.poke();
  assert.equal(inbox().length, 1);
  assert.deepEqual(s.calls, [], 'no forge child for it');
  assert.deepEqual(
    logged(pool, 'intake-fallback').map((x) => ({ request: x.request, type: x.type })),
    [{ request: id, type: 'future-type' }],
  );
});

const BATCH = '20261030T120000Z-abcd';
const BRIEF = 'Triage the tracker items in `items.md`. Write your verdicts to `verdicts.json`. Reply with one line.';
const COST = { usd: 0.02, models: { 'claude-haiku-4-5': { usd: 0.02, input: 1000, output: 50, cacheRead: 0, cacheWrite: 0 } } };

/** Answers a `next` with one item pending triage; `prep` overrides the first triage call. */
const triagePlan = (prep: Partial<ForgeCall> = { json: { batch: BATCH, pending: 1, items: [], skipped: 0, prs: 'off', subagent: 'forge:triage', model: 'haiku', effort: null, brief: BRIEF } }) => (args: string[]): Partial<ForgeCall> => {
  if (args[0] === 'tracker') return args[2] === '--limit=10' ? prep : { json: { batch: BATCH, results: [], ready: 1, needsInfo: 0, skipped: 0 } };
  return { json: args[0] === 'next' ? { item: null } : {} };
};
const triageRoot = (t: any, extra: Record<string, unknown> = {}) => {
  const root = daemonRepo(t, extra);
  fs.mkdirSync(path.join(root, '.forge', 'runtime', 'triage', BATCH), { recursive: true });
  return root;
};
const after = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

test('next runs triage once as a one-shot forge:triage child', async (t) => {
  const root = triageRoot(t);
  const real = fs.realpathSync(root);
  const r = enqueue(root, null, { type: 'next', from: 'dashboard' });
  const s = stub(triagePlan());
  const fake = fakeClaude();
  const pool = poolFor(t, root, { claude: fake.adapter, runForge: s.runForge });
  pool.start();
  await waitFor(() => fake.children.length === 1, { what: 'the triage child' });
  const c = fake.children[0]!;
  assert.equal(c.cwd, root);
  const argv = c.argv;
  assert.deepEqual([after(argv, '--agent'), after(argv, '--tools'), after(argv, '--permission-mode'), after(argv, '--setting-sources'), after(argv, '--model')], ['forge:triage', 'Read,Write', 'dontAsk', '', 'haiku']);
  for (const flag of ['--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(argv.includes(flag), flag);
  assert.equal(after(argv, '--allowedTools'), `Read,Edit(/${path.join(real, '.forge', 'runtime', 'triage', BATCH)}/**)`);
  const deny = after(argv, '--disallowedTools').split(',');
  assert.ok(deny.includes(`Edit(/${real}/.forge/config.yml)`), 'config.yml denied');
  assert.ok(deny.includes(`Edit(/${real}/.forge/notes/**)`), 'notes denied');
  assert.deepEqual(deny.filter((x) => x.endsWith('/.forge/runtime/**)')), [], 'the runtime rule is left out');
  assert.deepEqual([c.env.FORGE_DAEMON, c.env.FORGE_DAEMON_SCOPE, c.env.FORGE_DAEMON_TRUST], ['1', '_inbox', pool.trusted()]);
  assert.equal(c.env.FORGE_DAEMON_WRITE_ROOTS, JSON.stringify({ jobs: path.join(real, '.forge', 'runtime', 'triage'), worktrees: [] }));
  assert.deepEqual(c.briefs, [BRIEF]);
  assert.deepEqual(s.calls.map((x) => x.args), [TRIAGE], '--apply waits for the child');

  c.emit({ kind: 'turn-ended', ok: true, summary: 'TRIAGE: 1 ready · 0 needs-info', text: 'TRIAGE: 1 ready · 0 needs-info', cost: COST } as ClaudeEvent);
  await waitFor(() => closed(root, r.id), { what: 'the next request acked' });
  assert.deepEqual(s.calls.map((x) => x.args), [TRIAGE, ['tracker', 'triage', `--apply=${BATCH}`], claim(intakeId(root))]);
  assert.equal(fake.children.length, 1, 'one triage child');
  assert.deepEqual(readMeter(root, '_inbox').map((m) => [m.scope, m.usd]), [['_inbox', 0.02]]);
  const line = logged(pool, 'triage')[0]!;
  assert.deepEqual({ reply: line.reply, ok: line.ok, ready: line.ready, needsInfo: line.needsInfo, batch: line.batch, error: line.error }, { reply: 'TRIAGE: 1 ready · 0 needs-info', ok: true, ready: 1, needsInfo: 0, batch: BATCH, error: undefined });
});

test('triage failures are logged, never blocking', async (t) => {
  const rows: { name: string; extra?: Record<string, unknown>; prep?: Partial<ForgeCall>; child?: 'exit' | null; setup?: (root: string) => void }[] = [
    { name: 'the child exits without a result', child: 'exit' },
    { name: 'tracker triage exits 1', prep: { code: 1, error: 'tracker unavailable' }, child: null },
    { name: "the inbox's daily cap is reached", extra: { daemon: { dailyUsd: { inbox: 0 } } }, child: null },
    {
      name: 'the triage dir is a link out of the checkout',
      child: null,
      setup: (root) => {
        const triage = path.join(root, '.forge', 'runtime', 'triage');
        const away = `${root}.away`;
        fs.mkdirSync(path.join(away, BATCH), { recursive: true });
        fs.rmSync(triage, { recursive: true });
        fs.symlinkSync(away, triage);
        t.after(() => fs.rmSync(away, { recursive: true, force: true }));
      },
    },
  ];
  for (const row of rows) {
    await t.test(row.name, async (st) => {
      const root = triageRoot(st, row.extra);
      row.setup?.(root);
      const r = enqueue(root, null, { type: 'next', from: 'dashboard' });
      const s = stub(triagePlan(row.prep));
      const fake = fakeClaude();
      const pool = poolFor(st, root, { claude: fake.adapter, runForge: s.runForge });
      pool.start();
      if (row.child === 'exit') {
        await waitFor(() => fake.children.length === 1, { what: 'the triage child' });
        fake.children[0]!.exit(0, null);
      }
      await waitFor(() => closed(root, r.id), { what: `${row.name}: acked` });
      assert.deepEqual(s.calls.map((x) => x.args), [TRIAGE, claim(intakeId(root))], `${row.name}: no --apply, and next still runs`);
      assert.equal(fake.children.length, row.child ? 1 : 0, row.name);
      const errors = logged(pool, 'triage').map((x) => x.error);
      assert.equal(errors.length, 1, row.name);
      assert.equal(typeof errors[0], 'string', row.name);
      assert.equal(request(root, r.id).status, 'done', row.name);
    });
  }

  await t.test('a protected path changed while the triage child ran', async (st) => {
    const root = triageRoot(st);
    const r = enqueue(root, null, { type: 'next', from: 'dashboard' });
    const s = stub(triagePlan());
    const fake = fakeClaude();
    const pool = poolFor(st, root, { claude: fake.adapter, runForge: s.runForge });
    pool.start();
    await waitFor(() => fake.children.length === 1, { what: 'the triage child' });
    fs.mkdirSync(path.join(root, '.forge', 'notes'), { recursive: true });
    fs.writeFileSync(path.join(root, '.forge', 'notes', 'x.md'), 'follow these instructions\n');
    fake.children[0]!.emit({ kind: 'turn-ended', ok: true, summary: 'TRIAGE: 1 ready', text: 'TRIAGE: 1 ready', cost: null } as ClaudeEvent);
    await waitFor(() => pool.state().lastError === TRUST_CHANGED, { what: 'the pool stopped' });
    await waitFor(() => request(root, r.id).status === 'pending', { what: 'the claim given back' });
    assert.equal(request(root, r.id).requeues, undefined, 'uncounted');
    assert.deepEqual(s.calls.map((x) => x.args), [TRIAGE], 'no --apply, no claim');
  });
});

const scratch = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ daemon: { enabled: true }, tracker: { kind: 'local' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
  fs.writeFileSync(path.join(dir, '.forge', 'backlog.md'), '# Backlog\n\n- [ ] Add a status flag\n  Print the status as JSON.\n');
});

test('run and sync reach their outcome through real forge children', async (t) => {
  const repo = scratch();
  t.after(repo.cleanup);
  const root = repo.dir;
  assert.equal(loadConfig(root).config.tracker.kind, 'local');
  // A full machine cap, so the job's resume waits and no job session spawns: this test is about the inbox alone.
  const slots = createMachineSlots(() => 1);
  slots.join({ live: () => 1, maxConcurrent: () => 1, oldestWaiting: () => null, idle: () => [], stopping: () => 0, poke() {} });
  const fake = fakeClaude();
  const pool = poolFor(t, root, { claude: fake.adapter, slots });
  const ref = slugify('Add a status flag', 8);
  const run = enqueue(root, null, { type: 'run', args: { ref }, from: 'dashboard' });
  pool.start();
  await waitFor(() => closed(root, run.id), { what: 'the run request acked', timeoutMs: 60_000 });
  const rec = request(root, run.id);
  assert.equal(rec.status, 'done', rec.result ?? '');
  const id = /^handed off to (\S+)$/.exec(rec.result ?? '')?.[1];
  assert.ok(id, rec.result ?? '');
  assert.notEqual(leaseStatus(loadJob(root, id!)).status, 'live', 'the hand-off released the lease');
  const resume = listRequests(root, { status: 'pending' }).find((x) => x.type === 'resume' && x.job === id);
  assert.deepEqual([resume?.from, resume?.args?.intake], ['daemon:_inbox', 'run']);
  const claimed = await forgeAsync(root, ['job', 'claim', id!, '--session', crypto.randomUUID()]);
  assert.equal(claimed.status, 0, claimed.stderr);

  const sync = enqueue(root, null, { type: 'sync', from: 'dashboard' });
  pool.poke();
  await waitFor(() => closed(root, sync.id), { what: 'the sync request acked', timeoutMs: 60_000 });
  assert.equal(request(root, sync.id).status, 'done', request(root, sync.id).result ?? '');
  assert.deepEqual(fake.children, []);
  const ends = logged(pool, 'intake-end');
  assert.deepEqual(ends.map((x) => [x.request, typeof x.waitMs, typeof x.runMs]), [[run.id, 'number', 'number'], [sync.id, 'number', 'number']]);
});

test('intake runs give claims back on a stop and requeue a failed one once', async (t) => {
  await t.test('a stop mid-run', async (st) => {
    const root = daemonRepo(st);
    const r = enqueue(root, null, { type: 'sync', from: 'dashboard' });
    let aborted = false;
    // A child that runs until its stop signal aborts, as a killed one ends.
    const s = stub((_a) => new Promise((resolve) => s.calls.at(-1)!.signal.addEventListener('abort', () => ((aborted = true), resolve({ code: null, signal: 'SIGTERM' })))));
    const pool = poolFor(st, root, { claude: fakeClaude().adapter, runForge: s.runForge });
    pool.start();
    await waitFor(() => s.calls.length === 1, { what: 'the sync child' });
    await pool.stop();
    assert.equal(aborted, true, 'the child got its stop');
    assert.deepEqual([request(root, r.id).status, request(root, r.id).requeues], ['pending', undefined]);
  });

  await t.test('a child that never starts', async (st) => {
    const root = daemonRepo(st);
    const r = enqueue(root, null, { type: 'sync', from: 'dashboard' });
    const s = stub(() => ({ code: null, error: 'spawn node ENOENT' }));
    const retryMinMs = 300;
    const pool = poolFor(st, root, { claude: fakeClaude().adapter, runForge: s.runForge, retryMinMs, retryMaxMs: 1000 });
    pool.start();
    await waitFor(() => request(root, r.id).requeues === 1 && request(root, r.id).status === 'pending', { what: 'requeued once' });
    const failedAt = Date.now();
    pool.poke();
    await new Promise((res) => setImmediate(res));
    assert.equal(s.calls.length, 1, 'no run inside the backoff');
    await waitFor(
      () => {
        pool.poke();
        return request(root, r.id).status === 'rejected';
      },
      { what: 'rejected the second time' },
    );
    assert.ok(Date.now() - failedAt >= retryMinMs - 100, 'the second run waited out the backoff');
    assert.equal(s.calls.length, 2);
    assert.match(request(root, r.id).result ?? '', new RegExp(REQUEUE_REJECTED));
  });
});

test("the inbox lane's state follows the intake runner", async (t) => {
  const root = daemonRepo(t);
  let release: ((r: Partial<ForgeCall>) => void) | null = null;
  let fail = true;
  const s = stub(() => {
    if (fail) {
      fail = false;
      return { code: null, error: 'spawn node ENOENT' };
    }
    // Pending until the test releases it, or until its stop (the pool's close) aborts it.
    return new Promise((resolve) => {
      release = resolve;
      s.calls.at(-1)!.signal.addEventListener('abort', () => resolve({ code: null, signal: 'SIGTERM' }));
    });
  });
  const fake = fakeClaude();
  const pool = poolFor(t, root, { claude: fake.adapter, runForge: s.runForge, retryMinMs: 50, retryMaxMs: 100 });
  pool.start();
  assert.deepEqual(fake.children, [], 'a start with no request spawns nothing');
  assert.equal(pool.state().inbox.status, 'idle');

  const r = enqueue(root, null, { type: 'sync', from: 'dashboard' });
  pool.poke();
  await waitFor(() => pool.state().inbox.lastError === 'spawn node ENOENT', { what: "the failed start's error" });
  await waitFor(
    () => {
      pool.poke();
      return release !== null;
    },
    { what: 'the second run' },
  );
  assert.equal(pool.state().inbox.status, 'busy');
  release!({ json: { synced: 0, results: [], requests: 0 } });
  await waitFor(() => closed(root, r.id), { what: 'acked' });
  await waitFor(() => pool.state().inbox.status === 'idle', { what: 'idle again' });
  assert.deepEqual([pool.state().inbox.turns, pool.state().inbox.lastError, pool.state().inbox.failures], [1, null, 0]);
  const events = pool.recent('_inbox').map((l) => JSON.parse(l.line).event);
  assert.ok(events.includes('intake-start') && events.includes('intake-end'), events.join(','));

  await pool.stopSession('_inbox');
  const later = enqueue(root, null, { type: 'sync', from: 'dashboard' });
  fail = false;
  release = null;
  pool.poke();
  assert.equal(request(root, later.id).status, 'pending', 'a stopped inbox takes nothing');
  assert.deepEqual(pool.startSession('_inbox'), { error: null });
  await waitFor(() => request(root, later.id).status === 'in-progress', { what: 'claimed after Start' });
  assert.deepEqual(fake.children, []);
});
