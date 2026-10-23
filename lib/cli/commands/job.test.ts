// jobCmd's dispatch table in-process: one handler per documented subcommand, and the group usage error otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaults } from '#core/config/load.ts';
import { ForgeError } from '#core/errors.ts';
import { usageError } from './args.ts';
import { JOB_HANDLERS, jobCmd } from './job.ts';
import { HELP, JOB } from './job/help.ts';

test('every documented job subcommand has one handler', () => {
  const documented = HELP[0].commands.map((c) => c.command.replace(/^job /, '')).filter((s) => s !== 'advance');
  assert.deepEqual(Object.keys(JOB_HANDLERS).sort(), [...documented].sort());
});

test('unknown and prototype-named subcommands get the group usage error', async () => {
  // Outside any daemon session, so the office allowlist never answers first, even when the suite runs inside one.
  const daemon = process.env.FORGE_DAEMON;
  delete process.env.FORGE_DAEMON;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-job-cmd-'));
  try {
    const expected = usageError(JOB).message;
    for (const sub of [undefined, 'bogus', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      await assert.rejects(jobCmd(tmp, defaults(), sub, [], {}), (e: unknown) => {
        assert.ok(e instanceof ForgeError, `${sub}: not a ForgeError`);
        assert.equal(e.code, 'usage', String(sub));
        assert.equal(e.message, expected, String(sub));
        return true;
      });
    }
    assert.deepEqual(fs.readdirSync(tmp), []);
  } finally {
    if (daemon !== undefined) process.env.FORGE_DAEMON = daemon;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
