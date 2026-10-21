import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';

const CHILD = path.resolve(import.meta.dirname, 'fixtures', 'dash-child.ts');

type Started = { proc: ChildProcess; out: { pid: number; wanted: boolean; lastError: string | null } };

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Starts one dash child: `ready` once its pool exists and it waits on `go`, `started` with the state its start printed. */
function dash(root: string, go: string): { ready: Promise<void>; started: Promise<Started> } {
  const ready = deferred<void>();
  const started = deferred<Started>();
  // Either may go unawaited when the child dies first; the awaited one reports it.
  ready.promise.catch(() => {});
  started.promise.catch(() => {});
  const proc = spawn(process.execPath, [CHILD, root, go], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  let err = '';
  proc.stderr!.on('data', (d) => (err += d));
  proc.stdout!.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line === 'ready') ready.resolve();
      else started.resolve({ proc, out: JSON.parse(line) });
    }
  });
  proc.on('exit', (code) => {
    const e = new Error(`dash child exited ${code}: ${err}`);
    ready.reject(e);
    started.reject(e);
  });
  return { ready: ready.promise, started: started.promise };
}

const exited = (p: ChildProcess) => new Promise((r) => (p.exitCode !== null || p.signalCode !== null ? r(null) : p.once('exit', r)));

test('two forge dash starts at once', async () => {
  const repo = tempRepo();
  const procs: ChildProcess[] = [];
  try {
    const go = path.join(repo.dir, 'go');
    const pending = [dash(repo.dir, go), dash(repo.dir, go)];
    // Both children are up and polling before either may start.
    await Promise.all(pending.map((p) => p.ready));
    fs.writeFileSync(go, '');
    const [a, b] = await Promise.all(pending.map((p) => p.started));
    procs.push(a.proc, b.proc);
    const winners = [a, b].filter((x) => x.out.wanted);
    assert.equal(winners.length, 1, JSON.stringify([a.out, b.out]));
    const winner = winners[0];
    const loser = winner === a ? b : a;
    assert.equal(loser.out.lastError, `another forge dash (pid ${winner.out.pid}) owns the daemon`);
    // The winner dies without stopping anything: its lock names a dead pid, which the next start breaks.
    winner.proc.kill('SIGKILL');
    await exited(winner.proc);
    loser.proc.kill('SIGKILL');
    await exited(loser.proc);
    fs.rmSync(go);
    const again = dash(repo.dir, go);
    fs.writeFileSync(go, '');
    const c = await again.started;
    procs.push(c.proc);
    assert.equal(c.out.wanted, true, JSON.stringify(c.out));
    assert.equal(c.out.lastError, null);
  } finally {
    for (const p of procs) p.kill('SIGKILL');
    await Promise.all(procs.map(exited));
    repo.cleanup();
  }
});
