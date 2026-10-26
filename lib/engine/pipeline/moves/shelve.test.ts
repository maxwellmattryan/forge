// The shelf: shelveJob and unshelveJob, the tracker note, and the guard in setJob that lets only a
// person take a job off the shelf, through the engine and through `forge job …` in-process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, forgeInProcess, jobAt, parkedAt, recordingMoveEffects, repoTemplate, withLease } from '../../../../test/helpers.ts';
import { shelveJob, unshelveJob } from './shelve.ts';
import { useMoveEffects } from './effects.ts';
import { ensureEnvironment } from '../../environment/lifecycle.ts';
import { loadConfig } from '#core/config/load.ts';
import { createJob, jobDir, loadJob, readEvents, recordAgent, setJob, updateJob } from '#core/job/store.ts';
import { listRequests } from '#core/job/requests.ts';
import { ForgeError } from '#core/errors.ts';
import type { Config, HumanGrant, LoadedJob, Tracker } from '#core/types.ts';

const scratch = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, '{}');
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

const ACTOR = { login: 'alice', source: 'env' } as const;
const GRANT: HumanGrant = { channel: 'terminal', actor: ACTOR };

/** A scratch repo, its config, and a cleanup; `fn` gets both. */
async function inRepo(fn: (root: string, config: Config) => Promise<void>): Promise<void> {
  const r = scratch();
  try {
    await fn(r.dir, loadConfig(r.dir).config);
  } finally {
    r.cleanup();
  }
}

const files = (root: string, id: string) => ['job.json', 'events.jsonl'].map((f) => fs.readFileSync(path.join(jobDir(root, id), f), 'utf8'));
const types = (root: string, id: string) => readEvents(root, id).map((e) => e.type);
const where = (j: LoadedJob) => [j.stage, j.state, j.waitingOn, j.reason];

test('shelving takes the job off the board and records where it was', async () => {
  const rows: { name: string; make: (root: string) => LoadedJob; env?: boolean }[] = [
    { name: 'waiting at escalation, with an environment', make: (root) => parkedAt(root, 'escalation', { reason: 'touches billing' }), env: true },
    { name: 'queued', make: (root) => jobAt(root, 'build', { state: 'queued' }) },
    { name: 'failed', make: (root) => jobAt(root, 'verify', { state: 'failed', reason: 'verify failed twice' }) },
    { name: 'blocked', make: (root) => jobAt(root, 'build', { state: 'blocked', reason: 'waits on a vendor' }) },
  ];
  for (const row of rows) {
    await inRepo(async (root, config) => {
      const before = row.make(root);
      withLease(root, before.id, 'sess-1');
      if (row.env) ensureEnvironment(root, config, before, 'cli');
      const r = await shelveJob(root, config, before.id, { reason: 'waiting on the billing owner', actor: ACTOR });
      const after = loadJob(root, before.id);
      assert.deepEqual(where(after), [before.stage, 'waiting', 'shelved', 'shelved: waiting on the billing owner'], row.name);
      const from = { state: before.state, waitingOn: before.state === 'waiting' ? before.waitingOn : null, reason: before.reason };
      assert.deepEqual(after.shelved, { at: after.shelved?.at, reason: 'waiting on the billing owner', actor: ACTOR, from }, row.name);
      assert.deepEqual(r.shelved, after.shelved, `${row.name}: the output carries the record`);
      assert.equal(after.lease.driver, null, `${row.name}: nobody drives it`);
      const events = readEvents(root, before.id);
      assert.ok(events.some((e) => e.type === 'released'), `${row.name}: released`);
      const shelved = events.find((e) => e.type === 'shelved');
      assert.deepEqual([shelved?.reason, shelved?.from, shelved?.actor], ['waiting on the billing owner', { stage: before.stage, state: before.state, waitingOn: before.waitingOn }, ACTOR], row.name);
      const stop = events.find((e) => e.type === 'environment-stop');
      assert.equal(stop?.trigger, row.env ? 'park' : undefined, `${row.name}: environment stopped only when it had one`);
      assert.equal(r.environment !== null, Boolean(row.env), row.name);
      assert.deepEqual(listRequests(root), [], `${row.name}: no gate request`);
    });
  }
});

test('shelve refuses and writes nothing', async () => {
  const shelve = (root: string, config: Config, id: string, reason = 'later') => shelveJob(root, config, id, { reason, actor: ACTOR });
  const daemon = (id: string) => ({ FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: id });
  const rows: { name: string; make: (root: string, config: Config) => LoadedJob; run: (root: string, config: Config, id: string) => Promise<unknown>; code: string; message: RegExp }[] = [
    { name: 'a done job', make: (root) => jobAt(root, 'done'), run: shelve, code: 'failed', message: /is done; only an active job is shelved/ },
    { name: 'a cancelled job', make: (root) => jobAt(root, 'build', { state: 'cancelled' }), run: shelve, code: 'failed', message: /is cancelled/ },
    { name: 'a running job', make: (root) => jobAt(root, 'build'), run: shelve, code: 'failed', message: /shelve it once it waits at a gate, or cancel it/ },
    {
      name: 'a waiting job with an agent running',
      make: (root, config) => {
        const j = parkedAt(root, 'escalation');
        recordAgent(root, j.id, { role: 'builder', phase: 'start' }, config);
        return loadJob(root, j.id);
      },
      run: shelve,
      code: 'failed',
      message: /has an agent running/,
    },
    { name: 'an eval job', make: (root, config) => createJob(root, config, { title: 'eval', kind: 'eval' }), run: shelve, code: 'failed', message: /eval job/ },
    { name: 'a shelved job', make: (root) => parkedAt(root, 'shelved'), run: shelve, code: 'failed', message: /already shelved/ },
    { name: 'a reason empty after cleaning', make: (root) => parkedAt(root, 'escalation'), run: (root, config, id) => shelve(root, config, id, ' ``\u0007 '), code: 'usage', message: /needs --reason/ },
  ];
  for (const row of rows) {
    await inRepo(async (root, config) => {
      const id = row.make(root, config).id;
      const before = files(root, id);
      await assert.rejects(row.run(root, config, id), (e: unknown) => {
        assert.ok(e instanceof ForgeError, row.name);
        assert.equal(e.code, row.code, row.name);
        assert.match(e.message, row.message, row.name);
        return true;
      });
      assert.deepEqual(files(root, id), before, `${row.name}: job.json and events.jsonl unchanged`);
    });
  }
  const cli: { name: string; args: (id: string) => string[]; env: (id: string) => NodeJS.ProcessEnv; exit: number; message: RegExp }[] = [
    { name: 'a daemon session', args: (id) => ['job', 'shelve', id, '--reason', 'later'], env: daemon, exit: 1, message: /never by a daemon session/ },
    { name: 'a reason empty after cleaning', args: (id) => ['job', 'shelve', id, '--reason', '``'], env: () => ({ FORGE_DAEMON: undefined }), exit: 2, message: /usage/ },
  ];
  for (const row of cli) {
    await inRepo(async (root) => {
      const id = parkedAt(root, 'escalation').id;
      const before = files(root, id);
      const r = await forgeInProcess(root, row.args(id), { env: row.env(id) });
      assert.equal(r.status, row.exit, `${row.name}: ${JSON.stringify(r.error)}`);
      assert.match(r.error?.message ?? '', row.message, row.name);
      assert.deepEqual(files(root, id), before, `${row.name}: job.json and events.jsonl unchanged`);
    });
  }
});

test('the tracker note names the reason and a failure never undoes the shelve', async () => {
  const restore = useMoveEffects(recordingMoveEffects());
  try {
    for (const fails of [false, true]) {
      await inRepo(async (root, config) => {
        const issues = [{ tracker: 'local', ref: 'billing', url: null }, { tracker: 'local', ref: 'billing-two', url: null }, { tracker: 'github', ref: 'acme/web#3', url: null }];
        const j = jobAt(root, 'pr', { state: 'waiting', waitingOn: 'pr-review', create: { issues }, pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: true } });
        const pr = loadJob(root, j.id).pr;
        const posts: [string, string][] = [];
        const tracker = { name: 'stub', comment: (_ctx: unknown, ref: string, body: string) => (fails ? (() => { throw new Error('tracker down'); })() : posts.push([ref, body])) } as unknown as Tracker;
        const r = await shelveJob(root, config, j.id, { reason: ' waits on `@owner`\u0007 see https://x.test ', actor: ACTOR, tracker });
        const after = loadJob(root, j.id);
        assert.deepEqual([after.state, after.waitingOn], ['waiting', 'shelved'], 'shelved whatever the tracker did');
        assert.deepEqual(after.pr, pr, 'job.pr unchanged');
        const errors = readEvents(root, j.id).filter((e) => e.type === 'tracker-error');
        if (fails) {
          assert.deepEqual(r.tracker, { posted: [], failed: true });
          assert.equal(errors.length, 2, 'one tracker-error per failed post');
        } else {
          assert.deepEqual(r.tracker, { posted: ['billing', 'billing-two'], failed: false });
          assert.deepEqual(posts.map(([ref]) => ref), ['billing', 'billing-two'], "one note per linked issue of this repo, none to another repo's");
          const body = posts[0][1];
          assert.ok(body.includes('`waits on @owner see https://x.test`'), body);
          assert.ok(!/[\u0000-\u001f]/.test(body), 'no control characters');
          assert.equal(body.split('`').length - 1, 4, 'the only backticks are the two code spans');
          assert.ok(body.includes(`forge job unshelve ${j.id}`), body);
          assert.equal(errors.length, 0);
        }
      });
    }
  } finally {
    restore();
  }
});

test('un-shelving puts the job back where it was and queues no gate', async () => {
  const rows: { name: string; make: (root: string) => LoadedJob }[] = [
    { name: 'waiting on escalation', make: (root) => parkedAt(root, 'escalation', { reason: 'touches billing' }) },
    { name: 'queued', make: (root) => jobAt(root, 'build', { state: 'queued' }) },
    { name: 'failed', make: (root) => jobAt(root, 'verify', { state: 'failed', reason: 'verify failed twice' }) },
  ];
  for (const row of rows) {
    await inRepo(async (root, base) => {
      const config: Config = { ...base, daemon: { ...base.daemon, enabled: true }, foreman: { ...base.foreman, enabled: true, decides: ['escalation'], reserved: [] } };
      const before = row.make(root);
      await shelveJob(root, config, before.id, { reason: 'later', actor: ACTOR });
      const r = await unshelveJob(root, config, before.id, { grant: GRANT });
      const after = loadJob(root, before.id);
      assert.deepEqual(where(after), where(before), row.name);
      assert.equal(after.shelved, null, row.name);
      assert.deepEqual(r, { ok: true, id: before.id, stage: before.stage, state: before.state, waitingOn: before.waitingOn }, row.name);
      const ev = readEvents(root, before.id).find((e) => e.type === 'unshelved');
      assert.deepEqual([ev?.to, ev?.channel, ev?.actor], [{ state: before.state, waitingOn: before.waitingOn }, 'terminal', ACTOR], row.name);
      assert.deepEqual(listRequests(root).filter((q) => q.type === 'gate'), [], `${row.name}: no gate request`);
    });
  }
  await inRepo(async (root, config) => {
    // A hand-edited job.json: on the shelf with no record of where it was.
    const id = parkedAt(root, 'escalation').id;
    updateJob(root, id, (j) => {
      j.waitingOn = 'shelved';
      j.shelved = null;
    });
    await unshelveJob(root, config, id, { grant: GRANT });
    const j = loadJob(root, id);
    assert.deepEqual([j.state, j.waitingOn, j.reason], ['waiting', 'human', 'un-shelved: its earlier park was unreadable']);
  });
});

test('only a person un-shelves', async () => {
  await inRepo(async (root, config) => {
    const id = parkedAt(root, 'shelved').id;
    const shelved = () => assert.deepEqual([loadJob(root, id).waitingOn, types(root, id).includes('unshelved')], ['shelved', false]);
    for (const grant of [undefined, true, {}, { channel: 'terminal' }, { channel: 'terminal', actor: { login: 'x', source: 'root' } }, { channel: 'email', actor: ACTOR }]) {
      await assert.rejects(unshelveJob(root, config, id, { grant: grant as unknown as HumanGrant }), (e: unknown) => e instanceof ForgeError && e.code === 'human_only', JSON.stringify(grant));
      shelved();
    }
    for (const [name, env] of [
      ['a daemon session', { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: id }],
      ['no terminal', { FORGE_DAEMON: undefined }],
    ] as const) {
      const r = await forgeInProcess(root, ['job', 'unshelve', id], { env });
      assert.equal(r.error?.code, 'human_only', `${name}: ${JSON.stringify(r.error)}`);
      shelved();
    }
  });
});

test('a shelved job leaves the shelf only through a person', async () => {
  const human = /is shelved: only a person un-shelves it, with forge job unshelve \S+ in their own terminal or Un-shelve in the dashboard's Shelved list/;
  const rows: { name: string; args: string[]; on: 'shelved' | 'escalation'; code: string; message: RegExp }[] = [
    { name: '--state running', args: ['--state', 'running'], on: 'shelved', code: 'human_only', message: human },
    { name: '--state queued', args: ['--state', 'queued'], on: 'shelved', code: 'human_only', message: human },
    { name: '--state failed', args: ['--state', 'failed'], on: 'shelved', code: 'human_only', message: human },
    { name: '--state waiting --waiting-on escalation', args: ['--state', 'waiting', '--waiting-on', 'escalation'], on: 'shelved', code: 'human_only', message: human },
    { name: '--stage build', args: ['--stage', 'build'], on: 'shelved', code: 'human_only', message: human },
    { name: '--field shelved=null', args: ['--field', 'shelved=null'], on: 'shelved', code: 'failed', message: /^--field shelved is not settable; use forge job shelve\|unshelve$/ },
    { name: 'a forged shelf', args: ['--state', 'waiting', '--waiting-on', 'shelved'], on: 'escalation', code: 'failed', message: /^only forge job shelve shelves a job$/ },
  ];
  for (const row of rows) {
    await inRepo(async (root) => {
      const id = parkedAt(root, row.on).id;
      const before = files(root, id);
      const r = await forgeInProcess(root, ['job', 'set', id, ...row.args], { env: { FORGE_DAEMON: undefined } });
      assert.equal(r.error?.code, row.code, `${row.name}: ${JSON.stringify(r.error)}`);
      assert.match(r.error?.message ?? '', row.message, row.name);
      assert.deepEqual(files(root, id), before, `${row.name}: job.json unchanged`);
    });
  }
  await inRepo(async (root) => {
    const id = parkedAt(root, 'shelved').id;
    const r = await forgeInProcess(root, ['job', 'set', id, '--state', 'cancelled'], { env: { FORGE_DAEMON: undefined } });
    assert.equal(r.status, 0, JSON.stringify(r.error));
    const j = loadJob(root, id);
    assert.deepEqual([j.state, j.waitingOn, j.shelved], ['cancelled', null, null]);
    // setJob alone, as any module would write: the same guard.
    const other = parkedAt(root, 'shelved').id;
    assert.throws(() => setJob(root, other, { state: 'running' }), (e: unknown) => e instanceof ForgeError && e.code === 'human_only');
  });
});
