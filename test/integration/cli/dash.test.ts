// `forge dash` and `forge daemon status` trust .forge/runtime/dashboard.json only when it names a
// live process with `forge` in the script position, then `dash`, that started when the record says,
// at a loopback url: a planted record never gets a process signalled or its url shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { forgeAsync, tempRepo, waitFor } from '../../helpers.ts';
import { CONFIG_SCHEMA_VERSION } from '#core/job/schema.ts';
import { processStartMs } from '#core/os/process.ts';
import { writeJsonAtomic } from '#core/os/fs.ts';
import { dashboardRecordFile } from '#engine/ops/dashboard-record.ts';

const HOUR_MS = 3_600_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const json = (stdout: string) => JSON.parse(stdout);

type Argv = 'foreign' | 'wordsAfterE' | 'script';

/**
 * A live process whose command line is: `foreign`, a plain `node -e` loop; `wordsAfterE`, the same
 * with `<dir>/bin/forge dash` after the script (node ignores them, so they only change what ps
 * shows, outside the script position); `script`, `node <dir>/bin/forge dash` running a stub that
 * idles, so `forge` sits in the script position.
 */
function spawnIdle(dir: string, argv: Argv): ChildProcess {
  const bin = path.join(dir, 'bin', 'forge');
  if (argv === 'script') {
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, 'setInterval(() => {}, 1e3);\n');
    return spawn(process.execPath, [bin, 'dash'], { stdio: 'ignore' });
  }
  return spawn(process.execPath, ['-e', 'setInterval(()=>{},1e3)', ...(argv === 'wordsAfterE' ? [bin, 'dash'] : [])], { stdio: 'ignore' });
}

function setupRepo(): ReturnType<typeof tempRepo> {
  const repo = tempRepo();
  fs.mkdirSync(path.join(repo.dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), `schemaVersion: ${CONFIG_SCHEMA_VERSION}\ndaemon:\n  enabled: false\n`);
  return repo;
}

test('dash --stop signals only a proven dashboard', async () => {
  type Row = { name: string; argv: Argv; url: string; startOffsetMs: number; proven: boolean; skip?: boolean };
  const rows: Row[] = [
    { name: 'foreign process, matching start', argv: 'foreign', url: 'http://127.0.0.1:7999', startOffsetMs: 0, proven: false },
    { name: 'foreign process, start 1 h off', argv: 'foreign', url: 'http://127.0.0.1:7999', startOffsetMs: -HOUR_MS, proven: false },
    { name: 'forge dash words after -e', argv: 'wordsAfterE', url: 'http://127.0.0.1:7999', startOffsetMs: 0, proven: false },
    { name: 'forge dash argv, non-loopback url', argv: 'script', url: 'http://evil.example/', startOffsetMs: 0, proven: false },
    // Native Windows has no start-time probe, so no record is ever proven there.
    { name: 'proven dashboard', argv: 'script', url: 'http://127.0.0.1:7999', startOffsetMs: 0, proven: true, skip: process.platform === 'win32' },
  ];
  const children: ChildProcess[] = [];
  const repos: ReturnType<typeof tempRepo>[] = [];
  try {
    for (const row of rows) {
      if (row.skip) continue;
      const repo = setupRepo();
      repos.push(repo);
      const child = spawnIdle(repo.dir, row.argv);
      children.push(child);
      const pid = child.pid!;
      const startedAt = new Date((processStartMs(pid) ?? Date.now()) + row.startOffsetMs).toISOString();
      const file = dashboardRecordFile(repo.dir);
      writeJsonAtomic(file, { pid, url: row.url, startedAt });

      const status = await forgeAsync(repo.dir, ['daemon', 'status', '--json']);
      assert.equal(status.status, 0, `${row.name}: ${status.stderr}`);
      assert.deepEqual(json(status.stdout).dashboard, row.proven ? { pid, url: row.url, alive: true } : { pid, url: null, alive: false }, `${row.name}: daemon status`);
      assert.ok(!status.stdout.includes('evil.example'), `${row.name}: a stale url is never printed`);

      if (row.proven) {
        const running = await forgeAsync(repo.dir, ['dash', '--json']);
        assert.equal(running.status, 0, `${row.name}: ${running.stderr}`);
        assert.deepEqual(json(running.stdout), { url: row.url, pid, running: true }, `${row.name}: dash reports the running one`);
      }

      const stop = await forgeAsync(repo.dir, ['dash', '--stop', '--json']);
      assert.equal(stop.status, 0, `${row.name}: ${stop.stderr}`);
      assert.deepEqual(json(stop.stdout), { stopped: row.proven, daemonReaped: false }, `${row.name}: dash --stop`);
      assert.equal(alive(pid), !row.proven, `${row.name}: ${row.proven ? 'the dashboard exited' : 'the process was not signalled'}`);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {}, `${row.name}: the record is cleared`);
    }
  } finally {
    for (const c of children) c.kill('SIGKILL');
    for (const r of repos) r.cleanup();
  }
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// Native Windows proves no record, so --stop could never stop the child there.
test('a stale record does not block dash --dev, and --stop stops the real background child', { skip: process.platform === 'win32' }, async () => {
  const repo = setupRepo();
  const stale = spawnIdle(repo.dir, 'wordsAfterE');
  const stalePid = stale.pid!;
  let devPid: number | undefined;
  try {
    const file = dashboardRecordFile(repo.dir);
    writeJsonAtomic(file, { pid: stalePid, url: 'http://127.0.0.1:7999', startedAt: new Date(processStartMs(stalePid) ?? Date.now()).toISOString() });

    const port = await freePort();
    const dev = await forgeAsync(repo.dir, ['dash', '--dev', '--background', '--port', String(port), '--json']);
    assert.equal(dev.status, 0, dev.stderr);
    assert.ok(!`${dev.stdout}${dev.stderr}`.includes('already running'), 'a stale record does not refuse --dev');
    const started = json(dev.stdout);
    assert.equal(started.started, true);
    assert.equal(typeof started.pid, 'number');
    assert.notEqual(started.pid, stalePid);
    devPid = started.pid as number;

    await waitFor(() => JSON.parse(fs.readFileSync(file, 'utf8')).pid === devPid, { what: "the dev child's record" });
    const stop = await forgeAsync(repo.dir, ['dash', '--stop', '--json']);
    assert.equal(stop.status, 0, stop.stderr);
    assert.deepEqual(json(stop.stdout), { stopped: true, daemonReaped: false });
    await waitFor(() => !alive(devPid!), { what: 'the dev child to exit' });
    assert.ok(alive(stalePid), 'the stale process was not signalled');
  } finally {
    for (const pid of [devPid, stalePid]) {
      try {
        if (pid) process.kill(pid, 'SIGKILL');
      } catch {}
    }
    repo.cleanup();
  }
});
