// createPool's gate runner in-process over fakeClaude children: each pending gate request becomes one gate
// run (a `_gates` forge:assistant child, never a session), capped by foreman.assistants.parallel, decided in
// code and acked; a start requeues what an earlier dash's runs left claimed (docs/architecture/foreman.md ›
// Gate runs). Nothing real is spawned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, fakeClaude, jobAt, parkedAt, repoTemplate, waitFor } from '../../helpers.ts';
import type { FakeClaudeChild } from '../../helpers.ts';
import * as yaml from '#core/format/yaml.ts';
import { loadConfig } from '#core/config/load.ts';
import { claimRequest, enqueue, listRequests } from '#core/job/requests.ts';
import { createJob, loadJob, readEvents } from '#core/job/store.ts';
import { createPool } from '#office/pool.ts';
import { createMachineSlots } from '#office/slots.ts';
import { gateAssist } from '#office/foreman/decide.ts';
import type { ClaudeEvent } from '#integrations/claude/types.ts';

const scratch = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  const decides = ['spec-approval', 'escalation', 'pr-feedback'];
  fs.writeFileSync(answers, JSON.stringify({ daemon: { enabled: true }, foreman: { enabled: true, decides, assistants: { enabled: true, effort: 'low' } } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

function editConfig(root: string, edit: (c: any) => void): void {
  const file = path.join(root, '.forge', 'config.yml');
  const c = yaml.parse(fs.readFileSync(file, 'utf8'));
  edit(c);
  fs.writeFileSync(file, yaml.stringify(c));
}

// The Office pass child's stand-in: the real one is a `forge office pass` process, and these tests spawn nothing real.
const noPass = async (): Promise<string | null> => null;

/** A pool over the scratch repo `r` with a fake claude; after the test it is closed, then the repo removed, in that order. */
function pool(t: any, r: { dir: string; cleanup: () => void }, extra: Record<string, unknown> = {}) {
  const claude = fakeClaude();
  const p = createPool(r.dir, { claude: claude.adapter, pollMs: 3_600_000, syncMs: 0, reconcileMs: 0, graceMs: 20, runPass: noPass, ...extra });
  t.after(async () => {
    await p.close();
    r.cleanup();
  });
  const gates = () => claude.children.filter((c) => c.scope === '_gates');
  return { pool: p, claude, gates };
}

/** A job parked at `gate` with a request body (not title-only), and its gate request. */
function parked(root: string, gate: 'spec-approval' | 'escalation' | 'pr-review' = 'spec-approval', opts: { key?: string; pr?: Record<string, unknown> } = {}) {
  const job = parkedAt(root, gate, { create: { body: 'Add a --json flag to forge status.' }, ...(opts.pr ? { pr: opts.pr as any } : {}) }).id;
  const cls = gate === 'pr-review' ? 'pr-feedback' : gate;
  const gid = enqueue(root, null, { type: 'gate', job, args: { gate: cls, reserved: null, ...(opts.key ? { key: opts.key } : {}) }, from: 'forge' }).id;
  return { job, gid };
}

const answer = (c: FakeClaudeChild, text: string): void => c.emit({ kind: 'turn-ended', ok: true, text, cost: null } as ClaudeEvent);
const request = (root: string, id: string) => listRequests(root).find((r) => r.id === id)!;
const after = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

test('one gate run per gate request, capped by parallel', async (t) => {
  const r = scratch();
  const a = parked(r.dir);
  const { config } = loadConfig(r.dir);
  const assist = gateAssist(r.dir, config, loadJob(r.dir, a.job), 'spec-approval');
  const { pool: p, claude, gates } = pool(t, r);
  p.start('boot');
  assert.equal(gates().length, 1, 'exactly one child for one gate request');
  const c = gates()[0];
  assert.equal(after(c.argv, '--agent'), 'forge:assistant');
  assert.equal(after(c.argv, '--permission-mode'), 'dontAsk');
  assert.deepEqual([after(c.argv, '--model'), after(c.argv, '--effort')], [assist.model, assist.effort]);
  assert.ok(!after(c.argv, '--allowedTools').split(/[ ,]/).includes('Bash'), after(c.argv, '--allowedTools'));
  assert.equal(c.env.FORGE_DAEMON_SCOPE, '_gates');
  assert.deepEqual(c.briefs, [assist.brief], "the assist brief is the child's first message");
  assert.deepEqual([c.turns, c.messages], [0, []], 'no session turn, no owner text');
  assert.ok(!claude.children.some((x) => x.scope === '_office' || /^_assistant-/.test(x.scope ?? '')), 'no office or assistant session for it');
  assert.deepEqual([p.state().gates.live, p.state().gates.parallel, p.state().gates.runs[0]?.status], [1, 2, 'running']);
  answer(c, 'ASSIST: approve · fine');
  await waitFor(() => request(r.dir, a.gid).status === 'done', { what: 'the gate acked' });
});

test('three gates with parallel 2: the oldest two run, the third when one ends', async (t) => {
  const r = scratch();
  const runs = [parked(r.dir), parked(r.dir), parked(r.dir)];
  const { pool: p, gates } = pool(t, r);
  p.start('boot');
  assert.equal(gates().length, 2);
  const briefOf = (c: FakeClaudeChild) => runs.findIndex((x) => c.briefs[0]?.includes(`/${x.job}/`));
  assert.deepEqual(gates().map(briefOf), [0, 1], 'the oldest two');
  assert.equal(request(r.dir, runs[2].gid).status, 'pending');
  answer(gates()[0], 'ASSIST: approve · fine');
  await waitFor(() => gates().length === 3, { what: 'the third run' });
  assert.equal(briefOf(gates()[2]), 2);
});

test('with the foreman or its gate runs off, no gate run starts', async (t) => {
  const rows: [string, (c: any) => void][] = [
    ['the foreman off', (c) => (c.foreman.enabled = false)],
    ['assistants.enabled false', (c) => (c.foreman.assistants.enabled = false)],
  ];
  for (const [name, edit] of rows) {
    const r = scratch();
    editConfig(r.dir, edit);
    const a = parked(r.dir);
    const { pool: p, gates } = pool(t, r);
    p.start('boot');
    p.poke();
    assert.deepEqual(gates(), [], `${name}: no child`);
    assert.equal(request(r.dir, a.gid).status, 'pending', `${name}: the gate waits for a person`);
    assert.equal(p.state().gates.live, 0, name);
    await p.close();
  }
});

test('drives spec-approval, escalation and pr-feedback gates', async (t) => {
  const r = scratch();
  const head = 'a'.repeat(40);
  const spec = parked(r.dir);
  const esc = parked(r.dir, 'escalation');
  const pr = parked(r.dir, 'pr-review', { key: head, pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', headOid: head } });
  const left = parked(r.dir, 'escalation');
  editConfig(r.dir, (c) => (c.foreman.assistants.parallel = 4));
  const { pool: p, gates } = pool(t, r);
  p.start('boot');
  assert.equal(gates().length, 4);
  const childOf = (job: string) => gates().find((c) => c.briefs[0]?.includes(`/${job}/`))!;
  answer(childOf(spec.job), 'ASSIST: approve · fine');
  answer(childOf(esc.job), 'ASSIST: rework · the tests miss AC2');
  answer(childOf(pr.job), 'ASSIST: rework · address the threads');
  answer(childOf(left.job), 'ASSIST: escalate · needs a person');
  const all = [spec, esc, pr, left];
  await waitFor(() => all.every((x) => request(r.dir, x.gid).status !== 'in-progress' && request(r.dir, x.gid).status !== 'pending'), { what: 'every gate acked' });

  const human = (job: string) => readEvents(r.dir, job).filter((e) => e.type === 'human').map((e) => [e.action, e.note, e.actor?.source]);
  const resumes = (job: string) => listRequests(r.dir).filter((x) => x.type === 'resume' && x.job === job).length;
  const acked = (x: { gid: string }) => [request(r.dir, x.gid).status, request(r.dir, x.gid).result];
  assert.deepEqual([human(spec.job), resumes(spec.job), acked(spec)], [[['approve-spec', 'fine', 'foreman']], 1, ['done', 'approve: fine']]);
  assert.deepEqual([human(esc.job), resumes(esc.job), acked(esc)], [[['rework', 'the tests miss AC2', 'foreman']], 1, ['done', 'rework: the tests miss AC2']]);
  assert.deepEqual([human(pr.job), resumes(pr.job), acked(pr)], [[['rework', 'address the threads', 'foreman']], 1, ['done', 'rework: address the threads']]);
  const handoffs = readEvents(r.dir, left.job).filter((e) => e.type === 'foreman-handoff').map((e) => [e.class, e.reason]);
  assert.deepEqual([handoffs, human(left.job), resumes(left.job), acked(left)], [[['escalated', 'needs a person']], [], 0, ['rejected', 'escalated: needs a person']]);
  const outcomes = Object.fromEntries(p.state().gates.runs.map((x) => [x.job, x.outcome]));
  assert.deepEqual(outcomes, { [spec.job]: 'approve', [esc.job]: 'rework', [pr.job]: 'rework', [left.job]: 'escalated' });
});

test('a start requeues gate runs an earlier dash left claimed', async (t) => {
  const r = scratch();
  // Gate runs off, so the requeued request is not taken again at once.
  editConfig(r.dir, (c) => (c.foreman.assistants.enabled = false));
  const a = parked(r.dir);
  const b = parked(r.dir);
  claimRequest(r.dir, a.gid, 'gate-run:x');
  // A claim that is no gate run's is the reconciler's business, not the gate runner's.
  claimRequest(r.dir, b.gid, 'some-session');
  const { pool: p } = pool(t, r);
  p.start('boot');
  assert.deepEqual([request(r.dir, a.gid).status, request(r.dir, a.gid).requeues, request(r.dir, a.gid).session], ['pending', 1, undefined]);
  assert.equal(request(r.dir, b.gid).status, 'in-progress');
});

test("a pool lists the gate log's last runs before it starts, and only the valid ones", async (t) => {
  const r = scratch();
  const log = path.join(r.dir, '.forge', 'runtime', 'daemons', '_gates.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const end = (request: string, outcome: string, at: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'forge-gates', at, event: 'gate-end', run: 'gate-run:x', request, gate: 'spec-approval', job: 'add-json-flag', mandate: null, outcome, reason: `${outcome} reason`, attempts: 1, usd: 0.1, tokens: 900, startedAt: at, ...over });
  fs.writeFileSync(
    log,
    [
      end('1-a', 'approve', '2026-10-26T10:00:00.000Z'),
      end('2-b', 'escalated', '2026-10-26T10:05:00.000Z'),
      '{not json',
      end('3-c', 'failed', '2026-10-26T10:10:00.000Z'),
      end('4-d', 'approved', '2026-10-26T10:15:00.000Z'),
      end('5-e', 'approve', '2026-10-26T10:20:00.000Z', { job: '../x' }),
      JSON.stringify({ type: 'forge-gates', at: '2026-10-26T10:25:00.000Z', event: 'gate-start', request: '6-f' }),
      // A senior pass's run: both children's turns, at most 4.
      end('7-g', 'shelved', '2026-10-26T10:30:00.000Z', { attempts: 4, reason: 'senior pass escalated: needs a person' }),
      end('8-h', 'shelved', '2026-10-26T10:35:00.000Z', { attempts: 5 }),
      '',
    ].join('\n'),
  );
  const { pool: p, claude } = pool(t, r);
  const g = p.state().gates;
  assert.deepEqual([g.enabled, g.parallel, g.live], [true, 2, 0], 'on, from the config the pool read, before any start');
  assert.deepEqual(g.runs.map((x) => [x.request, x.outcome, x.status]), [['7-g', 'shelved', 'done'], ['3-c', 'failed', 'done'], ['2-b', 'escalated', 'done'], ['1-a', 'approve', 'done']]);
  assert.deepEqual([g.runs[0].attempts, g.runs[0].reason], [4, 'senior pass escalated: needs a person']);
  assert.deepEqual(claude.children, [], 'nothing spawned');
});

test("a gate run that ends inside the pool's own tick does not turn a job session twice", async (t) => {
  const r = scratch();
  // A stale gate request: its run acks and ends before any await, in the middle of the tick that took it.
  const moved = jobAt(r.dir, 'spec').id;
  const stale = enqueue(r.dir, null, { type: 'gate', job: moved, args: { gate: 'spec-approval', reserved: null }, from: 'forge' }).id;
  const { config } = loadConfig(r.dir);
  const job = createJob(r.dir, config, { title: 'needs a turn' }).id;
  enqueue(r.dir, config, { type: 'resume', job, from: 'dashboard' });
  const { pool: p, claude, gates } = pool(t, r);
  p.start('boot');
  await new Promise((res) => setImmediate(res));
  const child = claude.children.find((c) => c.scope === job);
  assert.deepEqual([gates(), request(r.dir, stale).result, child?.turns], [[], 'stale', 1], 'one child, one turn');
});

test('gate runs count against neither daemon.maxConcurrent nor the machine cap', async (t) => {
  const r = scratch();
  editConfig(r.dir, (c) => (c.daemon.maxConcurrent = 1));
  const { config } = loadConfig(r.dir);
  const job = createJob(r.dir, config, { title: 'running' }).id;
  enqueue(r.dir, config, { type: 'resume', job, from: 'dashboard' });
  const slots = createMachineSlots(() => 1);
  const { pool: p, claude, gates } = pool(t, r, { slots });
  p.start('boot');
  assert.ok(claude.children.some((c) => c.scope === job), 'the job session holds the slot');
  parked(r.dir);
  p.poke();
  assert.equal(gates().length, 1, 'the gate run starts at the cap');
  assert.deepEqual({ live: p.state().live, machine: p.state().machine?.live, gates: p.state().gates.live }, { live: 1, machine: 1, gates: 1 });
});
