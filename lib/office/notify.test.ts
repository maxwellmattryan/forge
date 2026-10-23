// Notifications follow registerNotify's hook, never an import: importing this module registers
// nothing, a registered queue hears each new failure once, and its remover stops it. notify.command
// runs with a configured command's environment and, under the daemon, /bin/sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { jobAt, tempRepo } from '../../test/helpers.ts';
import fs from 'node:fs';
import path from 'node:path';
import { buildPayload, dashboardUrl, registerNotify, runCommand, type QueueNotify } from './notify.ts';
import { token } from '../../test/secret-fixtures.ts';
import { dashboardRecordFile } from '#engine/ops/dashboard-record.ts';
import { setJob } from '#core/job/store.ts';
import { runTransitionHooks } from '#core/job/transitions.ts';
import type { LoadedJob } from '#core/types.ts';

test('notifications follow registerNotify, not imports', () => {
  // Any hook would read the job (transitionEvents reads its kind), so an untouched job means none ran.
  const read: PropertyKey[] = [];
  const watched = new Proxy({ id: 'j1', kind: null } as unknown as LoadedJob, { get: (t, k) => (read.push(k), Reflect.get(t, k)) });
  runTransitionHooks('/nowhere', watched, { stage: 'build', state: 'running', waitingOn: null }, { stage: 'build', state: 'failed', waitingOn: null });
  assert.deepEqual(read, [], 'importing notify.ts registered a hook');

  const repo = tempRepo();
  const calls: { events: readonly string[]; job?: string | null; reason: string }[] = [];
  const queue: QueueNotify = (_root, events, opts) => (calls.push({ events, job: opts.job, reason: opts.reason }), true);
  try {
    const id = jobAt(repo.dir, 'backlog', { title: 'notify me' }).id;
    const remove = registerNotify(queue);
    try {
      setJob(repo.dir, id, { state: 'failed' });
      setJob(repo.dir, id, { state: 'failed' });
      assert.deepEqual(calls, [{ events: ['job-failed'], job: id, reason: 'failed' }]);
    } finally {
      remove();
    }
    setJob(repo.dir, id, { state: 'running' });
    setJob(repo.dir, id, { state: 'failed' });
    assert.equal(calls.length, 1, 'a transition after the remover ran calls nothing');
  } finally {
    repo.cleanup();
  }
});

test('notify.command gets the command environment and /bin/sh under the daemon', { skip: process.platform === 'win32' }, async () => {
  const repo = tempRepo();
  try {
    const out = path.join(repo.dir, 'notify-env.json');
    const template = `${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.env))' ${JSON.stringify(out)}`;
    // A SHELL that does not exist: the command runs only if /bin/sh is used instead.
    const base = { PATH: process.env.PATH, FORGE_DAEMON: '1', SHELL: '/nonexistent/sh', CMDENV_DB_SRC: 'planted-db-value', GH_TOKEN: token.github('notify') };
    const payload = buildPayload('gate', { job: 'j1', title: 'a title', stage: 'build', prUrl: null, reason: 'input' }, 'http://127.0.0.1:7400/#/pipeline');
    const res = await runCommand(repo.dir, { secrets: { DB: { env: 'CMDENV_DB_SRC' } } }, template, payload, { env: base });
    assert.deepEqual(res, { ok: true, attempts: 1 });
    const dump = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(dump.FORGE_NOTIFY_EVENT, 'gate');
    for (const k of ['CMDENV_DB_SRC', 'GH_TOKEN', 'FORGE_DAEMON']) assert.equal(dump[k], undefined, `${k} is not passed on`);
  } finally {
    repo.cleanup();
  }
});

test('dashboardUrl links only a loopback dashboard origin', () => {
  const repo = tempRepo();
  try {
    const file = dashboardRecordFile(repo.dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rows: [string, string | null, { dashboard: { port?: number } }, string][] = [
      ['a loopback record', 'http://localhost:7401', { dashboard: {} }, 'http://localhost:7401/#/pipeline'],
      ['a non-loopback record', 'http://evil.example/', { dashboard: {} }, 'http://127.0.0.1:7400/#/pipeline'],
      ['userinfo that looks loopback', 'http://127.0.0.1:7400@evil.example/', { dashboard: {} }, 'http://127.0.0.1:7400/#/pipeline'],
      ['no record, no port', null, { dashboard: {} }, 'http://127.0.0.1:7400/#/pipeline'],
      ['no record, a configured port', null, { dashboard: { port: 7450 } }, 'http://127.0.0.1:7450/#/pipeline'],
    ];
    for (const [name, url, config, want] of rows) {
      fs.rmSync(file, { force: true });
      if (url !== null) fs.writeFileSync(file, JSON.stringify({ pid: 4242, url, startedAt: new Date().toISOString() }));
      assert.equal(dashboardUrl(repo.dir, config as never), want, name);
    }
  } finally {
    repo.cleanup();
  }
});
