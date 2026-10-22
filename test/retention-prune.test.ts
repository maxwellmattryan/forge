// `forge job prune`: the dry run writes nothing; a real prune archives old jobs and deletes only
// stale, regular, unowned session logs, with one retention.log line per item.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { forgeAsync } from './helpers.ts';
import { DAY, repo, seedJob, tree } from './retention-fixture.ts';
import { jobDir } from '../lib/core/job/store.ts';

const ACTOR = { FORGE_ACTOR: 'tester' };

/** Writes a daemon file and backdates it `days`. */
function daemonFile(root: string, name: string, text: string, days: number): string {
  const dir = path.join(root, '.forge', 'runtime', 'daemons');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  const t = new Date(Date.now() - days * DAY);
  fs.utimesSync(file, t, t);
  return file;
}

/**
 * A repo with: an old done job and its logs and record, an active job with old logs, an old inbox
 * log, a young log, a log whose record names a live pid, a refused old job (open PR), and planted
 * non-files named *.log (a FIFO, a symlink to an old file outside, a directory).
 */
function scene(root: string, outside: string) {
  const old = seedJob(root, 'Old done', { days: 10 });
  const active = seedJob(root, 'Active', { state: 'running', stage: 'build' });
  const openPr = seedJob(root, 'Open PR', { days: 10, patch: (j) => void (j.pr = { number: 3, url: 'u', state: 'OPEN', isDraft: false, lastSyncedAt: null } as any) });
  seedJob(root, 'Young done', { days: 1 });
  const files = {
    oldLog: daemonFile(root, `${old}.log`, 'a'.repeat(100) + '\n', 9),
    oldLog1: daemonFile(root, `${old}.log.1`, 'b'.repeat(50) + '\n', 12),
    oldRecord: daemonFile(root, `${old}.json`, JSON.stringify({ pid: null, logBase: 51 }), 9),
    activeLog: daemonFile(root, `${active}.log`, 'c\n', 9),
    inboxLog: daemonFile(root, '_inbox.log', 'd'.repeat(10) + '\n', 8),
    inboxRecord: daemonFile(root, '_inbox.json', JSON.stringify({ pid: null }), 8),
    youngLog: daemonFile(root, 'gone-young.log', 'e\n', 1),
    liveLog: daemonFile(root, 'live-one.log', 'f\n', 9),
    liveRecord: daemonFile(root, 'live-one.json', JSON.stringify({ pid: process.pid }), 9),
    badName: daemonFile(root, '-bad.log', 'g\n', 9),
  };
  const dir = path.dirname(files.oldLog);
  if (process.platform !== 'win32') assert.equal(spawnSync('mkfifo', [path.join(dir, 'fifo-one.log')]).status, 0);
  const target = path.join(outside, 'target.log');
  fs.writeFileSync(target, 'keep\n');
  const t = new Date(Date.now() - 20 * DAY);
  fs.utimesSync(target, t, t);
  fs.symlinkSync(target, path.join(dir, 'link-one.log'));
  fs.lutimesSync(path.join(dir, 'link-one.log'), t, t);
  fs.mkdirSync(path.join(dir, 'dir-one.log'));
  return { old, active, openPr, files, dir, target };
}

describe('prune', { concurrency: 4 }, () => {
  test('prune dry-run changes nothing', async () => {
    const r = repo();
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-outside-')));
    try {
      const s = scene(r.dir, outside);
      const before = tree(r.dir);
      const res = await forgeAsync(r.dir, ['job', 'prune', '--older-than', '5', '--dry-run'], ACTOR);
      assert.equal(res.status, 0, res.stderr);
      const out = JSON.parse(res.stdout);
      assert.equal(out.dryRun, true);
      assert.deepEqual(out.jobs.map((j: any) => j.id), [s.old]);
      assert.ok(out.jobs[0].bytes > 0);
      assert.deepEqual(out.refused, [{ id: s.openPr, reason: 'PR #3 still open' }]);
      const rel = (f: string) => path.relative(r.dir, f);
      assert.deepEqual(
        out.logs.map((l: any) => [l.scope, l.file, l.bytes]).sort(),
        [
          [s.old, rel(s.files.oldLog), 101],
          [s.old, rel(s.files.oldLog1), 51],
          ['_inbox', rel(s.files.inboxLog), 11],
        ].sort(),
      );
      assert.equal(out.freedBytes, out.jobs[0].bytes + 101 + 51 + 11);
      assert.deepEqual(tree(r.dir), before, 'byte-identical tree');
      assert.equal(fs.existsSync(path.join(r.dir, '.forge', 'runtime', 'retention.log')), false);
      assert.equal(fs.existsSync(path.join(r.dir, '.forge', 'archive')), false);
      assert.equal((await forgeAsync(r.dir, ['job', 'prune', '--dry-run'], ACTOR)).status, 2, '--older-than is required');
      assert.equal((await forgeAsync(r.dir, ['job', 'prune', '--older-than', '-1'], ACTOR)).status, 2);
    } finally {
      r.cleanup();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('prune deletes only stale logs', async () => {
    const r = repo();
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-outside-')));
    try {
      const s = scene(r.dir, outside);
      const res = await forgeAsync(r.dir, ['job', 'prune', '--older-than', '5'], ACTOR);
      assert.equal(res.status, 0, res.stderr);
      const out = JSON.parse(res.stdout);
      assert.equal(out.dryRun, false);
      assert.deepEqual(out.jobs.map((j: any) => j.id), [s.old]);
      assert.equal(fs.existsSync(jobDir(r.dir, s.old)), false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(r.dir, '.forge', 'archive', `${s.old}.json`), 'utf8')).trigger, 'prune');
      for (const f of [s.files.oldLog, s.files.oldLog1, s.files.inboxLog, s.files.oldRecord]) assert.equal(fs.existsSync(f), false, `${path.basename(f)} deleted`);
      for (const f of [s.files.inboxRecord, s.files.activeLog, s.files.youngLog, s.files.liveLog, s.files.liveRecord, s.files.badName]) assert.ok(fs.existsSync(f), `${path.basename(f)} kept`);
      if (process.platform !== 'win32') assert.ok(fs.lstatSync(path.join(s.dir, 'fifo-one.log')).isFIFO(), 'a FIFO is kept');
      assert.ok(fs.lstatSync(path.join(s.dir, 'link-one.log')).isSymbolicLink(), 'a symlink is kept');
      assert.equal(fs.readFileSync(s.target, 'utf8'), 'keep\n', 'its target is untouched');
      assert.ok(fs.lstatSync(path.join(s.dir, 'dir-one.log')).isDirectory());
      assert.ok(fs.existsSync(jobDir(r.dir, s.openPr)), 'the refused job stays');
      const lines = fs
        .readFileSync(path.join(r.dir, '.forge', 'runtime', 'retention.log'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      assert.deepEqual(
        lines.map((l) => [l.type, l.kind, l.id ?? l.scope, l.trigger]).sort(),
        [
          ['pruned', 'job', s.old, 'prune'],
          ['pruned', 'log', s.old, 'prune'],
          ['pruned', 'log', s.old, 'prune'],
          ['pruned', 'log', '_inbox', 'prune'],
        ].sort(),
      );
      assert.ok(lines.every((l) => !Number.isNaN(Date.parse(l.ts)) && Number.isInteger(l.bytes)));
      assert.deepEqual(lines.filter((l) => l.kind === 'log').map((l) => l.file).sort(), out.logs.map((l: any) => l.file).sort());
      // Nothing left to do: a second prune frees nothing.
      const again = JSON.parse((await forgeAsync(r.dir, ['job', 'prune', '--older-than', '5'], ACTOR)).stdout);
      assert.deepEqual([again.jobs, again.logs, again.freedBytes], [[], [], 0]);
    } finally {
      r.cleanup();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
