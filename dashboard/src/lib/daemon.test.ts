// The Daemon popover's two pure halves: the billing line (which text /api/state's config.daemon.billing shows, and whether it warns)
// and the pool model (the pill, the note and Start for a pool that is off).
import test from 'node:test';
import assert from 'node:assert/strict';
import { billingNote, poolModel, scopeSession, sessionMode, sessionPill } from './daemon.ts';
import { activeSessions } from './live.ts';
import { pendingPrompts } from './permissions.ts';
import { barModel } from './statusbar.ts';

test("billingNote picks the Daemon popover's warning", () => {
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

test('assistant foremen in the pool model', () => {
  const prompt = { id: 'p1', tool: 'Bash', input: '{}', description: null, agentId: null, blockedPath: null, sessionRules: [], sessionDirs: [], at: '2026-10-25T00:00:00.000Z' };
  const assistant = { scope: '_assistant-1', status: 'busy', running: true, wanted: true, permissions: [prompt] } as any;
  const pool = {
    enabled: true,
    wanted: true,
    maxConcurrent: 2,
    live: 0,
    lastError: null,
    inbox: { scope: '_inbox', status: 'off', running: false },
    office: { scope: '_office', status: 'off', running: false },
    foreman: true,
    assistants: { '_assistant-1': assistant },
    jobs: {},
    permissionMode: 'default',
    jobPermissionMode: 'auto',
    permissionModes: {},
  } as any;
  assert.deepEqual(pendingPrompts(pool).map((p) => [p.scope, p.prompt.id]), [['_assistant-1', 'p1']]);
  assert.equal(scopeSession(pool, '_assistant-1'), assistant);
  assert.equal(sessionMode(pool, '_assistant-1', assistant).chosen, 'default', "daemon.command's mode, not the job default");
  const foreman = barModel(pool, { pending: false }).foreman;
  assert.ok(foreman.on);
  assert.deepEqual([foreman.active, foreman.prompts, foreman.assistants], [true, 1, ['_assistant-1']]);
  // The office never runs here: the Foreman's pill is its most urgent session's, with one title line per session.
  assert.deepEqual([foreman.pill.label, foreman.pill.tone], ['needs permission', 'warn']);
  assert.equal(foreman.pill.title.split('\n').length, 2);
  const working = barModel({ ...pool, assistants: { '_assistant-1': { ...assistant, permissions: [] } } }, { pending: false }).foreman;
  assert.ok(working.on);
  assert.deepEqual([working.pill.label, working.pill.tone], ['busy', 'live']);
  const alone = barModel({ ...pool, assistants: {} }, { pending: false }).foreman;
  assert.ok(alone.on);
  assert.deepEqual(alone.pill, sessionPill(pool.office), 'with no assistant foremen, the office keeps its own pill');
  assert.deepEqual(activeSessions(pool).ids, ['_assistant-1']);
});
