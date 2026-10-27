// jobCmd's dispatch table in-process: one handler per documented subcommand, and the group usage error otherwise;
// and `job set` refusing the locked budget field.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { ForgeError } from '#core/errors.ts';
import { createJob } from '#core/job/store.ts';
import { jobDir } from '#core/paths.ts';
import { usageError } from './args.ts';
import { JOB_HANDLERS, jobCmd } from './job.ts';
import { HELP, JOB } from './job/help.ts';

test('every documented job subcommand has one handler', () => {
  // lib/cli/main.ts routes these two itself: their non-zero exits carry data.
  const documented = HELP[0].commands.map((c) => c.command.replace(/^job /, '')).filter((s) => s !== 'advance' && s !== 'agent run');
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

test('the budget field is not settable through job set', async () => {
  const daemon = process.env.FORGE_DAEMON;
  delete process.env.FORGE_DAEMON;
  const repo = tempRepo();
  try {
    const config = defaults();
    const id = createJob(repo.dir, config, { title: 'capped' }).id;
    const file = path.join(jobDir(repo.dir, id), 'job.json');
    const before = fs.readFileSync(file, 'utf8');
    for (const field of ['budget.limits.usd=null', 'budget.ack.usd={}', 'budget={}']) {
      await assert.rejects(jobCmd(repo.dir, config, 'set', [id], { field: [field] }), (e: unknown) => {
        assert.ok(e instanceof ForgeError, `${field}: not a ForgeError`);
        assert.match(e.message, /^--field budget is not settable; /, field);
        return true;
      });
      assert.equal(fs.readFileSync(file, 'utf8'), before, `${field}: job.json unchanged`);
    }
  } finally {
    if (daemon !== undefined) process.env.FORGE_DAEMON = daemon;
    repo.cleanup();
  }
});
