// jobCmd's dispatch table in-process: one handler per documented subcommand, and the group usage error otherwise;
// `job set` refusing the locked budget, componentsFromDiff and componentsUnmatched fields, and `components`
// once forge verify has recomputed it; and the components flags with their deprecated `services` aliases.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { ForgeError } from '#core/errors.ts';
import { createJob, updateJob } from '#core/job/store.ts';
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

/** `fn` with process.stderr.write captured, outside any daemon session; returns its result and what it wrote. */
async function quietly(fn: () => Promise<unknown>): Promise<{ result: any; stderr: string }> {
  const daemon = process.env.FORGE_DAEMON;
  delete process.env.FORGE_DAEMON;
  const write = process.stderr.write;
  let stderr = '';
  process.stderr.write = ((s: string | Uint8Array) => ((stderr += String(s)), true)) as typeof process.stderr.write;
  try {
    return { result: await fn(), stderr };
  } finally {
    process.stderr.write = write;
    if (daemon !== undefined) process.env.FORGE_DAEMON = daemon;
  }
}

test('components flags and their deprecated services aliases', async () => {
  const repo = tempRepo();
  try {
    const config = defaults();
    const read = (id: string) => JSON.parse(fs.readFileSync(path.join(jobDir(repo.dir, id), 'job.json'), 'utf8'));

    const fresh = await quietly(() => jobCmd(repo.dir, config, 'new', [], { title: 'new name', components: 'api' }));
    assert.equal('deprecated' in fresh.result, false);
    assert.equal(fresh.stderr, '');
    assert.deepEqual([read(fresh.result.id).components, read(fresh.result.id).componentsDeclared], [['api'], ['api']]);

    const old = await quietly(() => jobCmd(repo.dir, config, 'new', [], { title: 'old name', services: 'api' }));
    assert.deepEqual(old.result.deprecated, ['--services: use --components']);
    assert.equal(old.stderr, 'forge: warning: --services is deprecated: use --components\n');
    const created = read(old.result.id);
    assert.deepEqual([created.components, created.componentsDeclared, created.componentsFromDiff], [['api'], ['api'], null]);
    assert.equal('services' in created, false);

    const id = createJob(repo.dir, config, { title: 'set' }).id;
    const set = await quietly(() => jobCmd(repo.dir, config, 'set', [id], { field: ['components=["api"]'] }));
    assert.equal('deprecated' in set.result, false);
    assert.deepEqual(read(id).components, ['api']);
    const aliased = await quietly(() => jobCmd(repo.dir, config, 'set', [id], { field: ['services=["web"]'] }));
    assert.deepEqual(aliased.result.deprecated, ['--field services: use --field components']);
    assert.equal(aliased.stderr, 'forge: warning: --field services is deprecated: use --field components\n');
    assert.deepEqual(read(id).components, ['web']);
    assert.equal('services' in read(id), false);

    const clash = (e: unknown, message: string) => {
      assert.ok(e instanceof ForgeError);
      assert.equal(e.code, 'usage');
      assert.equal(e.message, message);
      return true;
    };
    const before = fs.readdirSync(path.join(repo.dir, '.forge', 'jobs')).length;
    await assert.rejects(
      quietly(() => jobCmd(repo.dir, config, 'new', [], { title: 'both', components: 'api', services: 'web' })),
      (e) => clash(e, '--services is a deprecated alias of --components; pass only --components'),
    );
    assert.equal(fs.readdirSync(path.join(repo.dir, '.forge', 'jobs')).length, before, 'no job is created');
    await assert.rejects(
      quietly(() => jobCmd(repo.dir, config, 'set', [id], { field: ['components=["api"]', 'services.0=web'] })),
      (e) => clash(e, '--field services is a deprecated alias of --field components; pass only --field components'),
    );
    assert.deepEqual(read(id).components, ['web']);
  } finally {
    repo.cleanup();
  }
});

test('componentsFromDiff is not settable through job set', async () => {
  const repo = tempRepo();
  try {
    const config = defaults();
    const id = createJob(repo.dir, config, { title: 'recomputed' }).id;
    const file = path.join(jobDir(repo.dir, id), 'job.json');
    const before = fs.readFileSync(file, 'utf8');
    for (const field of ['componentsFromDiff=[]', 'componentsFromDiff.0=api', 'componentsUnmatched=false']) {
      await assert.rejects(quietly(() => jobCmd(repo.dir, config, 'set', [id], { field: [field] })), (e: unknown) => {
        assert.ok(e instanceof ForgeError, `${field}: not a ForgeError`);
        assert.equal(e.message, `--field ${field.split(/[=.]/)[0]} is not settable; use forge verify`, field);
        return true;
      });
      assert.equal(fs.readFileSync(file, 'utf8'), before, `${field}: job.json unchanged`);
    }
  } finally {
    repo.cleanup();
  }
});

test('components is not settable once forge verify has recomputed it', async () => {
  const repo = tempRepo();
  try {
    const config = defaults();
    const id = createJob(repo.dir, config, { title: 'recomputed', components: ['api'] }).id;
    const file = path.join(jobDir(repo.dir, id), 'job.json');
    // Before the first recompute the list is settable, and the old name reaches the same rule.
    await quietly(() => jobCmd(repo.dir, config, 'set', [id], { field: ['components=["web"]'] }));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).components, ['web']);
    updateJob(repo.dir, id, (j) => {
      j.componentsFromDiff = ['api'];
      j.components = ['api'];
    });
    const before = fs.readFileSync(file, 'utf8');
    for (const field of ['components=["web"]', 'components.0=web', 'services=["web"]']) {
      await assert.rejects(quietly(() => jobCmd(repo.dir, config, 'set', [id], { field: [field] })), (e: unknown) => {
        assert.ok(e instanceof ForgeError, `${field}: not a ForgeError`);
        assert.match(e.message, /^--field components is not settable once forge verify has recomputed it from the diff;/, field);
        return true;
      });
      assert.equal(fs.readFileSync(file, 'utf8'), before, `${field}: job.json unchanged`);
    }
    // The spec's estimate stays settable: it is the declared list, not the one Forge acts on.
    await quietly(() => jobCmd(repo.dir, config, 'set', [id], { field: ['componentsDeclared=["web"]'] }));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).componentsDeclared, ['web']);
  } finally {
    repo.cleanup();
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
