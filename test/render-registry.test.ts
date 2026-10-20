// lib/commands/render/index.ts: the human-mode renderer registry, its key, and that agent mode never changes.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, repoTemplate } from './helpers.ts';
import { dispatch } from '../lib/cli.ts';
import { loadConfig } from '../lib/config.ts';
import { forgeVersion } from '../lib/evals.ts';
import { loadJob } from '../lib/jobs.ts';
import { computeStats } from '../lib/stats.ts';
import { compactJob } from '../lib/commands/job.ts';
import { renderKeyOf, setRenderKey } from '../lib/commands/args.ts';
import { render } from '../lib/commands/render.ts';
import { RENDERERS, renderKey } from '../lib/commands/render/index.ts';
import { doctor } from '../lib/commands/render/doctor.ts';
import { status } from '../lib/commands/render/status.ts';
import { statsText, statusRows, statusTable } from '../lib/commands/status.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

const repo = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'none' }, pr: { enabled: false }, worktrees: { root: '../{repo}.wt' } }));
  const bin = path.join(ROOT, 'bin', 'forge');
  const run = (args: string[]) => execFileSync(process.execPath, [bin, ...args], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  run(['init', 'write', '--answers', answers]);
  run(['job', 'new', '--title', 'Registry job', '--ref', 'reg-job']);
  run(['job', 'set', 'reg-job', '--field', 'state=waiting', '--field', 'waitingOn=spec', '--field', 'reason=spec ready']);
  fs.rmSync(answers);
});

test('renderKey resolves command paths', () => {
  assert.equal(renderKey(['verify', 'j1']), 'verify');
  assert.equal(renderKey(['status']), 'status');
  assert.equal(renderKey(['config']), 'config show');
  assert.equal(renderKey(['config', 'get', 'git.base']), 'config get');
  assert.equal(renderKey(['requests']), 'requests list');
  assert.equal(renderKey(['requests', 'add', 'resume']), undefined);
  assert.equal(renderKey(['job', 'release', 'x']), undefined);
  assert.equal(renderKey(['job', 'show', 'x']), 'job show');
  assert.equal(renderKey(['job']), undefined);
  assert.equal(renderKey(['roster']), undefined);
  assert.equal(renderKey(['constructor']), undefined);
  assert.equal(renderKey([]), undefined);
  for (const key of Object.keys(RENDERERS)) assert.equal(renderKey(key.split(' ')), key, key);
});

test('dispatch never sets the render key', async () => {
  const r = repo();
  const prev = renderKeyOf();
  try {
    setRenderKey('verify');
    const { config, initialized } = loadConfig(r.dir);
    await dispatch(['job', 'list'], { root: r.dir, config, initialized });
    assert.equal(renderKeyOf(), 'verify');
    setRenderKey(undefined);
    await dispatch(['job', 'show', 'reg-job'], { root: r.dir, config, initialized });
    assert.equal(renderKeyOf(), undefined);
  } finally {
    setRenderKey(prev);
    r.cleanup();
  }
});

test('every renderer returns null on a foreign shape, never throws', () => {
  for (const [key, r] of Object.entries(RENDERERS)) {
    // config show and config get outline any object: every key of the config is theirs to print.
    const anyObject = key === 'config show' || key === 'config get';
    for (const foreign of [null, undefined, 42, 'text', true, ...(anyObject ? [] : [{ nope: 1 }]), [1, 2], [{ nope: 1 }]]) {
      assert.equal(r(foreign, { color: false, now: 0 }), null, `${key} ${JSON.stringify(foreign)}`);
    }
  }
});

test('colour only when enabled', () => {
  const rows = [
    { id: 'a', stage: 'build', state: 'running', waitingOn: null, round: 1, tasks: { done: 0, total: 0 }, pr: null, session: null, reason: null },
    { id: 'b', stage: 'spec', state: 'waiting', waitingOn: 'spec', round: 0, tasks: { done: 0, total: 0 }, pr: null, session: null, reason: null },
    { id: 'c', stage: 'build', state: 'failed', waitingOn: null, round: 0, tasks: { done: 0, total: 0 }, pr: null, session: null, reason: null },
  ];
  const on = status(rows, { color: true, now: 0 })!;
  assert.ok(on.includes('\x1b[32mrunning\x1b[0m'), on);
  assert.ok(on.includes('\x1b[33mwaiting:spec\x1b[0m'), on);
  assert.ok(on.includes('\x1b[31mfailed\x1b[0m'), on);
  const report = { ok: false, checks: [{ name: 'git', ok: false, detail: 'missing' }, { name: 'node', ok: true, detail: '22' }] };
  const doc = doctor(report, { color: true, now: 0 })!;
  assert.ok(doc.includes('\x1b[31m✗\x1b[0m'), doc);
  assert.ok(doc.includes('\x1b[1mProblems\x1b[0m'), doc);
  assert.ok(doc.includes('\x1b[32m✓\x1b[0m'), doc);
  for (const out of [status(rows, { color: false, now: 0 })!, doctor(report, { color: false, now: 0 })!]) assert.ok(!out.includes('\x1b['), out);
});

describe('the CLI', { concurrency: 4 }, () => {
  test('agent and --json output is unchanged', async () => {
    const r = repo();
    // A gh that answers nothing, so doctor's release check stays off the network.
    const bin = path.join(r.dir, '..', `regbin-${path.basename(r.dir)}`);
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    try {
      const both = async (args: string[]) => {
        const [agent, modeAgent, json, jsonHuman] = await Promise.all([
          forgeAsync(r.dir, args, { ...env, FORGE_MODE: 'agent' }),
          forgeAsync(r.dir, [...args, '--mode', 'agent'], { ...env, FORGE_MODE: 'human' }),
          forgeAsync(r.dir, [...args, '--json'], env),
          forgeAsync(r.dir, [...args, '--json'], { ...env, FORGE_MODE: 'human' }),
        ]);
        for (const x of [agent, modeAgent, json, jsonHuman]) assert.equal(x.stderr, '', `${args.join(' ')}: ${x.stderr}`);
        // Only stats carries a clock: generatedAt differs between two runs.
        const same = (s: string) => s.replace(/"generatedAt":"[^"]*"/, '"generatedAt":"-"');
        assert.equal(same(modeAgent.stdout), same(agent.stdout), `${args.join(' ')}: --mode agent is FORGE_MODE=agent`);
        assert.equal(same(jsonHuman.stdout), same(json.stdout), `${args.join(' ')}: --json beats FORGE_MODE=human`);
        return { agent: agent.stdout, json: json.stdout, status: agent.status, jsonStatus: json.status };
      };

      const version = await both(['version']);
      assert.equal(version.agent, JSON.stringify({ version: forgeVersion() }) + '\n');
      assert.deepEqual(Object.keys(JSON.parse(version.json)), ['version', 'commit', 'installedAs', 'node']);

      const st = await both(['status']);
      assert.equal(st.agent, statusTable(r.dir, false) + '\n');
      assert.ok(st.agent.startsWith('job      stage    state'), st.agent);
      assert.match(st.agent, /^job +stage +state /);
      assert.equal(st.json, JSON.stringify(statusRows(r.dir, false)) + '\n');

      const stats = await both(['stats']);
      assert.ok(stats.agent.startsWith('jobs '), stats.agent);
      assert.equal(stats.agent, statsText(computeStats(r.dir, {})) + '\n');
      assert.ok(JSON.parse(stats.json).counts);

      const reqs = await both(['requests']);
      assert.equal(reqs.agent, '[]\n');
      assert.equal(reqs.json, '[]\n');

      const list = await both(['job', 'list']);
      assert.deepEqual(Object.keys(JSON.parse(list.agent)[0]), ['id', 'title', 'stage', 'state', 'waitingOn', 'round', 'pr', 'owner', 'effort']);
      assert.equal(list.json, list.agent);

      const show = await both(['job', 'show', 'reg-job']);
      assert.equal(show.agent, JSON.stringify(compactJob(r.dir, loadJob(r.dir, 'reg-job'))) + '\n');
      assert.equal(show.json, show.agent);

      const validate = await both(['config', 'validate']);
      const v = JSON.parse(validate.agent);
      assert.deepEqual(Object.keys(v), ['ok', 'initialized', 'problems']);
      assert.equal(validate.agent, JSON.stringify(v) + '\n');
      assert.equal(validate.json, validate.agent);
      assert.equal(validate.jsonStatus, validate.status);

      const doc = await both(['doctor']);
      const d = JSON.parse(doc.agent);
      assert.deepEqual(Object.keys(d), ['ok', 'checks']);
      assert.equal(doc.agent, JSON.stringify(d, null, 2) + '\n', 'doctor always indents');
      assert.deepEqual(JSON.parse(doc.json), d);
    } finally {
      r.cleanup();
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  test('unknown shapes and unregistered commands use the generic renderer', async () => {
    const r = repo();
    try {
      const full = await forgeAsync(r.dir, ['job', 'show', 'reg-job', '--full', '--mode', 'human']);
      assert.equal(full.status, 0, full.stderr);
      assert.match(full.stdout, /^id +reg-job$/m);
      assert.match(full.stdout, /^verifyRuns +-$/m);

      const data = JSON.parse((await forgeAsync(r.dir, ['roster'])).stdout);
      const roster = await forgeAsync(r.dir, ['roster', '--mode', 'human']);
      assert.equal(roster.status, 0, roster.stderr);
      assert.equal(roster.stdout, render(data, { color: false }) + '\n');
    } finally {
      r.cleanup();
    }
  });
});
