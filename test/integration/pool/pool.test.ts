// createPool in-process over fakeClaude children: where a pool start routes a pending request, and what
// it does with what earlier `forge dash` sessions left behind (docs/test-rewrite/modules/office.md).
// Nothing real is spawned or signalled.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fakeClaude, tempRepo, waitFor } from '../../helpers.ts';
import * as yaml from '#core/format/yaml.ts';
import { CONFIG_SCHEMA_VERSION } from '#core/job/schema.ts';
import { loadConfig } from '#core/config/load.ts';
import { createJob, loadJob, readEvents, recordAgent, updateJob } from '#core/job/store.ts';
import { claimRequest, enqueue, listRequests } from '#core/job/requests.ts';
import { sessionFiles } from '#core/job/session-files.ts';
import { createPool } from '#office/pool.ts';
import { createMachineSlots } from '#office/slots.ts';
import { CHAT_PROMPT } from '#office/session/launch.ts';

test('a draft request turns the office session, never the inbox', async (t) => {
  for (const foreman of [true, false]) {
    const repo = tempRepo();
    t.after(repo.cleanup);
    const root = repo.dir;
    fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
    fs.writeFileSync(path.join(root, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, daemon: { enabled: true, command: 'claude {session}' }, foreman: { enabled: foreman } }));
    const { config } = loadConfig(root);
    const r = enqueue(root, config, { type: 'draft', args: { mandate: 'g1' }, from: 'forge' });
    const fake = fakeClaude();
    const pool = createPool(root, { claude: fake.adapter, pollMs: 3_600_000, syncMs: 0, reconcileMs: 0, graceMs: 50 });
    t.after(() => pool.close());
    pool.start('boot');
    const of = (scope: string) => fake.children.filter((c) => c.scope === scope);
    if (foreman) {
      await waitFor(() => of('_office')[0]?.turns === 1, { what: 'the office turn' });
      assert.equal(of('_office').length, 1);
    } else {
      pool.poke();
      assert.deepEqual(of('_office'), [], 'no office session while the foreman is off');
      assert.equal(listRequests(root).find((x) => x.id === r.id)?.status, 'pending');
    }
    assert.ok(of('_inbox').every((c) => c.turns === 0), 'the inbox gets no turn for it');
    assert.deepEqual(fake.children.filter((c) => c.scope !== '_office' && c.scope !== '_inbox'), [], 'no job session');
    await pool.close();
  }
});

// B59: boot releases whatever a recorded session's ids drove, under any of its ids.
test("boot releases every recorded session's jobs and leaves interactive ones alone", async (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  const root = repo.dir;
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(root, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, daemon: { enabled: true, command: 'claude {session}' } }));
  const { config } = loadConfig(root);
  const [y, s, p, i] = Array.from({ length: 4 }, () => crypto.randomUUID());
  const a = createJob(root, config, { title: 'driven by an earlier dash' }).id;
  const b = createJob(root, config, { title: 'driven by an interactive session' }).id;
  // An earlier dash's session for job A: spawned as S, now Y, once P. Its child is gone (pid null).
  const f = sessionFiles(root, a);
  fs.mkdirSync(f.dir, { recursive: true });
  fs.writeFileSync(f.info, JSON.stringify({ sessionId: y, spawnSessionId: s, pastSessionIds: [p], pid: null, resumable: false }));
  const lease = (job: string, driver: string) =>
    updateJob(root, job, (j) => {
      const at = new Date().toISOString();
      j.lease = { driver, epoch: 1, since: at, renewedAt: at, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
    });
  lease(a, p);
  lease(b, i);
  const claimed: Record<string, string> = {};
  for (const [job, by] of [
    [a, s],
    [b, i],
  ]) {
    recordAgent(root, job, { role: 'builder', phase: 'start' }, config);
    const r = enqueue(root, config, { type: 'resume', job, from: 'dashboard' });
    claimRequest(root, r.id, by);
    claimed[job] = r.id;
  }

  const pool = createPool(root, { claude: fakeClaude().adapter, pollMs: 3_600_000, syncMs: 0, reconcileMs: 0, graceMs: 50 });
  t.after(() => pool.close());
  pool.start('boot');

  const request = (job: string) => listRequests(root).find((r) => r.id === claimed[job])!;
  const jobA = loadJob(root, a);
  assert.equal(jobA.agents.builder?.status, 'lost');
  assert.equal(jobA.lease.driver, p, 'the driver is kept');
  assert.ok(Date.parse(jobA.lease.expiresAt!) <= Date.now(), "job A's lease is expired");
  assert.deepEqual(
    readEvents(root, a)
      .filter((e) => e.type === 'lease-expired')
      .map((e) => ({ session: e.session, reason: e.reason })),
    [{ session: p, reason: 'dash-start' }],
  );
  assert.deepEqual({ status: request(a).status, requeues: request(a).requeues }, { status: 'pending', requeues: 1 });

  const jobB = loadJob(root, b);
  assert.equal(jobB.lease.driver, i);
  assert.ok(Date.parse(jobB.lease.expiresAt!) > Date.now(), "job B's lease stays live");
  assert.equal(jobB.agents.builder?.status, 'running');
  assert.equal(request(b).status, 'in-progress');
});

/** A repo whose config.yml is `extra` over an enabled daemon, and its loaded config. */
function daemonRepo(t: any, extra: Record<string, unknown>) {
  const repo = tempRepo();
  t.after(repo.cleanup);
  const root = repo.dir;
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  const { daemon, ...rest } = extra as { daemon?: Record<string, unknown> };
  fs.writeFileSync(path.join(root, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, daemon: { enabled: true, command: 'claude {session}', ...daemon }, ...rest }));
  return { root, config: loadConfig(root).config };
}

/** A job parked on spec approval, with one gate request for it per `gates`. */
function parkedGates(root: string, config: any, gates: number): string[] {
  return Array.from({ length: gates }, (_, i) => {
    const job = createJob(root, config, { title: `parked ${i}` }).id;
    updateJob(root, job, (j) => {
      j.stage = 'spec';
      j.state = 'waiting';
      j.waitingOn = 'spec-approval';
    });
    return enqueue(root, config, { type: 'gate', job, args: { gate: 'spec-approval', reserved: null }, from: 'forge' }).id;
  });
}

test('a gate request reaches an assistant foreman', async (t) => {
  const on = (sessions: number) => ({ foreman: { enabled: true, assistants: { enabled: true, sessions } } });
  const rows: { name: string; config: Record<string, unknown>; gates: number; turned: string[]; mandate?: boolean }[] = [
    { name: 'one assistant, one gate', config: on(1), gates: 1, turned: ['_assistant-1'] },
    { name: "a milestone draft's job-less gate", config: on(1), gates: 1, turned: ['_assistant-1'], mandate: true },
    { name: 'two assistants, two gates', config: on(2), gates: 2, turned: ['_assistant-1', '_assistant-2'] },
    { name: 'two assistants, one gate', config: on(2), gates: 1, turned: ['_assistant-1'] },
    { name: 'the foreman off', config: { foreman: { enabled: false, assistants: { enabled: true, sessions: 1 } } }, gates: 1, turned: [] },
    { name: 'assistants off', config: { foreman: { enabled: true, assistants: { enabled: false, sessions: 1 } } }, gates: 1, turned: [] },
  ];
  for (const row of rows) {
    const { root, config } = daemonRepo(t, row.config);
    const ids = row.mandate
      ? [enqueue(root, config, { type: 'gate', job: null, args: { gate: 'milestone-approval', mandate: 'g1', key: '1-abc', digest: 'a'.repeat(64), reserved: null }, from: 'forge' }).id]
      : parkedGates(root, config, row.gates);
    const claude = fakeClaude();
    const pool = createPool(root, { claude: claude.adapter, pollMs: 3_600_000, syncMs: 0, reconcileMs: 0, graceMs: 50 });
    t.after(() => pool.close());
    pool.start('boot');
    const others = claude.children.filter((c) => c.scope !== '_inbox');
    assert.deepEqual(others.map((c) => c.scope).sort(), row.turned, `${row.name}: the children`);
    for (const c of others) assert.equal(c.turns, 1, `${row.name}: ${c.scope} got one turn`);
    assert.ok(!claude.children.some((c) => c.scope === '_office'), `${row.name}: the office is never spawned`);
    const state = pool.state();
    for (const scope of row.turned) assert.equal(state.assistants[scope]?.status, 'busy', `${row.name}: ${scope} is busy`);
    if (!row.turned.length) {
      assert.deepEqual(state.assistants, {}, `${row.name}: no assistants in the state`);
      for (const id of ids) assert.equal(listRequests(root).find((r) => r.id === id)?.status, 'pending', `${row.name}: the gate waits`);
    }
  }
});

test('chat text reaches only its chat session', async (t) => {
  const { root, config } = daemonRepo(t, { foreman: { enabled: true, assistants: { enabled: true, sessions: 1 } } });
  const job = createJob(root, config, { title: 'running' }).id;
  enqueue(root, config, { type: 'resume', job, from: 'dashboard' });
  enqueue(root, config, { type: 'draft', args: { mandate: 'g1' }, from: 'forge' });
  parkedGates(root, config, 1);
  const claude = fakeClaude();
  const pool = createPool(root, { claude: claude.adapter, pollMs: 3_600_000, syncMs: 0, reconcileMs: 0, graceMs: 50 });
  t.after(() => pool.close());
  pool.start('boot');
  const others = ['_inbox', '_office', '_assistant-1', job];
  assert.deepEqual(others.filter((s) => !claude.children.some((c) => c.scope === s)), [], 'the inbox, office, assistant and job sessions all run');

  const chat = '_chat-0123456789ab';
  assert.deepEqual(pool.sendChat(chat, 'hello, Foreman'), { error: null });
  for (const scope of others) assert.deepEqual(pool.sendChat(scope, 'hello'), { error: 'invalid chat scope' }, scope);
  for (const c of claude.children.filter((x) => x.scope !== chat)) {
    assert.deepEqual(c.messages, [], `${c.scope} took no owner text`);
    assert.ok(!c.argv.includes('--append-system-prompt'), `${c.scope} has no chat prompt`);
  }
  const chats = claude.children.filter((c) => c.scope === chat);
  assert.equal(chats.length, 1);
  assert.deepEqual(chats[0]!.messages, ['hello, Foreman']);
  const argv = chats[0]!.argv;
  assert.equal(argv.filter((w) => w === CHAT_PROMPT).length, 1);
  assert.equal(argv[argv.indexOf('--append-system-prompt') + 1], CHAT_PROMPT);
  assert.ok(argv.indexOf('--append-system-prompt') < argv.indexOf('--disallowedTools'));

  // The tick routes nothing to it, and a scoped start never spawns one.
  pool.poke();
  assert.deepEqual([chats[0]!.turns, claude.children.filter((c) => c.scope === chat).length], [0, 1]);
  assert.deepEqual(pool.startSession('_chat-ffffffffffff'), { error: 'a chat session starts when the owner sends it a message' });
  assert.ok(!claude.children.some((c) => c.scope === '_chat-ffffffffffff'));
  await pool.dropSession(chat);
  assert.equal(chats[0]!.exited, true, 'an archived chat is stopped and dropped');
  await pool.stop();
  assert.deepEqual(pool.sendChat(chat, 'again'), { error: 'start the daemon first' });
});

test('chat sessions count against neither daemon.maxConcurrent nor the machine cap', async (t) => {
  const { root, config } = daemonRepo(t, { daemon: { maxConcurrent: 1 } });
  const job = createJob(root, config, { title: 'running' }).id;
  enqueue(root, config, { type: 'resume', job, from: 'dashboard' });
  const claude = fakeClaude();
  const slots = createMachineSlots(() => 1);
  const pool = createPool(root, { claude: claude.adapter, slots, pollMs: 3_600_000, syncMs: 0, reconcileMs: 0, graceMs: 50 });
  t.after(() => pool.close());
  pool.start('boot');
  assert.ok(claude.children.some((c) => c.scope === job), 'the job session holds the slot');
  assert.deepEqual({ live: pool.state().live, machine: pool.state().machine?.live }, { live: 1, machine: 1 });
  for (const chat of ['_chat-0123456789ab', '_chat-aaaaaaaaaaaa']) {
    assert.deepEqual(pool.sendChat(chat, 'hi'), { error: null });
    assert.deepEqual(claude.children.find((c) => c.scope === chat)?.messages, ['hi'], `${chat} spawned and written`);
  }
  assert.deepEqual({ live: pool.state().live, machine: pool.state().machine?.live, jobs: Object.keys(pool.state().jobs) }, { live: 1, machine: 1, jobs: [job] });
});

test('the Office pass runs at start and on a mandate change, and its direct request turns the office', async (t) => {
  for (const enabled of [true, false]) {
    const { root, config } = daemonRepo(t, { foreman: { enabled, model: 'opus', effort: 'high' } });
    const job = createJob(root, config, { title: 'work' }).id;
    enqueue(root, config, { type: 'resume', job, from: 'dashboard' });
    let calls = 0;
    // The pass child's stand-in: the first finds director work.
    const runPass = async (r: string) => {
      calls++;
      if (calls === 1) enqueue(r, config, { type: 'direct', job: null, args: {}, from: 'forge' });
      return null;
    };
    const claude = fakeClaude();
    const pool = createPool(root, { claude: claude.adapter, pollMs: 3_600_000, syncMs: 0, reconcileMs: 0, graceMs: 50, runPass });
    t.after(() => pool.close());
    pool.start('boot');
    const of = (scope: string) => claude.children.filter((c) => c.scope === scope);
    if (!enabled) {
      pool.poke();
      assert.equal(calls, 0, 'no pass while the foreman is off');
      assert.deepEqual(of('_office'), [], 'the office never spawns');
      await pool.close();
      continue;
    }
    assert.equal(calls, 1, 'one pass at start');
    await waitFor(() => of('_office')[0]?.turns === 1, { what: 'the office turn' });
    assert.equal(of('_office').length, 1);
    const argv = of('_office')[0].argv;
    const after = (w: string) => argv.flatMap((x, i) => (x === w ? [argv[i + 1]] : []));
    assert.deepEqual([after('--model'), after('--effort')], [['opus'], ['high']]);
    await waitFor(() => of(job).length === 1, { what: 'the job session' });
    for (const c of claude.children.filter((x) => x.scope !== '_office')) assert.ok(!c.argv.includes('--model'), `${c.scope}: no --model`);
    const dir = path.join(root, '.forge', 'runtime', 'mandates');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'm2.md'), '---\n---\n');
    pool.poke();
    await waitFor(() => calls === 2, { what: 'a pass after the mandate change' });
    assert.equal(of('_office')[0].turns, 1, 'the second pass queued no direct request');
    await pool.close();
  }
});

test('assistant foremen count against neither daemon.maxConcurrent nor the machine cap', async (t) => {
  const { root, config } = daemonRepo(t, { daemon: { maxConcurrent: 1 }, foreman: { enabled: true, assistants: { enabled: true, sessions: 1 } } });
  const job = createJob(root, config, { title: 'running' }).id;
  enqueue(root, config, { type: 'resume', job, from: 'dashboard' });
  const claude = fakeClaude();
  const slots = createMachineSlots(() => 1);
  const pool = createPool(root, { claude: claude.adapter, slots, pollMs: 3_600_000, syncMs: 0, reconcileMs: 0, graceMs: 50 });
  t.after(() => pool.close());
  pool.start('boot');
  assert.ok(claude.children.some((c) => c.scope === job), 'the job session holds the slot');
  assert.deepEqual({ live: pool.state().live, machine: pool.state().machine?.live }, { live: 1, machine: 1 });

  parkedGates(root, config, 1);
  pool.poke();
  const assistant = claude.children.find((c) => c.scope === '_assistant-1');
  assert.equal(assistant?.turns, 1, 'the assistant is spawned and turned');
  assert.deepEqual({ live: pool.state().live, machine: pool.state().machine?.live }, { live: 1, machine: 1 });
});
