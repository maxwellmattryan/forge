import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, repoTemplate } from './helpers.ts';
import { hookServer } from './notify-server.ts';
import { listJobs, readEvents } from '../lib/jobs.ts';
import * as yaml from '../lib/yaml.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

const fresh = repoTemplate((dir) => {
  const answers = path.join(dir, '..', `answers-${path.basename(dir)}.json`);
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' } }));
  try {
    execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  } finally {
    fs.rmSync(answers, { force: true });
  }
});

function setNotify(dir: string, notify: unknown): void {
  const cfg = path.join(dir, '.forge', 'config.yml');
  const raw = yaml.parse(fs.readFileSync(cfg, 'utf8'));
  raw.notify = notify;
  fs.writeFileSync(cfg, yaml.stringify(raw));
}

const json = async (dir: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
  const r = await forgeAsync(dir, [...args, '--json'], env);
  let out: any = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {}
  return { status: r.status, out, raw: r };
};

describe('forge notify', { concurrency: 4 }, () => {
  test('notify test reports each target', async () => {
    const repo = fresh();
    const server = await hookServer();
    try {
      setNotify(repo.dir, { webhooks: [{ url: `${server.url}/services/SECRET`, events: ['pr-merged'] }, { url: `${server.url}/slack`, format: 'slack' }], command: 'exit 0' });
      let r = await json(repo.dir, ['notify', 'test']);
      assert.equal(r.status, 0, r.raw.stderr + r.raw.stdout);
      assert.equal(r.out.event, 'gate');
      const host = `127.0.0.1:${server.port}`;
      assert.deepEqual(r.out.results, [
        { target: 'webhook', host, format: 'json', ok: true, status: 200, attempts: 1 },
        { target: 'webhook', host, format: 'slack', ok: true, status: 200, attempts: 1 },
        { target: 'command', ok: true, attempts: 1 },
      ]);
      assert.ok(!r.raw.stdout.includes('SECRET'), 'host only');
      const [sample, slack] = server.hits.map((h) => JSON.parse(h.body));
      assert.deepEqual([sample.event, sample.job, sample.title, sample.reason], ['gate', null, 'Forge test notification', 'Test notification from forge notify test']);
      assert.equal(slack.text, 'Forge Needs you: Forge test notification');
      r = await json(repo.dir, ['notify', 'test', '--event', 'job-failed']);
      assert.equal(r.out.event, 'job-failed');
      assert.equal(JSON.parse(server.hits.filter((h) => h.path === '/services/SECRET').at(-1)!.body).event, 'job-failed');
      // A failing target fails the command.
      server.reply(404);
      r = await json(repo.dir, ['notify', 'test']);
      assert.equal(r.status, 1);
      assert.deepEqual(r.out.results.map((x: any) => [x.ok, x.error ?? null, x.status ?? null]), [[false, 'http', 404], [false, 'http', 404], [true, null, null]]);
      // An unknown event is a usage error listing the events.
      r = await json(repo.dir, ['notify', 'test', '--event', 'nope']);
      assert.equal(r.status, 2);
      assert.equal(r.out.error.code, 'usage');
      assert.match(r.out.error.message, /--event must be one of gate, pr-opened, pr-merged, job-failed, daemon-stopped, budget-exceeded, secret-found/);
      // Nothing recorded anywhere.
      assert.equal(fs.existsSync(path.join(repo.dir, '.forge', 'runtime', 'notify.jsonl')), false);
      for (const j of listJobs(repo.dir)) assert.deepEqual(readEvents(repo.dir, j.id).filter((e) => String(e.type).startsWith('notif')), []);
    } finally {
      await server.close();
      repo.cleanup();
    }
  });

  test('notify test with nothing configured', async () => {
    const repo = fresh();
    try {
      const r = await json(repo.dir, ['notify', 'test']);
      assert.equal(r.status, 1);
      assert.equal(r.out.error.message, 'notify has no webhooks or command; see docs/CONFIG.md "Notifications"');
      const send = await json(repo.dir, ['notify', 'send', '--events', 'gate,nope', '--reason', 'input']);
      assert.equal(send.status, 2, 'send validates its events');
      const reason = await json(repo.dir, ['notify', 'send', '--events', 'gate', '--reason', 'PRIVATE TEXT']);
      assert.equal(reason.status, 2, 'and its reason code');
      const job = await json(repo.dir, ['notify', 'send', '--events', 'gate', '--reason', 'input', '--job', 'nope']);
      assert.equal(job.status, 1, 'and that the job exists');
    } finally {
      repo.cleanup();
    }
  });

  test('doctor notify checks', async () => {
    const repo = fresh();
    const server = await hookServer();
    // A gh that answers nothing, so doctor's release check stays off the network.
    const bin = path.join(repo.dir, '..', `doctorbin-${path.basename(repo.dir)}`);
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    const doctor = async () => {
      const r = await forgeAsync(repo.dir, ['doctor', '--json'], env);
      return JSON.parse(r.stdout).checks.filter((c: any) => c.name.startsWith('notify')) as any[];
    };
    try {
      assert.deepEqual(await doctor(), [], 'no webhooks: no check');
      assert.equal(server.hits.length, 0);
      setNotify(repo.dir, {
        webhooks: [{ url: `${server.url}/services/SECRETPATH?q=SECRETQUERY` }, { url: 'https://127.0.0.1:1/services/SECRETPATH' }, { url: 'http://hooks.example.com/services/SECRETPATH' }],
        command: './page.sh {title}',
      });
      const checks = await doctor();
      const host = `127.0.0.1:${server.port}`;
      assert.deepEqual(checks.map((c) => c.name), [`notify webhook 0 (${host})`, 'notify webhook 1 (127.0.0.1:1)', 'notify webhook 2 (hooks.example.com)', 'notify command']);
      assert.deepEqual([checks[0].ok, checks[0].warn, checks[0].detail], [true, true, 'plain http, loopback only; reachable (HTTP 200)']);
      assert.equal(server.hits[0].method, 'HEAD');
      assert.deepEqual([checks[1].ok, checks[1].warn, checks[1].detail], [true, true, 'unreachable (network)']);
      assert.equal(checks[2].ok, false);
      assert.match(checks[2].detail, /url must be https:/);
      assert.deepEqual([checks[3].ok, checks[3].detail], [true, 'set']);
      const all = JSON.stringify(checks);
      for (const m of ['SECRETPATH', 'SECRETQUERY', 'page.sh']) assert.ok(!all.includes(m), m);
      assert.equal(fs.existsSync(path.join(repo.dir, 'page.sh')), false);
    } finally {
      await server.close();
      fs.rmSync(bin, { recursive: true, force: true });
      repo.cleanup();
    }
  });
});
