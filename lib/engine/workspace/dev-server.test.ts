// The background log a job's dev server appends to: rotated at retention.logMaxBytes (else past
// 20 MiB), and never opened through a link, a FIFO or a hard link the job's agents planted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { openBackgroundLog } from './dev-server.ts';
import { defaults } from '#core/config/load.ts';
import { createJob, jobDir } from '#core/job/store.ts';
import { ForgeError } from '#core/errors.ts';
import type { Config } from '#core/types.ts';

const MiB = 1024 * 1024;
const POSIX = process.platform !== 'win32';

function scratch() {
  const repo = tempRepo();
  const config = defaults() as Config;
  const id = createJob(repo.dir, config, { title: 'dev log' }).id;
  const logs = path.join(jobDir(repo.dir, id), 'logs');
  return { repo, config, id, logs, log: path.join(logs, 'dev.log') };
}

const withCap = (config: Config, logMaxBytes: number | null): Config => ({ ...config, retention: { ...config.retention, logMaxBytes } });

/** Opens the log, writes `line` through the descriptor, closes it, and returns the file's text. */
function append(s: ReturnType<typeof scratch>, config: Config, line: string): string {
  const { fd, file } = openBackgroundLog(s.repo.dir, config, s.id, 'dev');
  try {
    assert.equal(file, s.log);
    fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
  return fs.readFileSync(s.log, 'utf8');
}

test('openBackgroundLog rotates at the configured cap, else past 20 MiB', () => {
  const s = scratch();
  try {
    // No log yet: the dir and the file are created.
    assert.equal(append(s, s.config, 'first\n'), 'first\n');
    // Under the cap: appended to.
    assert.equal(append(s, withCap(s.config, MiB), 'second\n'), 'first\nsecond\n');

    // One byte under the cap stays; at the cap it is rotated, replacing the older generation.
    fs.writeFileSync(`${s.log}.1`, 'older generation');
    fs.truncateSync(s.log, MiB - 1);
    assert.equal(append(s, withCap(s.config, MiB), 'x').length, MiB);
    assert.equal(fs.readFileSync(`${s.log}.1`, 'utf8'), 'older generation');
    assert.equal(append(s, withCap(s.config, MiB), 'fresh\n'), 'fresh\n');
    assert.equal(fs.statSync(`${s.log}.1`).size, MiB);

    // No cap: 20 MiB stays, 20 MiB + 1 is rotated (sparse files, so nothing large is written).
    fs.truncateSync(s.log, 20 * MiB);
    assert.equal(append(s, withCap(s.config, null), 'y').length, 20 * MiB + 1);
    assert.equal(append(s, withCap(s.config, null), 'new\n'), 'new\n');
    assert.equal(fs.statSync(`${s.log}.1`).size, 20 * MiB + 1);
  } finally {
    s.repo.cleanup();
  }
});

test('openBackgroundLog refuses links, FIFOs and hard links', { skip: !POSIX && 'symlinks, FIFOs and hard links are POSIX-only here' }, () => {
  const s = scratch();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-outside-')));
  const refused = (what: string) => assert.throws(() => openBackgroundLog(s.repo.dir, s.config, s.id, 'dev'), (e: unknown) => e instanceof ForgeError && e.message.includes(s.log), what);
  try {
    fs.mkdirSync(s.logs, { recursive: true });
    const target = path.join(outside, 'target.txt');
    fs.writeFileSync(target, 'untouched');

    fs.symlinkSync(target, s.log);
    refused('a symlinked log');
    assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
    fs.rmSync(s.log);

    fs.linkSync(target, s.log);
    refused('a hard-linked log');
    assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
    fs.rmSync(s.log);

    if (spawnSync('mkfifo', [s.log]).status === 0) {
      // It must throw rather than block: a write-only open of a FIFO with no reader would wait forever.
      refused('a FIFO');
      fs.rmSync(s.log);
    }

    fs.rmSync(s.logs, { recursive: true });
    const elsewhere = path.join(outside, 'logs');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, s.logs);
    refused('a symlinked logs dir');
    assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing is created there');
  } finally {
    s.repo.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
