import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { tempRepo } from './helpers.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('background starts are idempotent per command and report whether the port answers (AC1, AC2)', async () => {
  const repo = tempRepo();
  const env = { ...process.env, FORGE_ROOT: repo.dir };
  const f = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const fAsync = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, [BIN, ...args], { cwd: repo.dir, env })).stdout);
  // A random high port range keeps the test off ports real dev servers use.
  const base = 20000 + Math.floor(Math.random() * 20000);
  const answers = path.join(repo.dir, '.answers.json');
  const dev = `"${process.execPath}" -e "require('net').createServer().listen(process.env.PORT)"`;
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false }, ports: { base, span: 10 }, commands: { dev }, worktrees: { root: `../${path.basename(repo.dir)}.wt` } }));
  f('init', 'write', '--answers', answers);
  const id = f('job', 'new', '--title', 'Web', '--ref', 'web').id;
  const started = [];
  try {
    assert.equal(f('worktree', 'create', id).port, base);

    const first = f('run', id, 'dev', '--background');
    started.push(first.pid);
    assert.equal(first.reused, false);
    assert.equal(first.port, base);
    assert.equal(typeof first.listening, 'boolean');
    assert.ok(path.isAbsolute(first.log));
    const second = f('run', id, 'dev', '--background');
    assert.equal(second.pid, first.pid);
    assert.equal(second.reused, true);
    assert.equal(second.log, first.log);

    let up = second;
    for (let i = 0; i < 50 && !up.listening; i++) {
      await sleep(100);
      up = f('run', id, 'dev', '--background');
    }
    assert.equal(up.listening, true, 'the dev server answers on the job port');
    assert.equal(up.pid, first.pid);

    // Killed outside Forge: the stale record is replaced by a new process.
    process.kill(-first.pid, 'SIGKILL');
    for (let i = 0; i < 50 && alive(first.pid); i++) await sleep(100);
    const restarted = f('run', id, 'dev', '--background');
    started.push(restarted.pid);
    assert.equal(restarted.reused, false);
    assert.notEqual(restarted.pid, first.pid);

    assert.deepEqual(f('stop', id).stopped, ['dev']);
    for (let i = 0; i < 50 && alive(restarted.pid); i++) await sleep(100);
    // After a stop the next start spawns; two concurrent starts still spawn only once.
    const both = await Promise.all([fAsync('run', id, 'dev', '--background'), fAsync('run', id, 'dev', '--background')]);
    started.push(...both.map((r) => r.pid));
    assert.equal(both[0].pid, both[1].pid);
    assert.notEqual(both[0].pid, restarted.pid);
    assert.deepEqual(both.map((r) => r.reused).sort(), [false, true]);
  } finally {
    spawnSync(process.execPath, [BIN, 'stop', id], { cwd: repo.dir, env });
    for (const pid of started) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
  }
});
