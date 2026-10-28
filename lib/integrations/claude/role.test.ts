// runRoleChild against the in-memory adapter: the brief, the end after a result, unattended permission
// answers and every failure class it decides, driven by ClaudeEvents (no stream-json, no process).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeClaude, waitFor, type FakeClaudeChild } from '../../../test/helpers.ts';
import { runRoleChild, type RoleOutcome, type RoleRun, type RoleRunOptions } from './role.ts';
import type { ClaudeAdapter, ClaudeEvent } from './types.ts';

const SID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const cost = { usd: 0.5, models: { 'claude-haiku-4-5': { usd: 0.5, input: 10, output: 20, cacheRead: 30, cacheWrite: 40 } } };
const ok: ClaudeEvent = { kind: 'turn-ended', ok: true, summary: 'VERIFY: 2 yes', cost };
const failed = (o: { reason: string; limit?: boolean; auth?: boolean; budget?: boolean; resetsAt?: number | null }): ClaudeEvent => ({ kind: 'turn-ended', ok: false, limit: false, auth: false, budget: false, resetsAt: null, cost: null, ...o });
const init = (c: FakeClaudeChild) => {
  c.emit({ kind: 'turn-started' });
  c.emit({ kind: 'session-id', id: SID });
};
const ask = (requestId: string): ClaudeEvent => ({ kind: 'permission-asked', requestId, tool: 'Bash', input: '{"command":"rm -rf /"}', description: null, agentId: null, blockedPath: null, rules: [], dirs: [] });

/** One run on `adapter` with small timers; `lines` collects onLine, `ids` onSessionId. */
function start(adapter: ClaudeAdapter, opts: Partial<RoleRunOptions> = {}) {
  const lines: string[] = [];
  const ids: string[] = [];
  const run = runRoleChild(adapter, { argv: ['claude', '-p'], cwd: '/wt', env: { A: '1' }, brief: 'Role: verifier\nOutput: x.md', maxLineBytes: 1 << 20, timeoutMs: null, graceMs: 20, onLine: (l) => void lines.push(l), onSessionId: (id) => void ids.push(id), ...opts });
  return { run, lines, ids };
}

test('runRoleChild writes the brief once and ends the child after its result', async () => {
  const { adapter, children } = fakeClaude();
  const { run, lines, ids } = start(adapter);
  const [c] = children;
  assert.deepEqual([c.argv, c.cwd, c.env], [['claude', '-p'], '/wt', { A: '1' }]);
  assert.deepEqual(c.briefs, ['Role: verifier\nOutput: x.md'], 'the brief, once');
  assert.equal(c.turns, 0, 'no fixed turn');
  init(c);
  c.emit({ kind: 'log', stream: 'stdout', line: '{"type":"assistant"}' });
  // Only the stream's first request is kept: a context session's fork reads its cache hit there.
  c.emit({ kind: 'first-request', input: 2, cacheRead: 60000, cacheWrite: 100 });
  c.emit({ kind: 'first-request', input: 9, cacheRead: 9, cacheWrite: 9 });
  // The distinct tools its main loop called, in first-use order: a context session's child may only Read.
  c.emit({ kind: 'tool-use', names: ['Read', 'Read'] });
  c.emit({ kind: 'tool-use', names: ['Write', 'Read'] });
  assert.equal(c.inputEnded, false, 'stdin stays open until the result, for permission answers');
  c.emit({ ...ok, text: 'VERIFY: 2 yes\nthe rest' });
  assert.equal(c.inputEnded, true, 'stdin closes after the result');
  c.exit(0, null);
  const out = await run.done;
  assert.deepEqual(
    { ...out, wallMs: 0 },
    { ok: true, started: true, init: true, sessionId: SID, summary: 'VERIFY: 2 yes', text: 'VERIFY: 2 yes\nthe rest', firstRequest: { input: 2, cacheRead: 60000, cacheWrite: 100 }, tools: ['Read', 'Write'], cost, failure: null, denied: 0, exit: { code: 0, signal: null }, wallMs: 0 },
  );
  assert.deepEqual([lines, ids], [['{"type":"assistant"}'], [SID]]);
  assert.deepEqual(c.signals, [], 'a child that exits on its own is never signalled');
});

test('runRoleChild sends SIGTERM, then SIGKILL, to a child that outlives its result', async () => {
  const { adapter, children } = fakeClaude({ exitOnSignal: false });
  const { run } = start(adapter);
  const [c] = children;
  init(c);
  c.emit(ok);
  await waitFor(() => c.signals.length === 1, { what: 'SIGTERM after the grace' });
  assert.deepEqual(c.signals, ['SIGTERM']);
  await waitFor(() => c.signals.length === 2, { what: 'SIGKILL after the second grace' });
  assert.deepEqual(c.signals, ['SIGTERM', 'SIGKILL']);
  c.exit(null, 'SIGKILL');
  const out = await run.done;
  assert.equal(out.ok, true, 'the result was in: the run keeps it');
  assert.deepEqual(out.exit, { code: null, signal: 'SIGKILL' });
});

test('runRoleChild denies prompts unattended, or sends the callback decision', async () => {
  const lone = fakeClaude();
  const a = start(lone.adapter);
  const [c] = lone.children;
  init(c);
  c.emit(ask('r1'));
  assert.deepEqual(c.answers, [{ requestId: 'r1', decision: 'deny', why: 'unattended' }]);
  const logged = a.lines.map((l) => JSON.parse(l)).find((l) => l.type === 'forge-permission');
  assert.deepEqual({ ...logged, at: '<at>' }, { type: 'forge-permission', at: '<at>', requestId: 'r1', tool: 'Bash', decision: 'deny', why: 'unattended' });
  c.emit(ok);
  c.exit(0, null);
  assert.equal((await a.run.done).denied, 1);

  for (const decision of ['allow', 'deny'] as const) {
    const watched = fakeClaude();
    const asked: string[] = [];
    const b = start(watched.adapter, { onPermission: async (e) => (asked.push(e.requestId), decision) });
    const [w] = watched.children;
    init(w);
    w.emit(ask('r2'));
    await waitFor(() => w.answers.length === 1, { what: 'the callback answer' });
    assert.deepEqual([asked, w.answers], [['r2'], [{ requestId: 'r2', decision }]], decision);
    w.emit(ok);
    w.exit(0, null);
    assert.equal((await b.run.done).denied, decision === 'deny' ? 1 : 0, decision);
  }
});

test('runRoleChild classifies every failure it can see', async () => {
  const throwing: ClaudeAdapter = {
    start() {
      throw new Error('spawn claude ENOENT');
    },
  };
  type Row = { name: string; adapter?: ClaudeAdapter; opts?: Partial<RoleRunOptions>; drive?: (c: FakeClaudeChild, run: RoleRun) => void | Promise<void>; want: Partial<RoleOutcome> & { class: string; resetsAt?: number | null; reason?: RegExp } };
  const rows: Row[] = [
    { name: 'limit', drive: (c) => (init(c), c.emit(failed({ reason: 'usage limit reached', limit: true, resetsAt: 2_000_000_000_000 })), c.exit(1, null)), want: { class: 'limit', resetsAt: 2_000_000_000_000 } },
    { name: 'auth', drive: (c) => (init(c), c.emit(failed({ reason: 'OAuth token has expired · Please run /login', auth: true })), c.exit(1, null)), want: { class: 'auth', resetsAt: null, reason: /OAuth token/ } },
    { name: 'budget', drive: (c) => (init(c), c.emit(failed({ reason: 'error_max_budget_usd', budget: true })), c.exit(1, null)), want: { class: 'budget' } },
    { name: 'error', drive: (c) => (init(c), c.emit(failed({ reason: 'tool crashed' })), c.exit(1, null)), want: { class: 'error', reason: /tool crashed/ } },
    { name: 'exit before a result', drive: (c) => (init(c), c.exit(3, null)), want: { class: 'exit', init: true, reason: /code 3/ } },
    { name: 'start throws', adapter: throwing, want: { class: 'spawn', started: false, reason: /ENOENT/ } },
    { name: 'a process that never ran', drive: (c) => c.emit({ kind: 'process-error', message: 'spawn /nope ENOENT', started: false }), want: { class: 'spawn', started: false, init: false } },
    { name: 'timeout', opts: { timeoutMs: 30 }, drive: (c) => init(c), want: { class: 'timeout', reason: /still running/ } },
    { name: 'interrupted', drive: (c, run) => (init(c), run.stop('SIGTERM')), want: { class: 'interrupted', reason: /SIGTERM/ } },
  ];
  for (const row of rows) {
    const fake = fakeClaude();
    const { run } = start(row.adapter ?? fake.adapter, row.opts);
    const c = fake.children[0];
    if (row.drive) await row.drive(c, run);
    const out = await run.done;
    const { class: cls, resetsAt, reason, ...rest } = row.want;
    assert.equal(out.ok, false, row.name);
    assert.equal(out.failure?.class, cls, row.name);
    if (resetsAt !== undefined) assert.equal(out.failure?.resetsAt, resetsAt, row.name);
    if (reason) assert.match(out.failure?.reason ?? '', reason, row.name);
    for (const [k, v] of Object.entries(rest)) assert.deepEqual(out[k as keyof RoleOutcome], v, `${row.name}: ${k}`);
    if (row.name === 'timeout' || row.name === 'interrupted') assert.equal(c.signals[0], 'SIGTERM', `${row.name}: the group is signalled`);
  }
  assert.throws(() => runRoleChild(fakeClaude().adapter, { argv: ['claude'], cwd: '/', env: {}, brief: '  ', maxLineBytes: 1, timeoutMs: null, onLine() {} }), /role brief/, 'a refused brief starts nothing');
});
