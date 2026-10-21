// `forge daemon status|log`: the pool's runtime files from the terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { escapeControls } from '../lib/commands/daemon.ts';
import { defaults } from '../lib/config.ts';
import { createJob, recordAgent, updateJob } from '../lib/jobs.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

function cliIn(dir) {
  return (...args) => {
    try {
      return { ok: true, out: execFileSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, FORGE_ROOT: dir } }) };
    } catch (e) {
      return { ok: false, out: `${e.stdout}${e.stderr}` };
    }
  };
}

test('daemon status and log', async () => {
  const repo = tempRepo();
  const cli = cliIn(repo.dir);
  const dir = path.join(repo.dir, '.forge', 'runtime', 'daemons');
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
    assert.equal(escapeControls('a\u0000b\u001bc\u0085d '), 'a\\u0000b\\u001bc\\u0085d ');
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
    const viaFifo = spawnSync(process.execPath, [BIN, 'daemon', 'log', 'job-fifo'], { cwd: repo.dir, encoding: 'utf8', timeout: 10000, env: { ...process.env, FORGE_ROOT: repo.dir } });
    assert.equal(viaFifo.signal, null, 'did not hang');
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
    follower = spawn(process.execPath, [BIN, 'daemon', 'log', 'job-a', '--lines', '1', '--follow'], { cwd: repo.dir, env: { ...process.env, FORGE_ROOT: repo.dir } });
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
    const waiter = spawn(process.execPath, [BIN, 'daemon', 'log', 'job-new', '--follow'], { cwd: repo.dir, env: { ...process.env, FORGE_ROOT: repo.dir } });
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
  const repo = tempRepo();
  const cli = cliIn(repo.dir);
  const dir = path.join(repo.dir, '.forge', 'runtime', 'daemons');
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
