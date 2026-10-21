import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';

const CHILD = path.resolve(import.meta.dirname, 'fixtures', 'dash-child.ts');

/** Starts one dash child; resolves with it and the state its start printed. */
function dash(root: string, go: string): Promise<{ proc: ChildProcess; out: { pid: number; wanted: boolean; lastError: string | null } }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [CHILD, root, go], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let err = '';
    proc.stderr!.on('data', (d) => (err += d));
    proc.stdout!.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl !== -1) resolve({ proc, out: JSON.parse(buf.slice(0, nl)) });
    });
    proc.on('exit', (code) => reject(new Error(`dash child exited ${code}: ${err}`)));
  });
}

const exited = (p: ChildProcess) => new Promise((r) => (p.exitCode !== null || p.signalCode !== null ? r(null) : p.once('exit', r)));

test('two forge dash starts at once', async () => {
  const repo = tempRepo();
  const procs: ChildProcess[] = [];
  try {
    const go = path.join(repo.dir, 'go');
    const pending = [dash(repo.dir, go), dash(repo.dir, go)];
    // Both children are up and polling before either may start.
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(go, '');
    const [a, b] = await Promise.all(pending);
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
    const c = await again;
    procs.push(c.proc);
    assert.equal(c.out.wanted, true, JSON.stringify(c.out));
    assert.equal(c.out.lastError, null);
  } finally {
    for (const p of procs) p.kill('SIGKILL');
    await Promise.all(procs.map(exited));
    repo.cleanup();
  }
});
