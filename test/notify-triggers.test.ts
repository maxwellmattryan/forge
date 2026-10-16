import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, repoTemplate, waitFor } from './helpers.ts';
import { hookServer } from './notify-server.ts';
import type { HookServer } from './notify-server.ts';
import { createJob, loadJob, readEvents, setJob } from '../lib/jobs.ts';
import { loadConfig } from '../lib/config.ts';
import { REASONS, queueNotify } from '../lib/notify.ts';
import { logSecrets } from '../lib/secrets.ts';
import * as yaml from '../lib/yaml.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

const fresh = repoTemplate((dir) => {
  const answers = path.join(dir, '..', `answers-${path.basename(dir)}.json`);
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, verify: ['test'], worktrees: { root: '../{repo}.wt' } }));
  try {
    execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  } finally {
    fs.rmSync(answers, { force: true });
  }
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', 'forge init');
});

/** A scratch repo whose notify block is `notify`, and a local endpoint. */
async function scratch(notify: (server: HookServer) => any) {
  const repo = fresh();
  const server = await hookServer();
  const cfg = path.join(repo.dir, '.forge', 'config.yml');
  const raw = yaml.parse(fs.readFileSync(cfg, 'utf8'));
  raw.notify = notify(server);
  fs.writeFileSync(cfg, yaml.stringify(raw));
  const f = async (...args: string[]) => {
    const r = await forgeAsync(repo.dir, args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}${r.stdout}`);
    return r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : r.stdout.trim();
  };
  const notes = (id: string) => readEvents(repo.dir, id).filter((e) => e.type === 'notified' || e.type === 'notify-failed') as any[];
  const cleanup = async () => {
    await server.close();
    repo.cleanup();
    fs.rmSync(path.join(repo.dir, '..', `${path.basename(repo.dir)}.wt`), { recursive: true, force: true });
  };
  return { repo, server, f, notes, cleanup };
}

const hook = (server: HookServer, extra: Record<string, unknown> = {}) => ({ url: `${server.url}/services/SECRET`, ...extra });
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

describe('notify triggers', { concurrency: 4 }, () => {
  test('gate notifies once per transition', async () => {
    const s = await scratch((server) => ({ webhooks: [hook(server)], command: null }));
    try {
      const j = await s.f('job', 'new', '--title', 'Add login');
      await s.f('job', 'set', j.id, '--stage', 'spec', '--state', 'waiting', '--waiting-on', 'spec-approval', '--reason', 'PRIVATE-REASON');
      await waitFor(() => s.notes(j.id).length === 1, { what: 'the first notified event' });
      const [first] = s.server.posts();
      assert.deepEqual(
        { ...first, at: undefined, dashboardUrl: undefined },
        { event: 'gate', job: j.id, title: 'Add login', stage: 'spec', reason: REASONS['spec-approval'], url: null, at: undefined, dashboardUrl: undefined },
      );
      assert.match(first.dashboardUrl, /^http:\/\/127\.0\.0\.1:\d+\/#\/pipeline$/);
      assert.ok(!JSON.stringify(first).includes('PRIVATE-REASON'));
      const ev = s.notes(j.id)[0];
      assert.deepEqual([ev.type, ev.event, ev.target, ev.host, ev.status, ev.attempts], ['notified', 'gate', 'webhook', `127.0.0.1:${s.server.port}`, 200, 1]);
      // The same set again is no state change.
      await s.f('job', 'set', j.id, '--state', 'waiting', '--waiting-on', 'spec-approval');
      await s.f('job', 'set', j.id, '--state', 'waiting', '--waiting-on', 'input');
      await waitFor(() => s.notes(j.id).length === 2, { what: 'the second notified event' });
      await settle();
      assert.equal(s.server.posts().length, 2, 'exactly one more POST');
      assert.equal(s.server.posts()[1].reason, REASONS.input);
    } finally {
      await s.cleanup();
    }
  });

  test('budget transition picks the most specific event per webhook', async () => {
    const s = await scratch((server) => ({
      webhooks: [hook(server, { url: `${server.url}/both`, events: ['budget-exceeded', 'gate'] }), hook(server, { url: `${server.url}/gate`, events: ['gate'] })],
      command: null,
    }));
    try {
      const j = await s.f('job', 'new', '--title', 'Spendy');
      await s.f('job', 'set', j.id, '--state', 'waiting', '--waiting-on', 'budget');
      await waitFor(() => s.notes(j.id).length === 2, { what: 'two notified events' });
      await settle();
      const byPath = Object.fromEntries(s.server.hits.map((h) => [h.path, JSON.parse(h.body).event]));
      assert.deepEqual(byPath, { '/both': 'budget-exceeded', '/gate': 'gate' });
      assert.equal(s.server.hits.length, 2, 'one message per webhook');
      assert.ok(s.server.posts().every((p) => p.reason === REASONS.budget));
    } finally {
      await s.cleanup();
    }
  });

  test('failed, merged, eval and unconfigured', async () => {
    const s = await scratch((server) => ({ webhooks: [hook(server)], command: null }));
    try {
      const a = await s.f('job', 'new', '--title', 'Breaks');
      await s.f('job', 'set', a.id, '--state', 'failed');
      const b = await s.f('job', 'new', '--title', 'Merges');
      setJob(s.repo.dir, b.id, { fields: { pr: { number: 12, url: 'https://github.com/o/r/pull/12', state: 'OPEN' } } });
      await s.f('job', 'set', b.id, '--stage', 'done', '--state', 'done');
      await waitFor(() => s.notes(a.id).length === 1 && s.notes(b.id).length === 1, { what: 'both notified' });
      const posts = s.server.posts();
      const failed = posts.find((p) => p.job === a.id);
      const merged = posts.find((p) => p.job === b.id);
      assert.deepEqual([failed.event, failed.reason], ['job-failed', REASONS.failed]);
      assert.deepEqual([merged.event, merged.reason, merged.url], ['pr-merged', REASONS['pr-merged'], 'https://github.com/o/r/pull/12']);
      // An eval job never notifies.
      const { config } = loadConfig(s.repo.dir);
      const e = createJob(s.repo.dir, config, { title: 'Eval', kind: 'eval' });
      assert.equal(queueNotify(s.repo.dir, ['job-failed'], { job: e.id, reason: 'failed' }), false);
      setJob(s.repo.dir, e.id, { state: 'failed' });
      await settle();
      assert.equal(s.server.posts().length, 2);
      assert.deepEqual(s.notes(e.id), []);
    } finally {
      await s.cleanup();
    }
    // Default config: no child, no event.
    const u = fresh();
    try {
      const { config } = loadConfig(u.dir);
      assert.deepEqual(config.notify, { webhooks: [], command: null });
      const j = createJob(u.dir, config, { title: 'Quiet' });
      assert.equal(queueNotify(u.dir, ['gate'], { job: j.id, reason: 'input' }), false, 'nothing spawned');
      const r = await forgeAsync(u.dir, ['job', 'set', j.id, '--state', 'failed']);
      assert.equal(r.status, 0, r.stderr);
      await settle(200);
      assert.deepEqual(readEvents(u.dir, j.id).filter((ev) => String(ev.type).startsWith('notif')), []);
      assert.equal(fs.existsSync(path.join(u.dir, '.forge', 'runtime', 'notify.jsonl')), false);
    } finally {
      u.cleanup();
    }
  });

  test('secret-found carries no finding text', async () => {
    const s = await scratch((server) => ({ webhooks: [hook(server)], command: null }));
    try {
      const j = await s.f('job', 'new', '--title', 'Leaky');
      const finding = { kind: 'aws-access-key', path: 'src/LEAKPATH.ts', line: 3, excerpt: 'AKIA…LEAKEXCERPT', fingerprint: 'LEAKFINGERPRINT' };
      logSecrets(s.repo.dir, j.id, 'verify', { findings: [finding as any], allowed: [] }, { blocked: true });
      await waitFor(() => s.notes(j.id).length === 1, { what: 'notified' });
      const [p] = s.server.posts();
      assert.deepEqual([p.event, p.reason], ['secret-found', REASONS['secret-found']]);
      const body = s.server.hits[0].body;
      for (const m of ['LEAKPATH', 'LEAKEXCERPT', 'LEAKFINGERPRINT', 'aws-access-key']) assert.ok(!body.includes(m), m);
      // No findings: nothing.
      logSecrets(s.repo.dir, j.id, 'verify', { findings: [], allowed: [] }, { blocked: true });
      await settle();
      assert.equal(s.server.posts().length, 1);
    } finally {
      await s.cleanup();
    }
  });

  test('a hanging endpoint never stalls the CLI', async () => {
    const s = await scratch((server) => ({ webhooks: [hook(server)], command: null }));
    try {
      s.server.reply('hang');
      const j = await s.f('job', 'new', '--title', 'Patient');
      const t = Date.now();
      const r = await forgeAsync(s.repo.dir, ['job', 'set', j.id, '--state', 'waiting', '--waiting-on', 'input']);
      const took = Date.now() - t;
      assert.equal(r.status, 0, r.stderr);
      assert.ok(took < 2000, `forge job set took ${took} ms`);
      assert.deepEqual([loadJob(s.repo.dir, j.id).state, loadJob(s.repo.dir, j.id).waitingOn], ['waiting', 'input']);
      await waitFor(() => s.server.hits.length >= 1, { what: 'the endpoint was reached' });
    } finally {
      await s.cleanup();
    }
  });

  test('pr open notifies on create only', { skip: process.platform === 'win32' }, async () => {
    const s = await scratch((server) => ({ webhooks: [hook(server, { events: ['pr-opened'] })], command: null }));
    const bin = path.join(s.repo.dir, '..', `notifybin-${path.basename(s.repo.dir)}`);
    const bare = path.join(s.repo.dir, '..', `notifyremote-${path.basename(s.repo.dir)}.git`);
    try {
      fs.mkdirSync(bin);
      // gh: no PR for the branch until one is created; then `pr view` reports it open.
      const state = path.join(bin, 'created');
      fs.writeFileSync(
        path.join(bin, 'gh'),
        `#!/bin/sh
case "$1 $2" in
  "repo view") echo o/r ;;
  "pr list") echo '[]' ;;
  "pr create") : > "${state}"; echo https://github.com/o/r/pull/7 ;;
  "pr view") printf '{"number":7,"url":"https://github.com/o/r/pull/7","state":"OPEN","isDraft":false,"headRefOid":"abc","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":"","statusCheckRollup":[],"mergedAt":null,"closedAt":null,"headRefName":"%s","baseRefName":"main"}' "$NOTIFY_BRANCH" ;;
esac
`,
        { mode: 0o755 },
      );
      execFileSync('git', ['init', '-q', '--bare', bare]);
      git(s.repo.dir, 'remote', 'add', 'origin', bare);
      git(s.repo.dir, 'push', '-q', 'origin', 'main');
      const j = await s.f('job', 'new', '--title', 'Ship it');
      const wt: string = (await s.f('worktree', 'create', j.id)).path;
      await s.f('job', 'round', j.id);
      fs.writeFileSync(path.join(wt, 'a.txt'), 'a\n');
      git(wt, 'add', '-A');
      git(wt, '-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', 'feat: a');
      await s.f('verify', j.id);
      const env = { PATH: `${bin}:${process.env.PATH}`, NOTIFY_BRANCH: loadJob(s.repo.dir, j.id).branch! };
      let r = await forgeAsync(s.repo.dir, ['pr', 'open', j.id], env);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(JSON.parse(r.stdout).created, true);
      await waitFor(() => s.notes(j.id).length === 1, { what: 'pr-opened notified' });
      const [p] = s.server.posts();
      assert.deepEqual([p.event, p.url, p.reason], ['pr-opened', 'https://github.com/o/r/pull/7', REASONS['pr-opened']]);
      // An update of the open PR sends nothing.
      r = await forgeAsync(s.repo.dir, ['pr', 'open', j.id], env);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(JSON.parse(r.stdout).created, false);
      await settle();
      assert.equal(s.server.posts().length, 1);
    } finally {
      await s.cleanup();
      fs.rmSync(bin, { recursive: true, force: true });
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
