// The status bar's Daemon popover's and the session log's models (dashboard/src/lib/daemon.ts). The log-line cases live in dashboard-session-log.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSION_MODES, START_HINT, daemonRows, mergePoolState, mergeSessionState, poolModel, postDaemon, postDaemonMode, sessionControls, sessionMode, sessionPill, sessionToggle } from '../dashboard/src/lib/daemon.ts';

const XSS = '<script>alert(1)</script><img src=x onerror=alert(2)>';
const session = (o: any = {}): any => ({ scope: 'job', wanted: true, running: false, status: 'off', sessionId: null, pid: null, lastTurnAt: null, lastResultAt: null, turns: 0, failures: 0, held: null, waiting: false, lastError: null, ...o });
const pool = (o: any = {}) => ({ enabled: true, wanted: true, maxConcurrent: 3, live: 0, lastError: null, inbox: session({ scope: '_inbox' }), jobs: {}, clients: 0, ...o });

test('sessionPill labels and tones every session status', () => {
  const pill = (o) => {
    const p = sessionPill(o === null ? null : session(o));
    return [p.label, p.tone];
  };
  assert.deepEqual(pill(null), ['no session', 'muted']);
  assert.deepEqual(pill({ status: 'busy', running: true }), ['busy', 'live']);
  assert.deepEqual(pill({ status: 'idle', running: true }), ['idle', 'ok']);
  assert.deepEqual(pill({ status: 'stopping', running: true }), ['stopping', 'warn']);
  assert.deepEqual(pill({ waiting: true }), ['waiting for slot', 'warn']);
  assert.deepEqual(pill({ held: 'budget' }), ['held: budget', 'warn']);
  assert.deepEqual(pill({ held: 'budget', status: 'idle', running: true }), ['held: budget', 'warn'], 'a hold says more than idle');
  assert.deepEqual(pill({ lastError: 'daemon stopped after 3 failed starts', wanted: false }), ['error', 'bad']);
  assert.deepEqual(pill({ wanted: false }), ['stopped', 'muted']);
  assert.deepEqual(pill({ status: 'idle', running: true, lastError: 'last turn failed: Failed to authenticate' }), ['failing', 'bad'], 'alive but its turns fail');
  assert.match(sessionPill(session({ sessionId: 'x' })).title, /starts on its next request/);
  assert.deepEqual(pill({ sessionId: '0123456789abcdef' }), ['standby', 'muted']);
  assert.deepEqual(pill({}), ['no session', 'muted']);
  const title = sessionPill(session({ sessionId: '0123456789abcdef', turns: 4, failures: 2, lastError: XSS })).title;
  assert.match(title, /session 01234567/);
  assert.match(title, /4 turns/);
  assert.match(title, /2 failed starts/);
  assert.ok(title.includes(XSS), 'text, never pre-escaped');
});

test('a session kept by running agents says so, after busy and before failing', () => {
  const pill = (o) => {
    const p = sessionPill(session(o));
    return [p.label, p.tone];
  };
  const kept = { running: true, status: 'idle', kept: 'agents' };
  assert.deepEqual(pill(kept), ['agents running', 'live']);
  assert.deepEqual(pill({ ...kept, kept: null }), ['idle', 'ok']);
  assert.match(sessionPill(session(kept)).title, /kept: its job has agents running/, 'the title says why an idle session holds its slot');
  assert.doesNotMatch(sessionPill(session({ ...kept, kept: null })).title, /kept:/);
  assert.deepEqual(pill({ ...kept, status: 'busy' }), ['busy', 'live']);
  assert.deepEqual(pill({ ...kept, status: 'stopping' }), ['stopping', 'warn']);
  assert.deepEqual(pill({ ...kept, waiting: true }), ['waiting for slot', 'warn']);
  assert.deepEqual(pill({ ...kept, held: 'budget' }), ['held: budget', 'warn']);
  assert.deepEqual(pill({ ...kept, lastError: 'last turn failed: x' }), ['failing', 'bad']);
  assert.deepEqual(pill({ ...kept, permissions: [{ id: 'p' }] }), ['needs permission', 'warn']);
  const m = poolModel(
    pool({
      jobs: {
        'job-idle': session({ running: true, status: 'idle' }),
        'job-failing': session({ running: true, status: 'idle', lastError: 'last turn failed: x' }),
        'job-kept': session(kept),
        'job-busy': session({ running: true, status: 'busy', kept: 'agents' }),
      },
    }),
    { pending: false },
  );
  assert.deepEqual(m.kept, ['job-kept', 'job-busy'], 'every session its agents keep, busy or not');
  assert.deepEqual(m.jobs.map((j) => [j.id, j.pill.label]), [['job-busy', 'busy'], ['job-kept', 'agents running'], ['job-failing', 'failing'], ['job-idle', 'idle']]);
});

test('poolModel hides exactly when nothing is enabled, wanted or running', () => {
  assert.equal(poolModel(null, { pending: false }), null);
  assert.equal(poolModel(pool({ enabled: false, wanted: false }), { pending: false }), null);
  assert.ok(poolModel(pool({ enabled: true, wanted: false }), { pending: false }));
  assert.ok(poolModel(pool({ enabled: false, wanted: true }), { pending: false }));
  assert.ok(poolModel(pool({ enabled: false, wanted: false, jobs: { a: session({ running: true, status: 'busy' }) } }), { pending: false }), 'a running job session keeps it shown');
  assert.ok(poolModel(pool({ enabled: false, wanted: false, inbox: session({ running: true, status: 'idle' }) }), { pending: false }));
});

test('poolModel derives the pill, inbox, live/cap, holds, waits and job chips', () => {
  const p = pool({
    live: 2,
    maxConcurrent: 2,
    inbox: session({ scope: '_inbox', running: true, status: 'idle' }),
    jobs: {
      'job-stopped': session({ wanted: false }),
      'job-wait': session({ waiting: true }),
      'job-held': session({ held: 'budget' }),
      'job-idle': session({ running: true, status: 'idle' }),
      'job-busy-with-a-really-long-identifier-here': session({ running: true, status: 'busy' }),
      'job-err': session({ lastError: 'boom', wanted: false }),
    },
  });
  const m = poolModel(p, { pending: false });
  assert.deepEqual([m.pill.label, m.pill.tone], ['busy', 'live'], 'busy if any session is busy');
  assert.deepEqual([m.inbox.label, m.inbox.tone], ['idle', 'ok']);
  assert.equal(m.live, 2);
  assert.equal(m.cap, 2);
  assert.deepEqual(m.held, ['job-held']);
  assert.deepEqual(m.waiting, ['job-wait']);
  assert.deepEqual(m.jobs.map((j) => j.pill.label), ['busy', 'idle', 'waiting for slot', 'held: budget', 'error', 'stopped'], 'chips in status order');
  assert.equal(m.jobs[0].label, 'job-busy-with-a-really-l…', 'long ids are truncated');
  assert.equal(m.jobs[0].id, 'job-busy-with-a-really-long-identifier-here');
  const pill = (o) => poolModel(pool(o), { pending: false }).pill.label;
  assert.equal(pill({ inbox: session({ running: true, status: 'idle' }) }), 'idle');
  assert.equal(pill({ inbox: session({ status: 'stopping' }) }), 'stopping');
  assert.equal(pill({}), 'standby');
  assert.equal(pill({ wanted: false, lastError: 'x' }), 'error');
  assert.equal(pill({ wanted: false }), 'stopped');
  const failing = poolModel(pool({ inbox: session({ scope: '_inbox', running: true, status: 'idle', lastError: 'last turn failed: auth' }) }), { pending: false });
  assert.deepEqual([failing.pill.label, failing.pill.tone], ['failing', 'bad'], 'a failing session shows on the pool pill');
  assert.match(failing.pill.title, /_inbox: last turn failed: auth/);
  assert.deepEqual([failing.inbox.label, failing.inbox.tone], ['failing', 'bad']);
  assert.equal(pill({ wanted: false, jobs: { a: session({ lastError: 'x', wanted: false }) } }), 'stopped', 'a stopped pool is not failing');
  assert.equal(poolModel(pool({ wanted: false, lastError: XSS }), { pending: false }).error, null, 'the error pill already says it');
  assert.equal(poolModel(pool({ lastError: XSS }), { pending: false }).error, XSS);
});

test('poolModel enables pool Start/Stop like the old bar, with the hint', () => {
  const m = (o, pending = false) => poolModel(pool(o), { pending });
  assert.deepEqual([m({ wanted: false }).canStart, m({ wanted: false }).canStop], [true, false]);
  assert.deepEqual([m({}).canStart, m({}).canStop], [false, true]);
  assert.equal(m({ wanted: false }, true).canStart, false, 'pending disables both');
  assert.equal(m({}, true).canStop, false);
  assert.equal(m({ wanted: false, inbox: session({ running: true, status: 'stopping' }) }).canStart, false, 'not while anything still runs');
  assert.equal(m({ wanted: false, inbox: session({ running: true, status: 'stopping' }) }).canStop, true);
  assert.equal(m({ enabled: false }).startHint, START_HINT);
  assert.equal(m({ enabled: false, wanted: false }), null);
  assert.equal(m({ wanted: false }).startHint, null);
});

test('sessionControls: Start once the pool runs and the session is stopped or failed; Stop while wanted or running', () => {
  assert.deepEqual(sessionControls(session({ wanted: false }), true, false), { canStart: true, canStop: false });
  assert.deepEqual(sessionControls(session({ lastError: 'x', wanted: true }), true, false), { canStart: true, canStop: true });
  assert.deepEqual(sessionControls(session({ running: true, status: 'idle' }), true, false), { canStart: false, canStop: true });
  assert.deepEqual(sessionControls(session({ wanted: false }), false, false), { canStart: false, canStop: false }, 'a scoped start needs a running pool');
  assert.deepEqual(sessionControls(null, true, false), { canStart: false, canStop: true });
  assert.deepEqual(sessionControls(null, false, false), { canStart: false, canStop: false }, 'nothing to stop while the pool is down');
  assert.deepEqual(sessionControls(session({ running: true, status: 'idle' }), false, false), { canStart: false, canStop: true });
  assert.deepEqual(sessionControls(session({ wanted: false }), true, true), { canStart: false, canStop: false });
});

test('sessionToggle picks one action', () => {
  const both = { canStart: true, canStop: true };
  const none = { canStart: false, canStop: false };
  // Rule 1: running shows Stop, enabled as canStop says.
  assert.deepEqual(sessionToggle({ canStart: false, canStop: true }, { running: true, wanted: true }), { action: 'stop', enabled: true });
  assert.deepEqual(sessionToggle(none, { running: true }), { action: 'stop', enabled: false }, 'running while pending: a disabled Stop');
  assert.deepEqual(sessionToggle(both, { running: true, lastError: 'x' }), { action: 'stop', enabled: true }, 'running wins over a retryable failure');
  // Rule 2: not running and startable shows an enabled Start (a failed session retries).
  assert.deepEqual(sessionToggle({ canStart: true, canStop: false }, { running: false, wanted: false }), { action: 'start', enabled: true });
  assert.deepEqual(sessionToggle(both, { running: false, wanted: true, lastError: 'boom' }), { action: 'start', enabled: true }, 'failed and down: Start');
  // Rule 3: stopped by a human and not startable (pool down, or pending) shows a disabled Start.
  assert.deepEqual(sessionToggle(sessionControls({ running: false, wanted: false }, false, false), { running: false, wanted: false }), { action: 'start', enabled: false }, 'pool down with a stopped session: Start, disabled');
  assert.deepEqual(sessionToggle(none, { wanted: false }), { action: 'start', enabled: false });
  // Rule 4: anything else shows Stop, enabled as canStop says.
  assert.deepEqual(sessionToggle({ canStart: false, canStop: true }, { running: false, wanted: true }), { action: 'stop', enabled: true }, 'wanted on demand: Stop keeps it off');
  assert.deepEqual(sessionToggle(sessionControls(null, false, false), null), { action: 'stop', enabled: false }, 'no session, pool down: a disabled Stop');
  assert.deepEqual(sessionToggle({ canStart: false, canStop: true }, undefined), { action: 'stop', enabled: true });
});

test('merges keep enabled from /api/state and take session frames whole', () => {
  assert.deepEqual(mergePoolState({ enabled: true, wanted: false }, { enabled: false, wanted: true }), { enabled: true, wanted: true });
  assert.deepEqual(mergePoolState(null, { enabled: false, wanted: true }), { enabled: false, wanted: true });
  assert.deepEqual(mergeSessionState({ status: 'idle', turns: 1 }, { status: 'busy' }), { status: 'busy', turns: 1 });
});

test('postDaemon sends the token and scope, and surfaces the server error', async () => {
  const calls = [];
  const reply = (status, body, statusText = ''): any => async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, statusText, text: async () => body };
  };
  const st = await postDaemon('start', 'tok123', undefined, reply(200, JSON.stringify({ wanted: true })));
  assert.deepEqual(st, { wanted: true });
  const { url, init } = calls[0];
  assert.equal(url, '/api/daemon');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.headers['x-forge-token'], 'tok123');
  assert.deepEqual(JSON.parse(init.body), { action: 'start' });
  await postDaemon('stop', 't', 'job-a', reply(200, '{}'));
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { action: 'stop', scope: 'job-a' });
  await assert.rejects(postDaemon('start', 't', 'job-a', reply(409, JSON.stringify({ error: 'start the daemon first' }))), { message: 'start the daemon first' });
  await assert.rejects(postDaemon('stop', 't', undefined, reply(403, 'bad token')), { message: 'bad token' });
  await assert.rejects(postDaemon('stop', 't', undefined, reply(500, '', 'Internal Server Error')), { message: 'Internal Server Error' });
});

test('a running session with a permission prompt says so, in its pill and the pool pill, ahead of busy', () => {
  const prompt = { id: 'p1', tool: 'Bash', input: '{}', description: null, agentId: null, blockedPath: null, sessionRules: [], sessionDirs: [], at: '2026-10-14T00:00:00Z' };
  const asking = session({ scope: 'job-a', status: 'busy', running: true, permissions: [prompt] });
  assert.deepEqual([sessionPill(asking).label, sessionPill(asking).tone], ['needs permission', 'warn']);
  assert.equal(sessionPill(session({ status: 'busy', running: true, permissions: [] })).label, 'busy');
  assert.equal(sessionPill(session({ permissions: [prompt] })).label, 'no session', 'a stopped session has no live prompt');
  const m = poolModel(pool({ jobs: { 'job-b': session({ scope: 'job-b', status: 'busy', running: true }), 'job-a': asking } }), { pending: false })!;
  assert.equal(m.pill.label, 'needs permission');
  assert.deepEqual(
    m.jobs.map((j) => j.id),
    ['job-a', 'job-b'],
    'a job waiting on a human is listed first',
  );
});

test('sessionMode: the choice comes from the pool, the report from the running session', () => {
  const p = pool({ permissionMode: 'default', permissionModes: { 'job-a': 'auto', 'job-b': 'bypassPermissions' } });
  assert.deepEqual(sessionMode(p, 'job-a', session({ running: true, permissionMode: 'auto' })), { chosen: 'auto', live: null, overridden: true });
  assert.deepEqual(sessionMode(p, 'job-a', session({ running: true, permissionMode: 'default' })), { chosen: 'auto', live: 'default', overridden: true }, 'a switch claude has not confirmed');
  assert.deepEqual(sessionMode(p, 'job-a', session({ running: false, permissionMode: 'default' })), { chosen: 'auto', live: null, overridden: true }, 'a stopped session reports nothing');
  assert.deepEqual(sessionMode(p, 'job-b', null), { chosen: 'default', live: null, overridden: false }, 'an unknown mode in the reply is ignored');
  assert.deepEqual(sessionMode(pool({ permissionMode: 'plan' }), 'job-c', null), { chosen: 'plan', live: null, overridden: false }, "daemon.command's mode, even one the selector can't set");
  assert.deepEqual(sessionMode(null, 'job-c', undefined), { chosen: 'default', live: null, overridden: false });
  assert.deepEqual(PERMISSION_MODES, ['default', 'auto', 'dontAsk']);
});

test('poolModel marks job chips a human switched to another mode', () => {
  const m = poolModel(pool({ permissionModes: { 'job-a': 'auto' }, jobs: { 'job-a': session({ scope: 'job-a', running: true, status: 'idle' }), 'job-b': session({ scope: 'job-b', running: true, status: 'idle' }) } }), { pending: false });
  assert.deepEqual(
    m.jobs.map((j) => [j.id, j.mode]),
    [
      ['job-a', 'auto'],
      ['job-b', null],
    ],
  );
});

test('postDaemonMode posts the scope and mode with the token', async () => {
  const calls = [];
  const fetchImpl: any = async (url, init) => {
    calls.push({ url, init });
    return { ok: url === '/api/daemon/mode', status: 200, statusText: '', text: async () => '{"permissionModes":{"job-a":"auto"}}' };
  };
  const st = await postDaemonMode('job-a', 'auto', 'tok', fetchImpl);
  assert.deepEqual(st, { permissionModes: { 'job-a': 'auto' } });
  assert.equal(calls[0].url, '/api/daemon/mode');
  assert.equal(calls[0].init.headers['x-forge-token'], 'tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), { scope: 'job-a', mode: 'auto' });
  const failing: any = async () => ({ ok: false, status: 400, statusText: 'Bad Request', text: async () => '{"error":"mode must be one of default, auto, dontAsk"}' });
  await assert.rejects(postDaemonMode('job-a', 'auto', 'tok', failing), /mode must be one of/);
});

test('daemonRows lists inbox, then jobs', () => {
  const p = pool({
    jobs: {
      'b-job': session({ status: 'idle', running: true }),
      'a-job': session({ status: 'busy', running: true }),
      ghost: session({ held: 'budget' }),
    },
    permissionModes: { 'b-job': 'auto' },
  });
  const jobs = [{ id: 'a-job', title: XSS }, { id: 'b-job', title: 'Refactor the pool' }];
  const rows = (o: any) => daemonRows(poolModel(pool({ ...p, ...o }), { pending: false })!, jobs);
  // Foreman off: Inbox, then the jobs in the model's status order (busy, idle, held).
  const off = rows({});
  assert.deepEqual(off.map((r) => (r.kind === 'job' ? r.id : r.kind)), ['inbox', 'a-job', 'b-job', 'ghost']);
  assert.deepEqual(off[0], { kind: 'inbox', pill: poolModel(p, { pending: false })!.inbox }, 'the inbox row carries its pill');
  const b = off.find((r) => r.kind === 'job' && r.id === 'b-job');
  assert.ok(b && b.kind === 'job' && b.mode === 'auto' && b.title === 'Refactor the pool', 'a job row carries its overridden mode');
  const a = off.find((r) => r.kind === 'job' && r.id === 'a-job');
  assert.ok(a && a.kind === 'job');
  assert.equal(a.title, XSS, 'the title is passed through as data; the component renders it as text');
  assert.equal(a.pill.label, 'busy');
  const ghost = off.find((r) => r.kind === 'job' && r.id === 'ghost');
  assert.ok(ghost && ghost.kind === 'job' && ghost.title === null, 'an unknown id has a null title');
  assert.equal(ghost.pill.label, 'held: budget', 'the row says held itself');
  // Foreman on: still no Foreman row. It supervises the pool and leads the popover in its own row, never among the sessions.
  const on = rows({ foreman: true, office: session({ scope: '_office', status: 'idle', running: true }) });
  assert.deepEqual(on.map((r) => (r.kind === 'job' ? r.id : r.kind)), ['inbox', 'a-job', 'b-job', 'ghost']);
  // A job list without titles, or an empty pool, still lists the Inbox.
  assert.deepEqual(daemonRows(poolModel(pool(), { pending: false })!, []).map((r) => r.kind), ['inbox']);
  const untitled = daemonRows(poolModel(p, { pending: false })!, [{ id: 'a-job' }]);
  assert.ok(untitled.every((r) => r.kind !== 'job' || r.title === null));
});
