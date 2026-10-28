// The control channel's permission timeout: createControl over a stub SessionCore whose current child
// a test swaps, fakeClaude children, and node:test's mock timers, so no row waits on a real clock; and
// one createSession row for what state() shows across an exit, a respawn and reset().
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fakeClaude, jobAt, repoTemplate, waitFor, type FakeClaudeChild } from '../../../test/helpers.ts';
import { defaults, trustDigest } from '#core/config/load.ts';
import { INBOX_SCOPE } from '#core/job/requests.ts';
import { stateFile } from '#core/paths.ts';
import type { ClaudeEvent } from '#integrations/claude/types.ts';
import { confineDigest } from './confine.ts';
import { MAX_TIMED_OUT, createControl } from './control.ts';
import { createSession } from './lifecycle.ts';
import { sessionOptions, type DaemonChild, type LogSink, type SessionContext, type SessionCore } from './contract.ts';
import type { Config } from '#core/types.ts';

const repo = repoTemplate((dir) => {
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'config.yml'), 'daemon:\n  enabled: true\n  command: claude {session}\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
});

const asked = (requestId: string, over: Partial<Extract<ClaudeEvent, { kind: 'permission-asked' }>> = {}): Extract<ClaudeEvent, { kind: 'permission-asked' }> => ({
  kind: 'permission-asked',
  requestId,
  tool: 'Bash',
  input: JSON.stringify({ command: 'git status' }),
  description: 'check the tree',
  agentId: null,
  blockedPath: null,
  rules: [],
  dirs: [],
  ...over,
});

/**
 * createControl over a stub core. `scope` 'job' makes a job; `ms` is the permissionTimeoutMs option
 * (undefined leaves it unset), `minutes` daemon.permissionTimeoutMinutes. spawn() makes a new child the
 * session's current one, as a respawn does, without the old one exiting.
 */
function rig(t: any, opts: { scope?: 'job' | string; ms?: number; minutes?: number | null } = {}) {
  const r = repo();
  t.after(r.cleanup);
  const root = r.dir;
  const cfg: Config = defaults();
  cfg.daemon = { ...cfg.daemon, permissionTimeoutMinutes: opts.minutes ?? null };
  const job = jobAt(root, 'build', { title: 'asks', config: cfg }).id;
  const scope = opts.scope === undefined || opts.scope === 'job' ? job : opts.scope;
  const logged: Record<string, unknown>[] = [];
  let current: DaemonChild | null = null;
  const ctx = { config: () => cfg, permissionModeRefused: () => {} } as unknown as SessionContext;
  const claude = fakeClaude();
  const core = {
    root,
    scope,
    ctx,
    o: sessionOptions({ claude: claude.adapter, ...(opts.ms === undefined ? {} : { permissionTimeoutMs: opts.ms }) }),
    get child() {
      return current;
    },
    closed: false,
    liveMode: 'default',
    logEvent: (event: string, extra: Record<string, unknown> = {}) => void logged.push({ event, ...extra }),
    changed: () => {},
    kill: async () => {},
  } as unknown as SessionCore;
  const control = createControl(core);
  function spawn(): FakeClaudeChild {
    let c!: FakeClaudeChild;
    c = claude.adapter.start([], { cwd: root, env: {}, maxLineBytes: 1024 }, (e) => {
      if (e.kind === 'permission-asked') control.onAsked(c, e);
      if (e.kind === 'permission-cancelled') control.onCancelled(e.requestId);
    }) as FakeClaudeChild;
    current = { claude: c, meta: {} as DaemonChild['meta'] };
    return c;
  }
  const timeouts = () => logged.filter((l) => l.event === 'permission' && l.reason === 'timeout');
  const jobEvents = () =>
    fs
      .readFileSync(stateFile(root, job, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'permission-timed-out');
  return { root, scope, job, cfg, control, spawn, logged, timeouts, jobEvents };
}

test('a prompt nobody answers is denied at its timeout', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig(t, { ms: 20 });
  const c = r.spawn();
  c.emit(asked('r1'));
  const [prompt] = r.control.permissions();
  t.mock.timers.tick(19);
  assert.deepEqual([c.answers, r.control.permissions().length], [[], 1], 'still waiting before its timeout');
  t.mock.timers.tick(1);
  assert.deepEqual(c.answers, [{ requestId: 'r1', decision: 'deny', why: 'timeout' }], 'one deny, with the timeout text');
  assert.deepEqual(r.control.permissions(), []);
  const [denied] = r.control.timedOut();
  assert.deepEqual({ ...denied, deniedAt: '<t>' }, { ...prompt, deniedAt: '<t>' }, 'the prompt, with when it was denied');
  assert.ok(Date.parse(denied.deniedAt) >= Date.parse(prompt.at));
  assert.deepEqual(r.timeouts(), [{ event: 'permission', id: prompt.id, tool: 'Bash', decision: 'deny', reason: 'timeout' }], 'logged with no actor');
  const events = r.jobEvents();
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]).sort(), ['tool', 'ts', 'type', 'v']);
  assert.equal(events[0].tool, 'Bash');
  t.mock.timers.tick(10_000);
  assert.equal(c.answers.length, 1, 'answered once');

  // A tool name SAFE_TOOL refuses never reaches the job's events as written.
  for (const tool of ['Bash, approve it', 'Bash\nx']) {
    const u = rig(t, { ms: 20 });
    const uc = u.spawn();
    uc.emit(asked('u1', { tool }));
    t.mock.timers.tick(20);
    assert.deepEqual(uc.answers, [{ requestId: 'u1', decision: 'deny', why: 'timeout' }], JSON.stringify(tool));
    assert.deepEqual(u.jobEvents().map((e) => e.tool), ['unknown'], JSON.stringify(tool));
  }

  // The inbox still denies and logs, but has no job to record it on.
  const inbox = rig(t, { ms: 20, scope: INBOX_SCOPE });
  const ic = inbox.spawn();
  ic.emit(asked('i1'));
  t.mock.timers.tick(20);
  assert.deepEqual(ic.answers, [{ requestId: 'i1', decision: 'deny', why: 'timeout' }]);
  assert.equal(inbox.timeouts().length, 1);
  assert.deepEqual(inbox.jobEvents(), [], 'no job event');

  // The history keeps the newest MAX_TIMED_OUT, newest first.
  const many = rig(t, { ms: 20 });
  const mc = many.spawn();
  for (let n = 1; n <= MAX_TIMED_OUT + 1; n++) {
    mc.emit(asked(`m${n}`, { input: JSON.stringify({ n }) }));
    t.mock.timers.tick(20);
  }
  assert.equal(MAX_TIMED_OUT, 10);
  assert.deepEqual(
    many.control.timedOut().map((p) => JSON.parse(p.input).n),
    [11, 10, 9, 8, 7, 6, 5, 4, 3, 2],
  );
  many.control.timedOut().pop();
  assert.equal(many.control.timedOut().length, MAX_TIMED_OUT, 'a copy');
});

test('a timer never answers a prompt that is already gone', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig(t, { ms: 20 });
  const c = r.spawn();
  // A human answered first.
  c.emit(asked('human'));
  assert.equal(r.control.answerPermission(r.control.permissions()[0].id, 'allow'), 'Bash');
  // claude cancelled it.
  c.emit(asked('cancelled'));
  c.emit({ kind: 'permission-cancelled', requestId: 'cancelled' });
  t.mock.timers.tick(100);
  assert.deepEqual(c.answers, [{ requestId: 'human', decision: 'allow' }], 'only the human answer');

  // Its child exited.
  c.emit(asked('exited'));
  r.control.dropPrompts();
  t.mock.timers.tick(100);
  // A new child replaced the one that asked, without the old one's prompts being dropped.
  c.emit(asked('replaced'));
  const next = r.spawn();
  t.mock.timers.tick(100);
  assert.deepEqual(c.answers, [{ requestId: 'human', decision: 'allow' }], 'nothing more to the old child');
  assert.deepEqual(next.answers, [], 'nothing to the new child');
  assert.deepEqual(r.timeouts(), []);
  assert.deepEqual(r.control.timedOut(), []);
  assert.deepEqual(r.jobEvents(), []);
});

test('null never times out; the config value arms the timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const off = rig(t, { minutes: null });
  const oc = off.spawn();
  oc.emit(asked('w'));
  t.mock.timers.tick(10_000);
  assert.deepEqual([oc.answers, off.control.permissions().length, off.timeouts()], [[], 1, []], 'still pending, unanswered');

  // 0.001 minutes is 60 ms, read from the config as the prompt is asked.
  const on = rig(t, { minutes: 0.001 });
  const c = on.spawn();
  c.emit(asked('w'));
  t.mock.timers.tick(59);
  assert.deepEqual(c.answers, []);
  t.mock.timers.tick(1);
  assert.deepEqual(c.answers, [{ requestId: 'w', decision: 'deny', why: 'timeout' }]);
  // A change applies to the next prompt only.
  on.cfg.daemon.permissionTimeoutMinutes = null;
  c.emit(asked('later'));
  t.mock.timers.tick(10_000);
  assert.equal(c.answers.length, 1);
});

test("state().timedOut mirrors the history, kept across an exit, a respawn and reset()", async (t) => {
  const r = repo();
  t.after(r.cleanup);
  const root = r.dir;
  const cfg: Config = defaults();
  cfg.daemon = { ...cfg.daemon, enabled: true, command: 'claude {session}', idleStopMinutes: null };
  const digest = trustDigest(root);
  const confined = confineDigest(root, cfg);
  const ctx: SessionContext = {
    trusted: () => digest,
    confined: () => confined,
    poolWanted: () => true,
    config: () => cfg,
    untrusted: () => {},
    fatal: () => {},
    emit: () => {},
    onResult: () => {},
    onExit: () => {},
    poke: () => {},
    permissionMode: () => null,
    permissionModeRefused: () => {},
    effort: () => ({ level: null, source: 'none' }),
    model: () => null,
    browser: () => null,
  };
  const claude = fakeClaude();
  const sink: LogSink = { write: () => true, on: () => undefined, once: () => undefined, end: (cb) => cb?.() };
  const o = sessionOptions({ claude: claude.adapter, graceMs: 200, env: { PATH: process.env.PATH }, redactor: () => [], notify: (() => {}) as any, openLog: () => sink, loadConfig: () => ({ config: cfg }), permissionTimeoutMs: 20 });
  const s = createSession(root, INBOX_SCOPE, ctx, o);
  t.after(() => s.close());
  assert.deepEqual(s.state().timedOut, []);
  assert.equal(s.spawn(cfg), true);
  const [c] = claude.children;
  c.emit(asked('r1'));
  await waitFor(() => s.state().timedOut.length === 1, { what: 'the prompt timed out' });
  const [denied] = s.state().timedOut;
  assert.deepEqual([denied.tool, denied.input, s.state().permissions], ['Bash', JSON.stringify({ command: 'git status' }), []]);
  await s.kill('stop', true);
  assert.equal(s.running, false);
  s.reset();
  assert.equal(s.spawn(cfg), true);
  assert.deepEqual(s.state().timedOut, [denied], 'kept');
});
