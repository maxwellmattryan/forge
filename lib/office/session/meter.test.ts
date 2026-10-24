// The supervisor's meter, through createSession in-process: a stub SessionContext whose notify records calls,
// fakeClaude children whose results carry claude's cumulative cost, and a log sink stand-in. Copies
// lifecycle.test.ts's rig rather than importing from another test file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fakeClaude, jobAt, repoTemplate, waitFor } from '../../../test/helpers.ts';
import { defaults, trustDigest } from '#core/config/load.ts';
import { INBOX_SCOPE, OFFICE_SCOPE } from '#core/job/requests.ts';
import { loadJob, readEvents } from '#core/job/store.ts';
import { meterFile, readMeter } from '#engine/metrics/meter.ts';
import type { SessionCost } from '#integrations/claude/types.ts';
import { confineDigest } from './confine.ts';
import { heldByBudget } from './holds.ts';
import { createSession } from './lifecycle.ts';
import { sessionOptions, type LogSink, type SessionContext } from './contract.ts';
import type { Config } from '#core/types.ts';

const repo = repoTemplate((dir) => {
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'config.yml'), 'daemon:\n  enabled: true\n  command: claude {session}\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
});

/** One session of `scope` ('job' makes a job running at build) under a config with `daemon` and `budget` on top of the defaults. */
function rig(t: any, scope: 'job' | string, opts: { daemon?: Record<string, unknown>; budget?: Record<string, number | null> } = {}) {
  const r = repo();
  t.after(r.cleanup);
  const root = r.dir;
  const digest = trustDigest(root);
  const cfg: Config = defaults();
  cfg.daemon = { ...cfg.daemon, enabled: true, command: 'claude {session}', idleStopMinutes: null, ...opts.daemon } as Config['daemon'];
  cfg.pipeline.budget = { ...cfg.pipeline.budget, ...opts.budget };
  const confined = confineDigest(root, cfg);
  const id = scope === 'job' ? jobAt(root, 'build', { title: 'metered', config: cfg }).id : scope;
  const notified: unknown[][] = [];
  const emitted: any[] = [];
  const ctx: SessionContext = {
    trusted: () => digest,
    confined: () => confined,
    poolWanted: () => true,
    config: () => cfg,
    untrusted: () => {},
    fatal: () => {},
    emit: (e) => void emitted.push(e),
    onResult: () => {},
    onExit: () => {},
    poke: () => {},
    permissionMode: () => null,
    permissionModeRefused: () => {},
    effort: () => ({ level: null, source: 'none' }),
  };
  const claude = fakeClaude();
  const sink: LogSink = { write: () => true, on: () => undefined, once: () => undefined, end: (cb) => cb?.() };
  const o = sessionOptions({
    claude: claude.adapter,
    graceMs: 500,
    env: { PATH: process.env.PATH },
    redactor: () => [],
    notify: ((...args: unknown[]) => void notified.push(args)) as any,
    openLog: () => sink,
    loadConfig: () => ({ config: cfg }),
  });
  const s = createSession(root, id, ctx, o);
  t.after(() => s.close());
  const event = (name: string) => emitted.filter((e) => e.kind === 'line').map((e) => JSON.parse(e.line)).filter((l) => l.type === 'forge-daemon' && l.event === name);
  return { root, scope: id, cfg, s, children: claude.children, notified, event };
}

const cost = (usd: number): SessionCost => ({ usd, models: { 'claude-sonnet-5-5': { usd, input: Math.round(usd * 100), output: 0, cacheRead: 0, cacheWrite: 0 } } });
const result = (usd: number) => ({ kind: 'turn-ended' as const, ok: true as const, cost: cost(usd) });
const metered = (root: string, scope: string) => readMeter(root, scope).map((r) => r.usd);

test("a job session's results are metered per spawn", async (t) => {
  const r = rig(t, 'job');
  assert.equal(r.s.spawn(r.cfg), true);
  const first = r.children[0];
  // Its first stdout line makes the session resumable.
  first.emit({ kind: 'log', stream: 'stdout', line: '{}' });
  r.s.writeTurn(['r1']);
  first.emit(result(1));
  r.s.writeTurn(['r2']);
  first.emit(result(2.5));
  first.emit({ kind: 'turn-ended', ok: true });
  assert.deepEqual(metered(r.root, r.scope), [1, 1.5], 'a fresh spawn, then the delta; a result without cost writes nothing');

  await r.s.kill('stop', true);
  assert.equal(r.s.spawn(r.cfg), true);
  const resumed = r.children[1];
  assert.equal(resumed.argv[1], '--resume', 'the same session id, resumed');
  resumed.emit({ kind: 'turn-started' });
  resumed.emit(result(3));
  assert.deepEqual(metered(r.root, r.scope), [1, 1.5, 0.5], 'measured from the last cumulative of that session');

  // A resume whose transcript is gone starts a fresh session, which counts from zero.
  await r.s.kill('stop', true);
  assert.equal(r.s.spawn(r.cfg), true);
  r.children[2].exit(1, null);
  await waitFor(() => r.children.length === 4 && r.s.running, { what: 'the fresh respawn' });
  r.children[3].emit(result(0.4));
  const records = readMeter(r.root, r.scope);
  assert.deepEqual(records.map((x) => x.usd), [1, 1.5, 0.5, 0.4]);
  assert.notEqual(records[3].sessionId, records[2].sessionId, 'a new session id');
  assert.equal(new Set(records.map((x) => x.spawnId)).size, 3, 'one spawn id per metered spawn');
  assert.deepEqual(r.event('meter').map((l) => l.usd), [1, 1.5, 0.5, 0.4], 'a meter event per record');

  // A meter path that can't be written never stops the session.
  const broken = rig(t, 'job');
  fs.mkdirSync(meterFile(broken.root, broken.scope), { recursive: true });
  broken.s.spawn(broken.cfg);
  broken.s.writeTurn(['r1']);
  broken.children[0].emit(result(1));
  assert.match(broken.event('error').at(-1)?.message ?? '', /^meter: /);
  assert.equal(broken.s.status, 'idle');
  assert.equal(broken.s.wanted, true);

  // A meter that can't be read leaves the job on its reported figure, said once in the session log.
  const big = rig(t, 'job');
  oversize(big.root, big.scope);
  big.s.spawn(big.cfg);
  for (const id of ['r1', 'r2']) {
    big.s.writeTurn([id]);
    big.children[0].emit(result(1));
  }
  assert.deepEqual(big.event('error').map((l) => l.message.replace(big.root, '<root>')), [`meter: <root>/.forge/runtime/meter/${big.scope}.jsonl is over 64 MiB; this job's budget checks fall back to its reported spend`]);
  assert.equal(big.s.wanted, true);
});

/** Makes a scope's meter file one byte over the reader's 64 MiB cap (sparse, so nothing is written). */
function oversize(root: string, scope: string): void {
  const file = meterFile(root, scope);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  fs.truncateSync(file, 64 * 1024 * 1024 + 1);
}

test("metered spend past the job's limit parks the job and stops its session", async (t) => {
  const r = rig(t, 'job', { budget: { usd: 2 } });
  assert.equal(r.s.spawn(r.cfg), true);
  const c = r.children[0];
  r.s.writeTurn(['r1']);
  c.emit(result(2.5));
  const job = loadJob(r.root, r.scope);
  assert.deepEqual([job.state, job.waitingOn], ['waiting', 'budget'], 'parked with no reported usage');
  assert.equal(job.usage.estCostUsd ?? 0, 0);
  assert.equal(job.budget.lastCheck?.used.usd, 2.5);
  assert.deepEqual(readEvents(r.root, r.scope).filter((e) => e.type === 'budget').map((e) => e.checkpoint), ['session-meter']);
  assert.deepEqual(c.signals, ['SIGTERM']);
  assert.equal(r.s.wanted, true, 'still wanted: its held requests start it once a person clears the budget');
  assert.match(r.s.lastError ?? '', /metered spend is over its budget/);
  await waitFor(() => !r.s.running, { what: 'the parked session stopped' });
  assert.equal(r.event('stop').at(-1)?.reason, 'budget');
  assert.equal(heldByBudget(r.root, r.cfg, { type: 'resume', job: r.scope }), true, 'its resume is held on the metered figure');
});

test('the office and inbox stop at their daily cap', async (t) => {
  const office = rig(t, OFFICE_SCOPE, { daemon: { dailyUsd: { office: 1, inbox: null } } });
  assert.equal(office.s.spawn(office.cfg), true);
  const c = office.children[0];
  office.s.writeTurn(['r1']);
  c.emit(result(0.6));
  assert.equal(office.s.wanted, true, 'under the cap');
  office.s.writeTurn(['r2']);
  c.emit(result(1.2));
  assert.equal(office.s.wanted, false);
  assert.deepEqual(c.signals, ['SIGTERM']);
  assert.match(office.s.lastError ?? '', /daily cap \(daemon\.dailyUsd\.office\)/);
  assert.deepEqual(office.notified.map(([, events, ctx]) => [events, (ctx as { reason: string }).reason]), [[['daemon-stopped'], 'daily-cap']]);
  await waitFor(() => !office.s.running, { what: 'the capped office stopped' });

  office.s.reset();
  assert.equal(office.s.spawn(office.cfg), false, 'refused the same UTC day');
  assert.equal(office.children.length, 1, 'no child');
  assert.equal(office.s.wanted, false);
  assert.match(office.s.lastError ?? '', /daily cap \(daemon\.dailyUsd\.office\)/);

  const inbox = rig(t, INBOX_SCOPE, { daemon: { dailyUsd: { office: 1, inbox: null } } });
  inbox.s.spawn(inbox.cfg);
  inbox.s.writeTurn(['r1']);
  inbox.children[0].emit(result(5.5));
  assert.equal(inbox.s.wanted, true, 'no inbox cap');
  assert.deepEqual(inbox.children[0].signals, []);
});

test("a capped session whose meter can't be read stops: the cap check fails closed", async (t) => {
  // An oversized meter refuses the start.
  const office = rig(t, OFFICE_SCOPE, { daemon: { dailyUsd: { office: 60, inbox: 25 } } });
  oversize(office.root, OFFICE_SCOPE);
  const file = meterFile(office.root, OFFICE_SCOPE);
  assert.equal(office.s.spawn(office.cfg), false);
  assert.equal(office.children.length, 0, 'no child');
  assert.equal(office.s.wanted, false);
  assert.equal(office.s.lastError, `meter: ${file} is over 64 MiB, so the office session's daily cap (daemon.dailyUsd.office) can't be checked and it stops; fix or move the file aside, then start it again`);

  // A meter path planted mid-session stops it at the next result, with no daily-cap notification.
  const inbox = rig(t, INBOX_SCOPE, { daemon: { dailyUsd: { office: 60, inbox: 25 } } });
  assert.equal(inbox.s.spawn(inbox.cfg), true);
  const meterDir = path.dirname(meterFile(inbox.root, INBOX_SCOPE));
  fs.mkdirSync(path.dirname(meterDir), { recursive: true });
  fs.writeFileSync(meterDir, '');
  inbox.s.writeTurn(['r1']);
  inbox.children[0].emit(result(0.5));
  assert.equal(inbox.s.wanted, false);
  assert.deepEqual(inbox.children[0].signals, ['SIGTERM']);
  assert.match(inbox.s.lastError ?? '', /^meter: .*meter is not a directory, so the inbox session's daily cap \(daemon\.dailyUsd\.inbox\) can't be checked/);
  assert.deepEqual(inbox.notified, []);
  await waitFor(() => !inbox.s.running, { what: 'the inbox stopped' });

  // A cap check that throws after a result (here reading the cap, once) stops it too.
  const thrown = rig(t, OFFICE_SCOPE, { daemon: { dailyUsd: { office: 60, inbox: 25 } } });
  assert.equal(thrown.s.spawn(thrown.cfg), true);
  thrown.s.writeTurn(['r1']);
  const daemon = thrown.cfg.daemon;
  const caps = daemon.dailyUsd;
  Object.defineProperty(daemon, 'dailyUsd', {
    configurable: true,
    get() {
      Object.defineProperty(daemon, 'dailyUsd', { value: caps, configurable: true, enumerable: true, writable: true });
      throw new Error('cap read failed');
    },
  });
  thrown.children[0].emit(result(0.5));
  assert.deepEqual(metered(thrown.root, OFFICE_SCOPE), [0.5], 'the record is written first');
  assert.equal(thrown.s.wanted, false);
  assert.deepEqual(thrown.children[0].signals, ['SIGTERM']);
  assert.equal(thrown.s.lastError, "meter: cap read failed, so the office session's daily cap (daemon.dailyUsd.office) can't be checked and it stops; fix the cause, then start it again");
  assert.deepEqual(thrown.notified, []);
  await waitFor(() => !thrown.s.running, { what: 'the office stopped' });
});
