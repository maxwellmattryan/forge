// The Workers popover's pure halves: the billing line (which text /api/state's config.daemon.billing shows, and whether it warns),
// the pool model (the pill, the note and Start for a pool that is off) and its job session rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { billingNote, daemonRows, poolModel, scopeSession, sessionMode, sessionPill } from './daemon.ts';
import { activeSessions } from './live.ts';
import { pendingPrompts } from './permissions.ts';
import { barModel } from './statusbar.ts';

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
      'b-job': { scope: 'b-job', status: 'idle', running: true, wanted: true },
      'a-job': { scope: 'a-job', status: 'busy', running: true, wanted: true },
      ghost: { scope: 'ghost', status: 'off', running: false, held: 'budget' },
    },
    permissionModes: { 'b-job': 'auto' },
  } as any;
  const rows = daemonRows(poolModel(pool, { pending: false })!, [{ id: 'a-job', title: 'Job A' }]);
  assert.deepEqual(rows.map((r) => r.id), ['a-job', 'b-job', 'ghost']);
  assert.equal(rows.find((r) => r.id === 'b-job')!.mode, 'auto');
  assert.equal(rows.find((r) => r.id === 'ghost')!.title, null);
  assert.equal(rows.find((r) => r.id === 'a-job')!.title, 'Job A');
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

test('the office in the pool model: no session but its own', () => {
  const prompt = { id: 'p1', tool: 'Bash', input: '{}', description: null, agentId: null, blockedPath: null, sessionRules: [], sessionDirs: [], at: '2026-10-25T00:00:00.000Z' };
  const office = { scope: '_office', status: 'busy', running: true, wanted: true, permissions: [prompt] } as any;
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
  assert.deepEqual(pendingPrompts(pool).map((p) => [p.scope, p.prompt.id]), [['_office', 'p1']]);
  assert.equal(scopeSession(pool, '_office'), office);
  assert.equal(scopeSession(pool, '_assistant-1'), null, 'a legacy assistant scope names no session');
  assert.equal(sessionMode(pool, '_office', office).chosen, 'default', "daemon.command's mode, not the job default");
  assert.deepEqual(activeSessions(pool).ids, ['_office']);
  // The Foreman keeps the office's own pill: a gate run is no session.
  const foreman = barModel(pool, { pending: false }).foreman;
  assert.ok(foreman.on);
  assert.deepEqual(foreman.pill, sessionPill(office));
});
