// `forge dash` and `forge daemon status` trust .forge/runtime/dashboard.json only when it names a
// live `forge dash` process that started when the record says, at a loopback url: a planted record
// never gets a process signalled or its url shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { forgeAsync, tempRepo } from '../../helpers.ts';
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

test('dash --stop signals only a proven dashboard', async () => {
  type Row = { name: string; forgeArgv: boolean; url: string; startOffsetMs: number; proven: boolean; skip?: boolean };
  const rows: Row[] = [
    { name: 'foreign process, matching start', forgeArgv: false, url: 'http://127.0.0.1:7999', startOffsetMs: 0, proven: false },
    { name: 'foreign process, start 1 h off', forgeArgv: false, url: 'http://127.0.0.1:7999', startOffsetMs: -HOUR_MS, proven: false },
    { name: 'forge dash argv, non-loopback url', forgeArgv: true, url: 'http://evil.example/', startOffsetMs: 0, proven: false },
    // Native Windows has no start-time probe, so no record is ever proven there.
    { name: 'proven dashboard', forgeArgv: true, url: 'http://127.0.0.1:7999', startOffsetMs: 0, proven: true, skip: process.platform === 'win32' },
  ];
  const children: ChildProcess[] = [];
  const repos: ReturnType<typeof tempRepo>[] = [];
  try {
    for (const row of rows) {
      if (row.skip) continue;
      const repo = tempRepo();
      repos.push(repo);
      fs.mkdirSync(path.join(repo.dir, '.forge'), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), `schemaVersion: ${CONFIG_SCHEMA_VERSION}\ndaemon:\n  enabled: false\n`);
      // Node ignores argv after the -e script, so the extra words only change what ps shows.
      const extra = row.forgeArgv ? [path.join(repo.dir, 'bin', 'forge'), 'dash'] : [];
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e3)', ...extra], { stdio: 'ignore' });
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
