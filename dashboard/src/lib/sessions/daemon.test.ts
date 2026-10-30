// The Workers popover's pure halves: the billing line (which text /api/state's config.daemon.billing shows, and whether it warns),
// the pool model (the pill, the note and Start for a pool that is off) and its job session rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { billingNote, daemonRows, jobFallbackMode, launchMode, poolModel, scopeSession, sessionMode, sessionPill } from './daemon.ts';
import { activeSessions } from './live.ts';
import { pendingPrompts, sessionPrompts, timedOutPrompts } from './permissions.ts';
import { barModel } from '../shell/statusbar.ts';

test('daemonRows lists only job sessions, in status order', () => {
  const pool = {
    enabled: true,
    wanted: true,
    maxConcurrent: 3,
    live: 2,
    lastError: null,
    foreman: false,
    inbox: { scope: '_inbox', status: 'idle', running: true, wanted: true },
    jobs: {
      'b-job': { scope: 'b-job', status: 'idle', running: true, wanted: true, contextTokens: 'lots' },
      'a-job': { scope: 'a-job', status: 'busy', running: true, wanted: true, contextTokens: 245000 },
      ghost: { scope: 'ghost', status: 'off', running: false, held: 'budget' },
    },
    permissionModes: { 'b-job': 'auto' },
  } as any;
  const rows = daemonRows(poolModel(pool, { pending: false })!, [{ id: 'a-job', title: 'Job A' }]);
  assert.deepEqual(rows.map((r) => r.id), ['a-job', 'b-job', 'ghost']);
  assert.equal(rows.find((r) => r.id === 'b-job')!.mode, 'auto');
  assert.equal(rows.find((r) => r.id === 'ghost')!.title, null);
  assert.equal(rows.find((r) => r.id === 'a-job')!.title, 'Job A');
  assert.deepEqual(rows.map((r) => r.context), [245000, null, null], 'a number, a non-number, none');
  assert.ok(!rows.some((r) => r.id === '_inbox' || r.id === 'inbox'), 'no row is the inbox');
  assert.deepEqual(daemonRows(poolModel({ ...pool, jobs: {}, permissionModes: {} }, { pending: false })!, []), []);
});

test("billingNote picks the Workers popover's warning", () => {
  assert.equal(billingNote(null), null);
  assert.equal(billingNote(undefined), null);
  assert.equal(billingNote({ vars: [], passed: false, warn: false }), null);
  assert.deepEqual(billingNote({ vars: ['CLAUDE_CODE_USE_BEDROCK'], passed: false, warn: true }), { passed: false, vars: 'CLAUDE_CODE_USE_BEDROCK', warn: true });
  assert.deepEqual(billingNote({ vars: ['A', 'B'], passed: true, warn: true }), { passed: true, vars: 'A, B', warn: true });
  // An API key alone under api-key: the line stays, muted, as doctor doesn't warn either.
  assert.deepEqual(billingNote({ vars: ['ANTHROPIC_API_KEY'], passed: true, warn: false }), { passed: true, vars: 'ANTHROPIC_API_KEY', warn: false });
});

test('a pool off until a human approves its files asks for that, and is no error', () => {
  const off = { enabled: true, wanted: false, maxConcurrent: 2, live: 0, lastError: null, jobs: {}, foreman: false };
  const opts = { pending: false };

  // The machine dashboard left this project's pool off: a warn pill and Start, which approves; nothing reads as a failure.
  const unapproved = poolModel({ ...off, needsApproval: true }, opts)!;
  assert.deepEqual([unapproved.pill.label, unapproved.pill.tone, unapproved.approval], ['needs approval', 'warn', true]);
  assert.deepEqual([unapproved.error, unapproved.startHint, unapproved.canStart, unapproved.toggle], [null, null, true, { action: 'start', enabled: true }]);

  // Once it runs the flag means nothing; a pool that fails for another reason is still an error.
  const running = poolModel({ ...off, wanted: true, needsApproval: true }, opts)!;
  assert.deepEqual([running.pill.label, running.approval], ['standby', false]);
  const failed = poolModel({ ...off, needsApproval: false, lastError: 'cannot start daemon: no claude' }, opts)!;
  assert.deepEqual([failed.pill.label, failed.pill.tone, failed.approval], ['error', 'bad', false]);
  assert.equal(poolModel(off, opts)!.approval, false);
});

test('the office in the pool model: office runs, no session', () => {
  const prompt = { id: 'p1', tool: 'Bash', input: '{}', description: null, agentId: null, blockedPath: null, sessionRules: [], sessionDirs: [], at: '2026-10-25T00:00:00.000Z' };
  const office = { enabled: true, live: 1, held: null, runs: [] } as any;
  const pool = {
    enabled: true,
    wanted: true,
    maxConcurrent: 2,
    live: 0,
    lastError: null,
    inbox: { scope: '_inbox', status: 'off', running: false },
    office,
    foreman: true,
    gates: { enabled: true, parallel: 2, live: 1, held: null, runs: [] },
    jobs: {},
    permissionMode: 'default',
    jobPermissionMode: 'auto',
    permissionModes: {},
  } as any;
  // No office run asks anyone: even a stray prompt list on the office state is no session's.
  assert.deepEqual(pendingPrompts({ ...pool, office: { ...office, scope: '_office', permissions: [prompt] } }), []);
  // A session the pool doesn't list (a chat's): its own prompts, with the scope given, oldest first, skipping one with no id.
  const chat = { status: 'busy', permissions: [{ ...prompt, id: 'p3', at: '2026-10-25T00:00:02.000Z' }, { ...prompt, id: '' }, { ...prompt, id: 'p2', at: '2026-10-25T00:00:01.000Z' }, 'junk'] } as any;
  assert.deepEqual(sessionPrompts(chat, '_chat-0123456789ab').map((p) => [p.scope, p.prompt.id]), [['_chat-0123456789ab', 'p2'], ['_chat-0123456789ab', 'p3']]);
  assert.deepEqual(sessionPrompts(chat, '_chat-0123456789ab')[0]?.prompt, { ...prompt, id: 'p2', at: '2026-10-25T00:00:01.000Z' });
  for (const none of [null, undefined, { status: 'idle' }, { permissions: 'x' }] as any[]) assert.deepEqual(sessionPrompts(none, '_chat-0123456789ab'), [], JSON.stringify(none));
  assert.equal(scopeSession(pool, '_office'), null, 'no session serves the office');
  assert.equal(scopeSession(pool, '_assistant-1'), null, 'a legacy assistant scope names no session');
  assert.equal(sessionMode(pool, '_inbox', pool.inbox).chosen, 'default', "daemon.command's mode, not the job default");
  // With a launch mode the inbox starts in it, unless a human chose another; a job keeps the job default.
  const launched = { ...pool, permissionMode: 'default', jobPermissionMode: 'dontAsk', launchPermissionMode: 'auto' };
  assert.equal(sessionMode(launched, '_inbox', pool.inbox).chosen, 'auto');
  assert.equal(sessionMode({ ...launched, permissionModes: { _inbox: 'default' } }, '_inbox', pool.inbox).chosen, 'default', "the session's own choice wins");
  assert.equal(sessionMode(launched, 'j-1', null).chosen, jobFallbackMode(launched), 'a job keeps the job default');
  assert.equal(sessionMode(launched, 'j-1', null).chosen, 'dontAsk');
  assert.deepEqual(activeSessions(pool).ids, [], 'an office run is no session');
  assert.equal(poolModel(pool, { pending: false })?.pill.label, 'standby', 'nor does it make the Workers pill busy');
  // The Foreman's pill is busy while an office run is live.
  const foreman = barModel(pool, { pending: false }).foreman;
  assert.ok(foreman.on);
  assert.deepEqual([foreman.pill.label, foreman.active], ['busy', true]);
});

test('timedOutPrompts lists denied prompts newest first and tolerates an older server', () => {
  const prompt = { id: 'p1', tool: 'Bash', input: '{"command":"git status"}', description: 'check', agentId: null, blockedPath: null, sessionRules: [], sessionDirs: [], at: '2026-10-25T00:00:00.000Z' };
  const denied = (id: string, deniedAt: string) => ({ ...prompt, id, deniedAt });
  const pool = {
    inbox: { scope: '_inbox', timedOut: [denied('i1', '2026-10-25T00:01:00.000Z')] },
    office: { scope: '_office', timedOut: 'junk' },
    jobs: {
      'j-1': { scope: 'j-1', permissions: [prompt], timedOut: [denied('a', '2026-10-25T00:03:00.000Z'), { ...denied('', '2026-10-25T00:09:00.000Z') }, 'junk'] },
      'j-2': { scope: 'j-2', timedOut: [denied('b', '2026-10-25T00:02:00.000Z'), { ...prompt, id: 'c' }] },
    },
  } as any;
  assert.deepEqual(
    timedOutPrompts(pool).map((p) => [p.scope, p.prompt.id, p.prompt.deniedAt]),
    [
      ['j-1', 'a', '2026-10-25T00:03:00.000Z'],
      ['j-2', 'b', '2026-10-25T00:02:00.000Z'],
      ['_inbox', 'i1', '2026-10-25T00:01:00.000Z'],
      ['j-2', 'c', ''],
    ],
  );
  assert.deepEqual(timedOutPrompts(pool)[0].prompt, denied('a', '2026-10-25T00:03:00.000Z'), 'every field read');
  // The history never counts as pending.
  assert.deepEqual(pendingPrompts(pool).map((p) => [p.scope, p.prompt.id]), [['j-1', 'p1']]);
  // An older server's sessions carry no timedOut.
  const older = { inbox: { scope: '_inbox', permissions: [prompt] }, jobs: { 'j-1': { scope: 'j-1' } } } as any;
  for (const none of [older, null, undefined, {}] as any[]) assert.deepEqual(timedOutPrompts(none), [], JSON.stringify(none));
});

test('launchMode reads only the three modes', () => {
  for (const mode of ['default', 'auto', 'dontAsk']) assert.equal(launchMode({ launchPermissionMode: mode }), mode);
  for (const v of [{}, { launchPermissionMode: 'bypassPermissions' }, { launchPermissionMode: 1 }, { launchPermissionMode: null }, null, undefined]) assert.equal(launchMode(v), null, JSON.stringify(v));
});
