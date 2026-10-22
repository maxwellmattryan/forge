// Epoch fencing: once another session takes a job over, every write fenced with the old epoch is
// refused before it lands (exit 3, stale_epoch), and job.json stays byte-identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, repoTemplate } from './helpers.ts';
import { jobDir } from '../lib/core/job/store.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

const initialised = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false }, worktrees: { root: '../{repo}.wt' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, stdio: 'pipe', env: { ...process.env, FORGE_ROOT: dir } });
});

test('a write with a stale epoch is refused', async () => {
  const repo = initialised();
  const root = repo.dir;
  try {
    const f = async (...args: string[]) => {
      const r = await forgeAsync(root, args);
      assert.equal(r.status, 0, `forge ${args.join(' ')}: ${r.stderr}`);
      return JSON.parse(r.stdout);
    };
    const id = (await f('job', 'new', '--title', 'Fenced', '--session', 'OLD')).id;
    const file = path.join(jobDir(root, id), 'job.json');
    // OLD's lease expires (its process slept, or its clock jumped), and NEW takes the job over.
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(j.lease.epoch, 1);
    j.lease.expiresAt = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
    assert.equal((await f('job', 'claim', id, '--session', 'NEW')).epoch, 2);

    const before = fs.readFileSync(file);
    const stale: string[][] = [
      ['job', 'advance', id, '--session', 'OLD', '--epoch', '1'],
      ['job', 'step', id, '--session', 'OLD', '--epoch', '1'],
      ['job', 'step', id, '--epoch', '1'],
      ['job', 'set', id, '--state', 'running', '--epoch', '1'],
      ['job', 'agent', id, 'start', '--role', 'builder', '--epoch', '1'],
      ['job', 'agent', id, 'end', '--role', 'builder', '--epoch', '1'],
      ['job', 'claim', id, '--session', 'OLD', '--epoch', '1'],
      // The right epoch from the wrong driver is stale too.
      ['job', 'step', id, '--session', 'OLD', '--epoch', '2'],
    ];
    for (const args of stale) {
      const r = await forgeAsync(root, [...args, '--json']);
      assert.equal(r.status, 3, `forge ${args.join(' ')}`);
      const err = JSON.parse(r.stdout).error;
      assert.equal(err.code, 'stale_epoch', `forge ${args.join(' ')}`);
      assert.equal(err.message, `job ${id} was taken over (lease epoch 2, you hold ${args.at(-1)}); stop driving it`);
      assert.ok(fs.readFileSync(file).equals(before), `forge ${args.join(' ')} left job.json byte-identical`);
    }

    // The new driver's fenced writes go through.
    await f('job', 'step', id, '--session', 'NEW', '--epoch', '2');
    await f('job', 'set', id, '--note', 'mine now', '--epoch', '2');
    await f('job', 'agent', id, 'start', '--role', 'builder', '--epoch', '2');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).agents.builder.status, 'running');
    // A bad epoch is a usage error, before anything is read.
    assert.equal((await forgeAsync(root, ['job', 'set', id, '--note', 'x', '--epoch', '-1'])).status, 2);
    assert.equal((await forgeAsync(root, ['job', 'set', id, '--note', 'x', '--epoch', 'two'])).status, 2);
  } finally {
    repo.cleanup();
    fs.rmSync(`${root}.wt`, { recursive: true, force: true });
  }
});
