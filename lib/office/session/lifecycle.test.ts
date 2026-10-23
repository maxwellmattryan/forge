// createSession in-process, through the seams #416 cut it into (log, owned, control, timers, launch):
// a stub SessionContext, in-memory children and a log sink stand-in, so no CLI and no real claude.
// Each test names the docs/test-rewrite/modules/office.session.md items it covers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { repoTemplate, waitFor } from '../../../test/helpers.ts';
import { defaults, trustDigest } from '#core/config/load.ts';
import { createJob, loadJob, recordAgent, updateJob } from '#core/job/store.ts';
import { INBOX_SCOPE } from '#core/job/requests.ts';
import { createSession } from './lifecycle.ts';
import { sessionOptions, type LogSink, type SessionContext } from './contract.ts';
import { PERMISSION_DENIED, PROMPT_INPUT_CHARS, TURN_LINE } from './control.ts';
import { LOST_SUMMARY } from './owned.ts';
import type { Config, DaemonPermissionMode } from '#core/types.ts';

const CONFIG_TEXT = 'daemon:\n  enabled: true\n  command: claude {session}\n';
const repo = repoTemplate((dir) => {
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'config.yml'), CONFIG_TEXT);
});

/** In-memory children, modelled on test/integration/server/security.test.ts's fakeChildren. */
function children() {
  const list: any[] = [];
  const spawn: any = (cmd: string, args: string[], opts: any) => {
    const c: any = new EventEmitter();
    Object.assign(c, { cmd, args, opts, pid: 4_200_000 + list.length, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), written: '' });
    c.stdin.on('data', (d: Buffer) => (c.written += d.toString()));
    c.exit = (code: number | null, signal: string | null) => {
      if (c.exited) return;
      c.exited = true;
      c.stdout.end();
      c.stderr.end();
      c.emit('exit', code, signal);
      c.emit('close', code, signal);
    };
    c.line = (obj: unknown) => c.stdout.write(JSON.stringify(obj) + '\n');
    list.push(c);
    return c;
  };
  const killTree = (c: any, signal: string) => setTimeout(() => c.exit(null, signal), 5);
  return { list, spawn, killTree };
}

/** A sink stand-in; a `full` one returns false from every write, as a stream past its highWaterMark does. */
function memorySink(full = false) {
  const em = new EventEmitter();
  const written: string[] = [];
  const sink: LogSink = { write: (l) => (written.push(l), !full), on: () => undefined, once: (_e, fn) => em.once('drain', fn), end: (cb) => cb?.() };
  return { sink, written, drain: () => em.emit('drain') };
}

/** The lines claude's stdin received, parsed. */
const stdinLines = (c: any): any[] => c.written.split('\n').filter(Boolean).map((l: string) => JSON.parse(l));

interface RigOpts {
  job?: boolean;
  mode?: DaemonPermissionMode | null;
  turnTimeoutMs?: number;
  daemon?: Record<string, unknown>;
  sink?: LogSink;
}

function rig(t: any, opts: RigOpts = {}) {
  const r = repo();
  t.after(r.cleanup);
  const root = r.dir;
  const configFile = path.join(root, '.forge', 'config.yml');
  // Taken once, as a pool start does, so a row can change the file after it.
  const digest = trustDigest(root);
  const cfg: Config = defaults();
  cfg.daemon = { ...cfg.daemon, enabled: true, command: 'claude {session}', idleStopMinutes: null, ...opts.daemon } as Config['daemon'];
  const scope = opts.job ? createJob(root, cfg, { title: 'kept by its agents' }).id : INBOX_SCOPE;
  const calls = { emit: [] as any[], fatal: [] as string[], untrusted: 0, refused: [] as any[], loadConfig: [] as any[] };
  const ctx: SessionContext = {
    trusted: () => digest,
    poolWanted: () => true,
    config: () => cfg,
    untrusted: () => void calls.untrusted++,
    fatal: (m) => void calls.fatal.push(m),
    emit: (e) => void calls.emit.push(e),
    onResult: () => {},
    onExit: () => {},
    poke: () => {},
    permissionMode: () => opts.mode ?? null,
    permissionModeRefused: (s, mode, live) => void calls.refused.push({ scope: s, mode, live }),
    effort: () => ({ level: null, source: 'none' }),
  };
  const kids = children();
  const sink = opts.sink ?? memorySink().sink;
  const o = sessionOptions({
    spawn: kids.spawn,
    killTree: kids.killTree,
    graceMs: 500,
    env: { PATH: process.env.PATH },
    redactor: () => [],
    notify: (() => {}) as any,
    turnTimeoutMs: opts.turnTimeoutMs,
    openLog: () => sink,
    loadConfig: (_root, o2) => {
      calls.loadConfig.push(o2);
      return { config: cfg };
    },
  });
  const s = createSession(root, scope, ctx, o);
  t.after(() => s.close());
  const lineEvents = () => calls.emit.filter((e) => e.kind === 'line');
  const event = (name: string) => lineEvents().map((e) => JSON.parse(e.line)).filter((l) => l.type === 'forge-daemon' && l.event === name);
  return { root, scope, configFile, cfg, calls, kids, s, lineEvents, event };
}

const pending = [{ id: 'r1', type: 'new', job: null, status: 'pending' }] as any[];

// B11 (a fresh child gets nothing until a request; one written turn; a result makes it idle and
// commits the request), B43 (offsets and recent), B44 (backpressure until drain).
test('a session spawns, takes a turn and logs it', async (t) => {
  const r = rig(t);
  assert.equal(r.s.spawn(r.cfg), true);
  const [c] = r.kids.list;
  assert.equal(c.written, '');
  assert.deepEqual(r.s.route(r.cfg, pending), { eligible: ['r1'], fresh: true });
  r.s.writeTurn(['r1']);
  await waitFor(() => c.written === TURN_LINE, { what: 'the turn on stdin' });
  assert.equal(r.s.status, 'busy');
  c.line({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
  await waitFor(() => r.s.status === 'idle', { what: 'idle after the result' });
  assert.equal(c.written, TURN_LINE, 'a result writes nothing');
  assert.deepEqual(r.s.route(r.cfg, pending), { eligible: ['r1'], fresh: false });

  const lines = r.lineEvents();
  assert.ok(lines.length >= 4, 'spawn, effort, turn, the result line and result');
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i].offset > lines[i - 1].offset, `offset ${i} grows`);
  const after = lines[1].offset;
  assert.deepEqual(
    r.s.recent(after).map((l) => l.offset),
    lines.filter((l) => l.offset > after).map((l) => l.offset),
  );

  const full = memorySink(true);
  const b = rig(t, { sink: full.sink });
  b.s.spawn(b.cfg);
  const [bc] = b.kids.list;
  bc.line({ type: 'system', subtype: 'status', n: 1 });
  await waitFor(() => bc.stdout.isPaused(), { what: 'stdout paused on a full sink' });
  const held = full.written.length;
  bc.line({ type: 'system', subtype: 'status', n: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(full.written.length, held, 'nothing is read while the sink is full');
  full.drain();
  await waitFor(() => full.written.length > held, { what: 'the held line after drain' });
  assert.match(full.written[held], /"n":2/);
});

// B35, B36 (a prompt and its one answer), E5 (an input too large to show whole), B39, B40 (a mode
// switch, and a refused one that narrows or widens).
test('permission prompts and mode switches go through the control channel', async (t) => {
  const r = rig(t);
  r.s.spawn(r.cfg);
  const [c] = r.kids.list;
  const input = { command: 'cp a b', description: 'copy' };
  c.line({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input } });
  const [prompt] = await waitFor(() => r.s.state().permissions.length > 0 && r.s.state().permissions, { what: 'the prompt' });
  assert.equal(prompt.tool, 'Bash');
  assert.equal(prompt.input, JSON.stringify(input));
  assert.equal(r.s.answerPermission(prompt.id, 'allow'), 'Bash');
  await waitFor(() => stdinLines(c).length === 1, { what: 'the answer on stdin' });
  assert.deepEqual(stdinLines(c), [{ type: 'control_response', response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'allow', updatedInput: input } } }]);
  assert.equal(r.s.answerPermission(prompt.id, 'allow'), null);
  assert.deepEqual(r.s.state().permissions, []);

  c.line({ type: 'control_request', request_id: 'req-2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'x'.repeat(PROMPT_INPUT_CHARS) } } });
  await waitFor(() => stdinLines(c).length === 2, { what: 'the denial on stdin' });
  assert.deepEqual(stdinLines(c)[1].response, { subtype: 'success', request_id: 'req-2', response: { behavior: 'deny', message: PERMISSION_DENIED } });
  assert.deepEqual(r.s.state().permissions, [], 'a prompt it cannot show whole is never shown');

  const rows: { launch: DaemonPermissionMode; to: DaemonPermissionMode; stops: boolean }[] = [
    { launch: 'auto', to: 'dontAsk', stops: true },
    { launch: 'dontAsk', to: 'auto', stops: false },
  ];
  for (const row of rows) {
    const m = rig(t, { mode: row.launch });
    m.s.spawn(m.cfg);
    const [mc] = m.kids.list;
    assert.equal(m.s.setPermissionMode(row.to), true);
    await waitFor(() => stdinLines(mc).length === 1, { what: 'the mode request' });
    const [ask] = stdinLines(mc);
    assert.equal(ask.type, 'control_request');
    assert.deepEqual(ask.request, { subtype: 'set_permission_mode', mode: row.to });
    mc.line({ type: 'control_response', response: { subtype: 'error', request_id: ask.request_id, error: 'refused' } });
    if (row.stops) {
      await waitFor(() => !m.s.running, { what: `the ${row.launch} child stopped` });
      assert.equal(m.event('stop').at(-1)?.reason, 'permission-mode');
      assert.deepEqual(m.calls.refused, []);
    } else {
      await waitFor(() => m.calls.refused.length === 1, { what: 'the refusal reported' });
      assert.deepEqual(m.calls.refused, [{ scope: INBOX_SCOPE, mode: row.to, live: row.launch }]);
      assert.equal(m.s.running, true);
    }
  }
});

// B27 (a turn past its limit), B25 (an idle child past daemon.idleStopMinutes).
test('a hung turn and an idle session are stopped', async (t) => {
  const rows: { name: string; opts: RigOpts; turn: boolean; event: string; stop: string; reason: string }[] = [
    { name: 'hung turn', opts: { turnTimeoutMs: 30 }, turn: true, event: 'turn-timeout', stop: 'stop', reason: 'turn-timeout' },
    { name: 'idle', opts: { daemon: { idleStopMinutes: 0.001 } }, turn: false, event: 'idle-stop', stop: 'idle-stop', reason: 'idle' },
  ];
  for (const row of rows) {
    const r = rig(t, row.opts);
    r.s.spawn(r.cfg);
    if (row.turn) r.s.writeTurn(['r1']);
    await waitFor(() => !r.s.running && r.s.status === 'off', { what: `the ${row.name} child stopped` });
    assert.equal(r.event(row.event).length, 1, row.name);
    assert.equal(r.event(row.stop).at(-1)?.reason, row.reason, row.name);
    assert.equal(r.s.wanted, true, `${row.name}: still wanted`);
  }
});

// B28 (kept by its job's running agent), B30 (that agent lost on exit), B33 (the lease expires),
// B29 (facts' ids hold the spawn id).
test("an exit lets go of its job's agents and lease", async (t) => {
  const r = rig(t, { job: true });
  r.s.spawn(r.cfg);
  const sid = r.s.state().sessionId!;
  const at = new Date().toISOString();
  updateJob(r.root, r.scope, (j) => {
    j.lease = { driver: sid, epoch: 1, since: at, renewedAt: at, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
  });
  recordAgent(r.root, r.scope, { role: 'builder', phase: 'start' }, defaults());
  r.s.refreshKept();
  assert.equal(r.s.kept, 'agents');
  r.kids.list[0].exit(1, null);
  await waitFor(() => !r.s.running, { what: 'the exit' });
  const job = loadJob(r.root, r.scope);
  assert.equal(job.agents.builder?.status, 'lost');
  assert.equal(job.agents.builder?.summary, LOST_SUMMARY);
  assert.ok(Date.parse(job.lease.expiresAt!) <= Date.now(), 'the lease is expired');
  assert.ok(r.s.facts().ids.includes(sid));
});

// B10 (argv from the bytes it hashed, no second read), E7 (a config changed since the digest, daemon.enabled false).
test('a spawn starts only on the trusted config it hashed', (t) => {
  const rows: { name: string; before: (r: ReturnType<typeof rig>) => void; spawned: boolean; untrusted: number; fatal: string[] }[] = [
    { name: 'config changed after the digest', before: (r) => fs.appendFileSync(r.configFile, '# edited\n'), spawned: false, untrusted: 1, fatal: [] },
    { name: 'daemon.enabled false', before: (r) => void (r.cfg.daemon.enabled = false), spawned: false, untrusted: 0, fatal: ['daemon.enabled is false in .forge/config.yml'] },
    { name: 'a good spawn', before: () => {}, spawned: true, untrusted: 0, fatal: [] },
  ];
  for (const row of rows) {
    const r = rig(t);
    row.before(r);
    assert.equal(r.s.spawn(r.cfg), row.spawned, row.name);
    assert.equal(r.kids.list.length, row.spawned ? 1 : 0, row.name);
    assert.equal(r.calls.untrusted, row.untrusted, row.name);
    assert.deepEqual(r.calls.fatal, row.fatal, row.name);
    if (row.spawned) assert.deepEqual(r.calls.loadConfig, [{ text: fs.readFileSync(r.configFile, 'utf8') }], row.name);
  }
});
