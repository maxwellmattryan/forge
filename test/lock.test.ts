import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitFor } from './helpers.ts';
import { killAndWait, killAndWaitAsync, pidAlive } from '../lib/core/os/process.ts';
import { lockHeld, readLockHolder, tryLock, withLock } from '../lib/core/os/lock.ts';

const CHILD = path.resolve(import.meta.dirname, 'fixtures', 'lock-child.ts');

function scratch(): { dir: string; lock: string; cleanup: () => void } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-lock-')));
  return { dir, lock: path.join(dir, 'the.lock'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A pid that existed and has exited: a holder that is provably dead. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  assert.ok(r.pid);
  return r.pid;
}

const startedAt = () => new Date(Date.now() - process.uptime() * 1000).toISOString();

test('pidAlive is false for pids that are not a real process id', () => {
  // Pid 1 always exists, and its group signal would be kill(-1): every process this user may signal.
  for (const pid of [0, 1, -1, -process.pid, 1.5, Number.NaN, '123', null, undefined]) assert.equal(pidAlive(pid), false, String(pid));
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(deadPid()), false);
});

/** A detached process group, led by a pid that has already exited, whose one member ignores SIGTERM. */
async function stubbornGroup(): Promise<number> {
  const child = spawn('sh', ['-c', "trap '' TERM; sleep 60 </dev/null >/dev/null 2>&1 & exit 0"], { detached: true, stdio: 'ignore' });
  assert.ok(child.pid);
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid;
}

test('killAndWait and killAndWaitAsync escalate to SIGKILL for a group that ignores SIGTERM', { skip: process.platform === 'win32' }, async () => {
  for (const kill of [(pid: number) => killAndWait(pid, 200), (pid: number) => killAndWaitAsync(pid, 200)]) {
    const pid = await stubbornGroup();
    assert.equal(pidAlive(pid), true, 'the group outlives its leader');
    try {
      await kill(pid);
      await waitFor(() => !pidAlive(pid), { what: 'the group to die' });
    } finally {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }
  }
  // A pid that is not a real process id is never signalled (pid 1's group is kill(-1)).
  killAndWait(1, 0);
  assert.equal(pidAlive(1), false);
});

function plant(lock: string, holder: Record<string, unknown> | string | null, opts: { mtimeAgoMs?: number; breaking?: boolean } = {}): void {
  fs.mkdirSync(lock, { recursive: true });
  if (holder !== null) fs.writeFileSync(path.join(lock, 'holder.json'), typeof holder === 'string' ? holder : JSON.stringify(holder));
  if (opts.breaking) fs.mkdirSync(path.join(lock, 'breaking'));
  if (opts.mtimeAgoMs) {
    const t = new Date(Date.now() - opts.mtimeAgoMs);
    fs.utimesSync(lock, t, t);
  }
}

const holder = (over: Record<string, unknown> = {}) => ({ v: 1, pid: process.pid, startedAt: startedAt(), host: os.hostname(), token: 'planted-token', ...over });

function child(lock: string, log: string, tag: string, timeoutMs = 20_000, holdMs = 150): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CHILD, lock, log, tag, String(timeoutMs), String(holdMs)], (err, _stdout, stderr) => {
      resolve({ code: err ? ((err as any).code ?? 1) : 0, stderr: String(stderr) });
    });
  });
}

/** Whether `fn` under withLock gets in within timeoutMs. */
function enters(lock: string, timeoutMs = 300): boolean {
  try {
    return withLock(lock, () => true, { timeoutMs });
  } catch (e) {
    assert.match((e as Error).message, /timed out waiting for lock/);
    return false;
  }
}

describe('the lock proves death', { concurrency: 4 }, () => {
  test('two waiters on a stale lock: one holder', async () => {
    const s = scratch();
    try {
      plant(s.lock, holder({ pid: deadPid(), token: 'dead-holder' }));
      const log = path.join(s.dir, 'log');
      const results = await Promise.all(['a', 'b', 'c', 'd'].map((tag) => child(s.lock, log, tag)));
      for (const r of results) assert.equal(r.code, 0, r.stderr);
      const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
      assert.equal(lines.length, 8);
      // Inside the critical section at most one at a time: every enter is followed by its own exit.
      for (let i = 0; i < lines.length; i += 2) {
        const [kind, tag] = lines[i].split(' ');
        assert.equal(kind, 'enter');
        assert.equal(lines[i + 1], `exit ${tag}`);
      }
      assert.deepEqual(lines.filter((l) => l.startsWith('enter')).map((l) => l.slice(6)).sort(), ['a', 'b', 'c', 'd']);
      assert.equal(fs.existsSync(s.lock), false, 'the last holder released it');
    } finally {
      s.cleanup();
    }
  });

  test('a section longer than the old 60 s limit keeps its lock', async () => {
    const s = scratch();
    try {
      const held = tryLock(s.lock);
      assert.ok('release' in held);
      const t = new Date(Date.now() - 10 * 60_000);
      fs.utimesSync(s.lock, t, t);
      const log = path.join(s.dir, 'log');
      const r = await child(s.lock, log, 'late', 500);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /timed out waiting for lock .*\(held by pid \d+\)/);
      assert.equal(fs.existsSync(log), false, 'the waiter never entered');
      held.release();
      assert.equal(fs.existsSync(s.lock), false);
    } finally {
      s.cleanup();
    }
  });

  test('death proof cases', () => {
    const s = scratch();
    let n = 0;
    const fresh = () => path.join(s.dir, `lock-${n++}`);
    try {
      // Never broken: a live holder whose start time matches.
      let lock = fresh();
      plant(lock, holder(), { mtimeAgoMs: 3_600_000 });
      assert.equal(enters(lock), false, 'live holder');
      // Never broken: a holder on another host, even with a dead pid.
      lock = fresh();
      plant(lock, holder({ pid: deadPid(), host: 'another-host.invalid' }));
      assert.equal(enters(lock), false, 'another host');
      // Never broken: someone else is mid-break.
      lock = fresh();
      plant(lock, holder({ pid: deadPid() }), { breaking: true });
      assert.equal(enters(lock), false, 'breaking marker');
      // Broken: a dead holder.
      lock = fresh();
      plant(lock, holder({ pid: deadPid() }));
      assert.equal(enters(lock), true, 'dead pid');
      if (process.platform !== 'win32') {
        // Broken: a live pid that started an hour from the recorded time was reused.
        lock = fresh();
        plant(lock, holder({ startedAt: new Date(Date.parse(startedAt()) - 3_600_000).toISOString() }));
        assert.equal(enters(lock), true, 'pid reuse');
      }
      // Holder-less (legacy or mid-write): only past 60 s of mtime age.
      lock = fresh();
      plant(lock, null);
      assert.equal(enters(lock), false, 'young holder-less dir');
      lock = fresh();
      plant(lock, null, { mtimeAgoMs: 61_000 });
      assert.equal(enters(lock), true, 'old holder-less dir');
      // A planted garbage holder.json counts as holder-less, never as a faster break.
      lock = fresh();
      plant(lock, '{"v":1,"pid":"x"}');
      assert.equal(enters(lock), false, 'garbage holder, young');
      lock = fresh();
      plant(lock, '{not json', { mtimeAgoMs: 61_000 });
      assert.equal(enters(lock), true, 'garbage holder, old');
    } finally {
      s.cleanup();
    }
  });

  // Synchronous on purpose: the stubbed process.kill is restored before any other test in this file runs.
  test('EPERM is not proof of death', { skip: process.platform === 'win32' && 'POSIX-only' }, () => {
    const s = scratch();
    let n = 0;
    const fresh = () => path.join(s.dir, `lock-${n++}`);
    const realKill = process.kill;
    try {
      // Another uid's process, or one outside this sandbox: it exists, but this process may not signal it.
      process.kill = ((pid: number, sig?: string | number) => {
        if (sig === 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
        return realKill.call(process, pid, sig);
      }) as typeof process.kill;
      let lock = fresh();
      plant(lock, holder({ pid: deadPid() }));
      assert.equal(enters(lock), false, 'a holder we may not signal keeps its lock');
      assert.equal(lockHeld(lock), true);
      lock = fresh();
      plant(lock, holder());
      assert.equal(enters(lock), false, 'a matching start time keeps it too');
      // ps still proves a reused pid.
      lock = fresh();
      plant(lock, holder({ startedAt: new Date(Date.parse(startedAt()) - 3_600_000).toISOString() }));
      assert.equal(enters(lock), true, 'pid reuse');
    } finally {
      process.kill = realKill;
      s.cleanup();
    }
  });

  test('a lock path that is not a directory is never broken through', { skip: process.platform === 'win32' && 'POSIX-only' }, () => {
    const s = scratch();
    try {
      const target = path.join(s.dir, 'target');
      fs.mkdirSync(target);
      const t = new Date(Date.now() - 10 * 60_000);
      fs.utimesSync(target, t, t);
      fs.symlinkSync(target, s.lock);
      assert.equal(enters(s.lock), false, 'an old holder-less target is still not broken');
      assert.equal(lockHeld(s.lock), true);
      assert.deepEqual(fs.readdirSync(target), [], 'nothing was made inside the target');
      assert.equal(fs.lstatSync(s.lock).isSymbolicLink(), true);
    } finally {
      s.cleanup();
    }
  });

  test('lockHeld reads the lock without taking it', () => {
    const s = scratch();
    try {
      assert.equal(lockHeld(s.lock), false, 'no lock');
      const held = tryLock(s.lock);
      assert.ok('release' in held);
      const before = fs.statSync(s.lock).ino;
      assert.equal(lockHeld(s.lock), true, 'a live holder');
      assert.equal(fs.statSync(s.lock).ino, before, 'the probe left the dir alone');
      held.release();
      plant(s.lock, holder({ pid: deadPid() }));
      assert.equal(lockHeld(s.lock), false, 'a dead holder');
      assert.equal(fs.existsSync(s.lock), true, 'and the probe broke nothing');
    } finally {
      s.cleanup();
    }
  });

  test('release only removes its own lock', () => {
    const s = scratch();
    try {
      withLock(s.lock, () => {
        const mine = readLockHolder(s.lock);
        assert.ok(mine);
        assert.equal(mine.pid, process.pid);
        assert.equal(mine.host, os.hostname());
        // Another holder took the dir over (a waiter that judged this one dead).
        fs.writeFileSync(path.join(s.lock, 'holder.json'), JSON.stringify({ ...mine, token: 'someone-else' }));
      });
      assert.equal(fs.existsSync(s.lock), true, 'a dir whose token is not ours stays');
      assert.equal(readLockHolder(s.lock)?.token, 'someone-else');
      fs.rmSync(s.lock, { recursive: true });
      const t = tryLock(s.lock);
      assert.ok('release' in t);
      const other = tryLock(s.lock);
      assert.deepEqual(other, { holder: { pid: process.pid, host: os.hostname() } });
      fs.writeFileSync(path.join(s.lock, 'holder.json'), JSON.stringify({ ...readLockHolder(s.lock), token: 'someone-else' }));
      t.release();
      assert.equal(fs.existsSync(s.lock), true);
    } finally {
      s.cleanup();
    }
  });
});
