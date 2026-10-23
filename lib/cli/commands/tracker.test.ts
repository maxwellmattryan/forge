// trackerCmd in-process under the GitHub tracker: a ref outside this repo is a usage error before gh
// runs. fakeGh goes first on this process's PATH, since the adapter's gh calls pass no env.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeGh } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { ForgeError } from '#core/errors.ts';
import { trackerCmd } from './tracker.ts';

test('tracker verbs take only an issue in this repo', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tracker-cmd-'));
  const fake = fakeGh({ 'issue close': '', 'issue comment': '' });
  const saved = process.env.PATH;
  process.env.PATH = fake.env.PATH;
  try {
    const config = defaults();
    config.tracker.kind = 'github';
    config.tracker.github.repo = 'o/r';
    const usage = (e: unknown) => e instanceof ForgeError && e.code === 'usage' && e.exitCode === 2;
    await assert.rejects(trackerCmd(root, config, 'close', ['https://github.com/other/victim/issues/5'], {}), usage);
    await assert.rejects(trackerCmd(root, config, 'comment', ['--web'], { body: 'x' }), usage);
    assert.deepEqual(fake.calls(), []);
    assert.deepEqual(await trackerCmd(root, config, 'close', ['12'], {}), { ok: true });
    assert.deepEqual(
      fake.calls().map((c) => c.args),
      [['issue', 'close', '-R', 'o/r', '--reason', 'completed', '--', '12']],
    );
  } finally {
    process.env.PATH = saved;
    fs.rmSync(fake.dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
