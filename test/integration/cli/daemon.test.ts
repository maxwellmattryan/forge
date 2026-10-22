// The daemon from the terminal: `forge daemon status|log` over the pool's runtime files, the inbox
// handing a job to its own session and never driving one itself, and `forge dash --foreground|--stop`
// leaving no orphaned claude child. The pool itself is tested in test/integration/pool/daemon.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { BIN, cliEnv, forgeAsync, forgeSync, repoTemplate, waitFor as waitUntil } from '../../helpers.ts';
import { TRUST_ENV, defaults, trustDigest } from '../../../lib/core/config/load.ts';
import { initWrite } from '../../../lib/commands/init.ts';
import { createPool } from '../../../lib/daemon-pool.ts';
import { claimJob, createJob, jobDir, loadJob, recordAgent, updateJob } from '../../../lib/core/job/store.ts';

const FAKE = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'fake-claude.mjs');
// Named claude, because daemon.command must run claude; it runs fake-claude.mjs.
const FAKE_BIN = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'bin', 'claude');
const FAKE_COMMAND = `"${FAKE_BIN}" --plugin-dir {pluginRoot} {session} --allowedTools {allowedTools}`;
const INBOX = '_inbox';
const uuid = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = (cond, ms = 5000, what = 'condition') => waitUntil(cond, { timeoutMs: ms, intervalMs: 10, what });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const daemonsDir = (dir: string) => path.join(dir, '.forge', 'runtime', 'daemons');
const infoOf = (dir: string, scope = INBOX) => JSON.parse(fs.readFileSync(path.join(daemonsDir(dir), `${scope}.json`), 'utf8'));
const logOf = (dir: string, scope = INBOX) => {
  const f = path.join(daemonsDir(dir), `${scope}.log`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};

/** A bare git repo: `forge daemon status|log` read runtime files and need no `forge init`. */
const bareRepo = repoTemplate(() => {});
/** An initialised repo whose worktrees live in the `<dir>.wt` sibling, removed on cleanup. */
const initTemplate = repoTemplate((dir) => {
  initWrite(dir, { worktrees: { root: '../{repo}.wt' } }, false);
});
function initRepo() {
  const repo = initTemplate();
  return {
    ...repo,
    cleanup: () => {
      repo.cleanup();
      fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
    },
  };
}
/** A repo initialised with the daemon enabled on fake-claude, for `forge dash`. */
const dashRepo = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false }, daemon: { enabled: true, command: FAKE_COMMAND } }));
  const r = forgeSync(dir, ['init', 'write', '--answers', answers]);
  assert.equal(r.status, 0, r.stderr);
  fs.rmSync(answers);
});

/** `forge` in `dir`: on success its stdout, on failure stdout and stderr together. */
function cliIn(dir: string) {
  return (...args: string[]) => {
    const r = forgeSync(dir, args);
    return r.status === 0 ? { ok: true, out: r.stdout } : { ok: false, out: `${r.stdout}${r.stderr}` };
  };
}

test('daemon status and log', async () => {
  const repo = bareRepo();
  const cli = cliIn(repo.dir);
  const dir = daemonsDir(repo.dir);
  const deadPid = 2 ** 22 + 4321;
  let follower;
  try {
    assert.deepEqual(JSON.parse(cli('daemon', 'status').out), { dashboard: null, sessions: [] });
    fs.mkdirSync(dir, { recursive: true });
    const rec = (pid) => ({ sessionId: '11111111-2222-3333-4444-555555555555', pid, startedAt: '2026-10-13T00:00:00.000Z', lastTurnAt: null, serverPid: null });
    fs.writeFileSync(path.join(dir, 'zeta-job.json'), JSON.stringify(rec(deadPid)));
    fs.writeFileSync(path.join(dir, 'Alpha-job.json'), JSON.stringify(rec(null)));
    fs.writeFileSync(path.join(dir, '_inbox.json'), JSON.stringify(rec(process.pid)));
    fs.writeFileSync(path.join(dir, 'zeta-job.log'), 'x'.repeat(10) + '\n');
    fs.writeFileSync(path.join(repo.dir, '.forge', 'runtime', 'dashboard.json'), JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:7400' }));
    const st = JSON.parse(cli('daemon', 'status').out);
    assert.deepEqual(st.dashboard, { pid: process.pid, url: 'http://127.0.0.1:7400', alive: true });
    assert.deepEqual(st.sessions.map((s) => s.scope), ['_inbox', 'Alpha-job', 'zeta-job'], 'the inbox first, then by scope');
    const [inbox, alpha, zeta] = st.sessions;
    assert.deepEqual(inbox, { scope: '_inbox', job: null, pid: process.pid, alive: true, sessionId: '11111111-2222-3333-4444-555555555555', startedAt: '2026-10-13T00:00:00.000Z', lastTurnAt: null, logBytes: 0, kept: null, agents: [] });
    assert.equal(alpha.job, 'Alpha-job');
    assert.equal(alpha.alive, false);
    assert.equal(zeta.alive, false, 'a dead pid is not alive');
    assert.equal(zeta.logBytes, 11);
    assert.deepEqual([zeta.kept, zeta.agents], [null, []]);

    const log = path.join(dir, 'job-a.log');
    assert.match(cli('daemon', 'log', 'job-a').out, /no session log for job-a/);
    fs.writeFileSync(log, ['{"type":"one"}', '{"type":"two"}', JSON.stringify({ type: 'forge-raw', text: 'esc \u001b[31mred\u001b[0m csi \u009b2J del \u007f' }), ''].join('\n'));
    const last2 = cli('daemon', 'log', 'job-a', '--lines', '2');
    assert.equal(last2.ok, true, last2.out);
    const out = last2.out.trimEnd().split('\n');
    assert.equal(out.length, 2);
    assert.equal(out[0], '{"type":"two"}');
    assert.ok(out[1].includes('\\u001b[31mred') && out[1].includes('\\u009b2J') && out[1].includes('\\u007f'), out[1]);
    assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(last2.out), 'no raw control character reaches the terminal');
    assert.equal(cli('daemon', 'log', 'job-a').out.trimEnd().split('\n').length, 3, 'default: the last 100 lines');
    fs.writeFileSync(path.join(dir, '_inbox.log'), '{"type":"inbox"}\n');
    assert.equal(cli('daemon', 'log', '--inbox').out.trim(), '{"type":"inbox"}');

    for (const bad of ['../x', '--flag', '_inbox', 'a'.repeat(201), 'a/b']) {
      const r = cli('daemon', 'log', bad);
      assert.equal(r.ok, false, bad);
      assert.match(r.out, /invalid job id|usage/, bad);
    }
    // A FIFO or symlink planted as a log is refused, never followed or waited on.
    const fifo = path.join(dir, 'job-fifo.log');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    const viaFifo = forgeSync(repo.dir, ['daemon', 'log', 'job-fifo'], {}, { timeout: 10000 });
    assert.notEqual(viaFifo.status, null, 'did not hang (a timeout kill leaves no status)');
    assert.match(viaFifo.stderr, /cannot read job-fifo\.log/);
    fs.writeFileSync(path.join(repo.dir, 'secret.txt'), 'hunter2\n');
    fs.symlinkSync(path.join(repo.dir, 'secret.txt'), path.join(dir, 'job-link.log'));
    const viaLink = cli('daemon', 'log', 'job-link');
    assert.equal(viaLink.ok, false);
    assert.match(viaLink.out, /symlink/);
    assert.ok(!viaLink.out.includes('hunter2'));
    for (const n of ['0', '5001', 'x', '1.5']) assert.match(cli('daemon', 'log', 'job-a', '--lines', n).out, /--lines must be/, n);
    assert.match(cli('daemon', 'nope').out, /usage: forge daemon/);

    // --follow: the tail, then a line appended after it started.
    follower = spawn(process.execPath, [BIN, 'daemon', 'log', 'job-a', '--lines', '1', '--follow'], { cwd: repo.dir, env: cliEnv(repo.dir) });
    let seen = '';
    follower.stdout.on('data', (d) => (seen += d));
    const until = async (cond, what) => {
      const end = Date.now() + 5000;
      while (Date.now() < end && !cond()) await new Promise((r) => setTimeout(r, 20));
      assert.ok(cond(), `timed out waiting for ${what}: ${JSON.stringify(seen)}`);
    };
    await until(() => seen.includes('forge-raw'), 'the tail');
    assert.ok(!seen.includes('"two"'), 'only the requested tail');
    fs.appendFileSync(log, '{"type":"appended","x":"\u001b"}\n');
    await until(() => seen.includes('appended'), 'the appended line');
    assert.ok(seen.includes('\\u001b'));
    // A rotation (the file shrinks) starts over from the top of the new file.
    fs.renameSync(log, `${log}.1`);
    fs.writeFileSync(log, '{"type":"fresh"}\n');
    await until(() => seen.includes('fresh'), 'the line after rotation');
    // --follow waits for a log that doesn't exist yet.
    const waiter = spawn(process.execPath, [BIN, 'daemon', 'log', 'job-new', '--follow'], { cwd: repo.dir, env: cliEnv(repo.dir) });
    let w = '';
    waiter.stdout.on('data', (d) => (w += d));
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(path.join(dir, 'job-new.log'), '{"type":"born"}\n');
    const end = Date.now() + 5000;
    while (Date.now() < end && !w.includes('born')) await new Promise((r) => setTimeout(r, 20));
    waiter.kill('SIGKILL');
    assert.ok(w.includes('born'), w);
  } finally {
    follower?.kill('SIGKILL');
    repo.cleanup();
  }
});

test('daemon status reports sessions kept by running agents', () => {
  const repo = bareRepo();
  const cli = cliIn(repo.dir);
  const dir = daemonsDir(repo.dir);
  const sid = '11111111-2222-3333-4444-555555555555';
  try {
    fs.mkdirSync(dir, { recursive: true });
    const [live, dead, other] = ['Live', 'Dead', 'Other'].map((t) => createJob(repo.dir, defaults(), { title: t }).id);
    const at = new Date().toISOString();
    for (const [id, owner] of [[live, sid], [dead, sid], [other, '99999999-2222-3333-4444-555555555555']]) {
      updateJob(repo.dir, id, (j) => {
        j.lease = { driver: owner, epoch: 1, since: at, renewedAt: at, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
      });
      recordAgent(repo.dir, id, { role: 'reviewer:code', phase: 'start' }, defaults());
    }
    const rec = (pid) => JSON.stringify({ sessionId: sid, pid, startedAt: at, lastTurnAt: null, serverPid: null });
    fs.writeFileSync(path.join(dir, `${live}.json`), rec(process.pid));
    fs.writeFileSync(path.join(dir, `${dead}.json`), rec(2 ** 22 + 4321));
    fs.writeFileSync(path.join(dir, `${other}.json`), rec(process.pid));
    fs.writeFileSync(path.join(dir, '_inbox.json'), rec(process.pid));
    const by = Object.fromEntries(JSON.parse(cli('daemon', 'status').out).sessions.map((s) => [s.scope, s]));
    assert.deepEqual([by[live].kept, by[live].agents], ['agents', ['reviewer:code']]);
    assert.deepEqual([by[dead].kept, by[dead].agents], [null, []], 'a dead pid');
    assert.deepEqual([by[other].kept, by[other].agents], [null, []], 'another owner');
    assert.deepEqual([by._inbox.kept, by._inbox.agents], [null, []], 'the inbox');
  } finally {
    repo.cleanup();
  }
});

// ---- The inbox and job sessions (formerly daemon-claim.test.ts): the inbox hands a job to its own
// session by releasing the claim, and the inbox scope never drives a pipeline.

/** Writes a session record for `scope` as a running dash would have it. */
function writeRecord(dir: string, scope: string, rec: Record<string, unknown>) {
  fs.mkdirSync(daemonsDir(dir), { recursive: true });
  fs.writeFileSync(path.join(daemonsDir(dir), `${scope}.json`), JSON.stringify({ resumable: true, serverPid: null, argv0: FAKE_BIN, startedAt: new Date().toISOString(), ...rec }));
}

/** `forge` in `dir` with `env` added (an `undefined` value removes the key). */
function scopedCli(dir: string) {
  return (env: NodeJS.ProcessEnv, ...args: string[]) => {
    const r = forgeSync(dir, args, env);
    return r.status === 0
      ? { ok: true, code: 0, out: r.stdout.trim(), json: () => JSON.parse(r.stdout) }
      : { ok: false, code: r.status, out: `${r.stdout}${r.stderr}`, json: () => null };
  };
}

test("the inbox hands a job to the job's own session by releasing its claim", () => {
  const repo = initRepo();
  const root = repo.dir;
  const cli = scopedCli(root);
  try {
    const id = createJob(root, defaults(), { title: 'Handoff' }).id;
    const inboxSid = uuid();
    writeRecord(root, '_inbox', { sessionId: inboxSid, spawnSessionId: inboxSid, pastSessionIds: [], pid: null });
    claimJob(root, id, inboxSid);
    const trust = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(root) };
    const jobSid = uuid();
    // While the inbox's lease is live, nobody else takes the job without --force.
    assert.equal(cli({ ...trust, FORGE_DAEMON_SCOPE: id }, 'job', 'claim', id, '--session', jobSid).code, 3);
    const handoff = cli({ ...trust, FORGE_DAEMON_SCOPE: '_inbox' }, 'requests', 'add', 'resume', '--job', id);
    assert.equal(handoff.json().released, true, handoff.out);
    assert.deepEqual([loadJob(root, id).lease.driver, loadJob(root, id).lease.epoch], [null, 1]);
    const mine = cli({ ...trust, FORGE_DAEMON_SCOPE: id }, 'job', 'claim', id, '--session', jobSid);
    assert.equal(mine.ok, true, mine.out);
    assert.deepEqual([mine.json().lease.driver, mine.json().epoch], [jobSid, 2]);
  } finally {
    repo.cleanup();
  }
});

test('inbox scope refuses to drive a pipeline', () => {
  const repo = initRepo();
  const root = repo.dir;
  const cli = scopedCli(root);
  try {
    const a = createJob(root, defaults(), { title: 'Job A' }).id;
    const b = createJob(root, defaults(), { title: 'Job B' }).id;
    const trust = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(root) };
    const inbox = { ...trust, FORGE_DAEMON_SCOPE: '_inbox' };
    const hint = new RegExp(`the inbox daemon session does not drive jobs; hand ${a} off with \`forge requests add resume --job ${a} --session <your session>\``);

    const wt = cli(inbox, 'worktree', 'create', a);
    assert.equal(wt.code, 1);
    assert.match(wt.out, hint);
    assert.equal(loadJob(root, a).worktree, null);
    assert.equal(fs.existsSync(`${root}.wt`), false);
    const start = cli(inbox, 'job', 'agent', a, 'start', '--role', 'builder');
    assert.equal(start.code, 1);
    assert.match(start.out, hint);
    assert.deepEqual(loadJob(root, a).agents, {});
    // `end` stays allowed, so a stray start can still be closed.
    assert.equal(cli(inbox, 'job', 'agent', a, 'end', '--role', 'builder', '--status', 'failed').ok, true);
    const jobFile = path.join(jobDir(root, a), 'job.json');
    const beforeAdvance = fs.readFileSync(jobFile, 'utf8');
    const adv = cli(inbox, 'job', 'advance', a, '--session', uuid());
    assert.equal(adv.code, 1);
    assert.match(adv.out, hint);
    assert.equal(fs.readFileSync(jobFile, 'utf8'), beforeAdvance);

    const scoped = { ...trust, FORGE_DAEMON_SCOPE: a };
    const made = cli(scoped, 'worktree', 'create', a);
    assert.equal(made.ok, true, made.out);
    assert.ok(fs.existsSync(made.json().path));
    assert.equal(cli(scoped, 'job', 'agent', a, 'start', '--role', 'builder').json().status, 'running');
    const human = { FORGE_DAEMON: undefined, FORGE_DAEMON_SCOPE: undefined };
    assert.equal(cli(human, 'worktree', 'create', b).ok, true);
    assert.equal(cli(human, 'job', 'agent', b, 'start', '--role', 'builder').json().status, 'running');
  } finally {
    repo.cleanup();
  }
});

// ---- `forge dash` (formerly in test/daemon.test.ts).

/** Real fake-claude processes: their pids are read back from the fixture's log and killed in `finally`. */
function fixtureRun(repo: { dir: string }, extraEnv: Record<string, string> = {}) {
  const logFile = path.join(repo.dir, 'fake-claude.jsonl');
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_CLAUDE_LOG: logFile, ...extraEnv };
  const records = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const spawns = () => records().filter((r) => r.argv);
  const killAll = () => {
    for (const r of spawns()) {
      try {
        process.kill(-r.pid, 'SIGKILL');
      } catch {}
      try {
        process.kill(r.pid, 'SIGKILL');
      } catch {}
    }
  };
  return { env, spawns, killAll, daemonLog: (scope = INBOX) => logOf(repo.dir, scope) };
}

function config(daemon = {}) {
  const c = defaults();
  Object.assign(c.daemon, { enabled: true, command: 'claude {session} --plugin-dir {pluginRoot} --allowedTools {allowedTools}', ...daemon });
  return c;
}

test('AC13: stop, dash --stop and crash leave no orphaned child', { skip: process.platform === 'win32' && 'process groups are POSIX-only' }, async () => {
  const repo = dashRepo();
  const runtime = path.join(repo.dir, '.forge', 'runtime');
  const info = () => {
    try {
      return infoOf(repo.dir);
    } catch {
      return {};
    }
  };
  /** @type {number[]} */
  const pids = [];
  const fx = fixtureRun(repo, { FAKE_CLAUDE_IGNORE_TERM: '1' });
  try {
    // stop(): SIGTERM is ignored, so the group is SIGKILLed after graceMs.
    const d = createPool(repo.dir, { env: fx.env, loadConfig: () => ({ config: config({ command: FAKE_COMMAND }) }), pollMs: 3_600_000, graceMs: 300 });
    d.start();
    const pid = d.state().inbox.pid;
    pids.push(pid);
    await waitFor(() => fx.spawns().length === 1, 5000, 'the child to start');
    const t0 = Date.now();
    const s = await d.stop();
    assert.ok(Date.now() - t0 >= 250, 'waited for the grace period before SIGKILL');
    assert.equal(s.inbox.status, 'off');
    assert.equal(s.inbox.running, false);
    assert.equal(s.wanted, false);
    assert.equal(alive(pid), false);
    await d.close();

    // `forge dash --stop` against a foreground dashboard with an enabled daemon.
    const env: NodeJS.ProcessEnv = { ...fx.env, FAKE_CLAUDE_IGNORE_TERM: undefined };
    const startDash = (extraEnv = {}) => {
      const p = spawn(process.execPath, [BIN, 'dash', '--foreground', '--port', '0'], { cwd: repo.dir, env: cliEnv(repo.dir, { ...env, ...extraEnv }), stdio: 'ignore' });
      pids.push(p.pid);
      return p;
    };
    const dashJson = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(runtime, 'dashboard.json'), 'utf8'));
      } catch {
        return {};
      }
    };
    const dash = startDash();
    await waitFor(() => info().pid && info().serverPid === dash.pid && alive(info().pid) && dashJson().pid === dash.pid, 10000, 'the dashboard daemon');
    const child = info().pid;
    pids.push(child);
    // Async, so this process keeps reaping its exited children while --stop polls their pids.
    const stop = await forgeAsync(repo.dir, ['dash', '--stop'], env);
    assert.equal(stop.status, 0, stop.stderr);
    const outp = JSON.parse(stop.stdout);
    assert.equal(outp.stopped, true);
    assert.equal(typeof outp.daemonReaped, 'boolean');
    await waitFor(() => !alive(dash.pid), 5000, 'the server to exit');
    await waitFor(() => !alive(child), 5000, 'the daemon child to exit');

    // A SIGKILLed dashboard leaves a child that ignores EOF; the next supervisor reaps it.
    const dash2 = startDash({ FAKE_CLAUDE_IGNORE_EOF: '1' });
    await waitFor(() => info().serverPid === dash2.pid && info().pid && alive(info().pid), 10000, 'the second dashboard daemon');
    const orphan = info().pid;
    pids.push(orphan);
    process.kill(dash2.pid!, 'SIGKILL');
    await waitFor(() => !alive(dash2.pid), 5000, 'the killed dashboard');
    await sleep(100);
    assert.equal(alive(orphan), true, 'the child outlived its server');
    const d2 = createPool(repo.dir, { loadConfig: () => ({ config: config({ command: FAKE_COMMAND }) }), graceMs: 1000 });
    await waitFor(() => !alive(orphan), 5000, 'the orphan to be reaped');
    await waitFor(() => /"event":"reaped"/.test(fx.daemonLog()), 2000, 'reaped in the inbox log');
    assert.equal(info().pid, null);
    await d2.close();

    // A live foreign server owns the daemon: nothing is reaped or started.
    const server = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    pids.push(server.pid);
    const sid = uuid();
    const owned = spawn(process.execPath, [FAKE, '--session-id', sid], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: fx.env });
    pids.push(owned.pid);
    fs.writeFileSync(path.join(daemonsDir(repo.dir), 'some-job.json'), JSON.stringify({ sessionId: sid, resumable: true, pid: owned.pid, serverPid: server.pid }));
    const d3 = createPool(repo.dir, { env: fx.env, loadConfig: () => ({ config: config({ command: FAKE_COMMAND }) }), graceMs: 300 });
    const s3 = d3.start();
    assert.equal(s3.inbox.running, false);
    assert.equal(s3.wanted, false);
    assert.match(s3.lastError, new RegExp(`another forge dash \\(pid ${server.pid}\\) owns the daemon`));
    assert.equal(alive(owned.pid), true, 'not reaped');
    assert.equal(infoOf(repo.dir, 'some-job').serverPid, server.pid);
    await d3.close();
    assert.equal(infoOf(repo.dir, 'some-job').serverPid, server.pid, 'closing a refused supervisor keeps the owner');
  } finally {
    for (const pid of pids) {
      if (!pid) continue;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    fx.killAll();
    repo.cleanup();
  }
});
