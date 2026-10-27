// Notifications follow registerNotify's hook, never an import: importing this module registers
// nothing, a registered queue hears each new failure once, and its remover stops it. notify.command
// runs with a configured command's environment and /bin/sh -c, in and out of the daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeInProcess, jobAt, tempRepo } from '../../test/helpers.ts';
import fs from 'node:fs';
import path from 'node:path';
import { LABELS, MANDATE_REASONS, REASONS, buildPayload, contextFor, dashboardUrl, notifyProblems, registerNotify, runCommand, type QueueNotify } from './notify.ts';
import { applyInput, blankMandate } from './mandates/contract.ts';
import { writeMandate } from './mandates/store.ts';
import { CONFIG_SCHEMA_VERSION } from '#core/versions/config.ts';
import { uptimeFile, writeUptime } from '#engine/project/login-service.ts';
import { machineDashboardFile } from '#engine/ops/dashboard-record.ts';
import { addProject } from '#engine/project/machine-index.ts';
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

test('notify.command gets the command environment and /bin/sh -c in both modes', { skip: process.platform === 'win32' }, async () => {
  const repo = tempRepo();
  try {
    const out = path.join(repo.dir, 'notify-env.json');
    const template = `${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.env))' ${JSON.stringify(out)}`;
    // A SHELL that does not exist: the command runs only if /bin/sh is used instead.
    const interactive: NodeJS.ProcessEnv = { PATH: process.env.PATH, SHELL: '/nonexistent/sh', CMDENV_DB_SRC: 'planted-db-value', GH_TOKEN: 'planted-gh-value' };
    const payload = buildPayload('gate', { job: 'j1', title: 'a title', stage: 'build', prUrl: null, reason: 'input' }, 'http://127.0.0.1:7400/#/pipeline');
    // loginShell is ignored here: notify.command always runs -c.
    const config = { secrets: { DB: { env: 'CMDENV_DB_SRC' } }, commandEnv: { inherit: [], loginShell: true } };
    for (const base of [interactive, { ...interactive, FORGE_DAEMON: '1' }]) {
      fs.rmSync(out, { force: true });
      const res = await runCommand(repo.dir, config, template, payload, { env: base });
      assert.deepEqual(res, { ok: true, attempts: 1 }, JSON.stringify(base.FORGE_DAEMON));
      const dump = JSON.parse(fs.readFileSync(out, 'utf8'));
      assert.equal(dump.FORGE_NOTIFY_EVENT, 'gate');
      for (const k of ['CMDENV_DB_SRC', 'GH_TOKEN', 'FORGE_DAEMON']) assert.equal(dump[k], undefined, `${k} is not passed on`);
    }
  } finally {
    repo.cleanup();
  }
});

test('dashboardUrl links only a loopback dashboard origin', () => {
  const repo = tempRepo();
  const registered = tempRepo();
  try {
    const home = path.join(repo.dir, 'home');
    const file = machineDashboardFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    addProject(home, registered.dir, { name: 'web' });
    const rows: [string, string, string | null, { dashboard: { port?: number } }, string][] = [
      ['a registered root, a loopback record', registered.dir, 'http://localhost:7401', { dashboard: {} }, 'http://localhost:7401/?project=web#/pipeline'],
      ['an unregistered root, a loopback record', repo.dir, 'http://localhost:7401', { dashboard: {} }, 'http://localhost:7401/#/pipeline'],
      ['a non-loopback record', repo.dir, 'http://evil.example/', { dashboard: {} }, 'http://127.0.0.1:7400/#/pipeline'],
      ['userinfo that looks loopback', repo.dir, 'http://127.0.0.1:7400@evil.example/', { dashboard: {} }, 'http://127.0.0.1:7400/#/pipeline'],
      ['no record, no port', repo.dir, null, { dashboard: {} }, 'http://127.0.0.1:7400/#/pipeline'],
      ['no record, a configured port', repo.dir, null, { dashboard: { port: 7450 } }, 'http://127.0.0.1:7450/#/pipeline'],
      ['no record, a registered root', registered.dir, null, { dashboard: { port: 7450 } }, 'http://127.0.0.1:7450/?project=web#/pipeline'],
    ];
    for (const [name, root, url, config, want] of rows) {
      fs.rmSync(file, { force: true });
      if (url !== null) fs.writeFileSync(file, JSON.stringify({ pid: 4242, url, startedAt: new Date().toISOString() }));
      assert.equal(dashboardUrl(root, config as never, home), want, name);
    }
  } finally {
    repo.cleanup();
    registered.cleanup();
  }
});

test('a service-restarted notification names only its own project', () => {
  const repos = [tempRepo(), tempRepo(), tempRepo()];
  try {
    const home = path.join(repos[0]!.dir, 'home');
    const [alpha, beta, gamma] = ['alpha', 'beta', 'gamma'].map((name, i) => addProject(home, fs.realpathSync(repos[i]!.dir), { name }).project.path);
    writeUptime(home, {
      restart: {
        at: '2026-10-26T08:00:00.000Z',
        pid: 4242,
        projects: [
          { name: 'alpha', jobs: 2, office: 1, mandates: 1 },
          { name: 'beta', jobs: 1, office: 0, mandates: 2 },
        ],
      },
    });
    const title = (root: string) => contextFor(root!, null, 'service-restarted', home).title;
    assert.equal(title(alpha!), 'alpha resumed: 2 running jobs, 1 Office request, 1 active mandate');
    assert.equal(title(beta!), 'beta resumed: 1 running job, 0 Office requests, 2 active mandates');
    assert.equal(title(gamma!), 'gamma resumed', 'no entry of its own');
    for (const [root, others] of [[alpha!, ['beta', 'gamma']], [beta!, ['alpha', 'gamma']]] as const) for (const o of others) assert.ok(!title(root)!.includes(o), `${root} names ${o}`);
    fs.writeFileSync(uptimeFile(home), '{"v":1,"restart":{"at":"x"');
    assert.equal(title(alpha!), 'alpha resumed', 'a malformed record');
    const payload = buildPayload('service-restarted', contextFor(alpha!, null, 'service-restarted', home), 'http://127.0.0.1:7400/#/pipeline');
    assert.deepEqual([payload.event, payload.job, payload.reason, LABELS['service-restarted']], ['service-restarted', null, REASONS['service-restarted'], 'Forge restarted']);
    assert.equal(contextFor(alpha!, null, 'trust', home).title, null, 'other job-less reasons keep no title');
  } finally {
    for (const r of repos) r.cleanup();
  }
});

test('mandate notifications name the mandate', async () => {
  const repo = tempRepo();
  try {
    for (const e of ['mandate-stalled', 'mandate-budget', 'mandate-closed'] as const) {
      assert.ok(LABELS[e] && REASONS[e], `${e} has a label and a reason`);
      assert.deepEqual(notifyProblems({ notify: { webhooks: [{ url: 'https://hooks.example.com/x', events: [e] }], command: null } }), [], `a webhook on ${e} validates`);
    }
    const home = path.join(repo.dir, 'home');
    writeMandate(repo.dir, () => ({ mandate: applyInput(blankMandate('m1', new Date().toISOString()), { title: 'Ship M1', milestones: ['M1'] }), action: 'new' as const }));
    const ctx = contextFor(repo.dir, null, 'mandate-closed', home, 'm1');
    assert.equal(buildPayload('mandate-closed', ctx, 'http://127.0.0.1:7400/#/pipeline').title, 'Mandate m1: Ship M1');
    assert.equal(contextFor(repo.dir, null, 'mandate-closed', home, 'gone').title, 'Mandate gone', 'an unreadable mandate keeps its id');
    // The quality pause rides the mandate-stalled event with its own reason, which names the mandate too.
    assert.ok(REASONS['mandate-quality'] && MANDATE_REASONS.includes('mandate-quality'));
    assert.equal(contextFor(repo.dir, null, 'mandate-quality', home, 'm1').title, 'Mandate m1: Ship M1');
    fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), `schemaVersion: ${CONFIG_SCHEMA_VERSION}\n`);
    const bad = await forgeInProcess(repo.dir, ['notify', 'send', '--events', 'mandate-closed', '--reason', 'mandate-closed', '--mandate', 'BAD']);
    assert.equal(bad.error?.code, 'usage', JSON.stringify(bad.error));
    const wrongReason = await forgeInProcess(repo.dir, ['notify', 'send', '--events', 'gate', '--reason', 'failed', '--mandate', 'm1']);
    assert.equal(wrongReason.error?.code, 'usage', 'only the mandate reasons take --mandate');
  } finally {
    repo.cleanup();
  }
});
