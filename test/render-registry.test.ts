// lib/commands/render/index.ts: the human-mode renderer registry, its key, and that agent mode never changes.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, repoTemplate } from './helpers.ts';
import { dispatch } from '../lib/cli/main.ts';
import { loadConfig } from '../lib/core/config/load.ts';
import { forgeVersion } from '../lib/engine/evals/run.ts';
import { loadJob } from '../lib/core/job/store.ts';
import { computeStats } from '../lib/engine/metrics/stats.ts';
import { compactJob } from '../lib/cli/commands/job.ts';
import { out, outputMode, parseArgs, renderKeyOf, setOutputMode, setRenderKey } from '../lib/cli/commands/args.ts';
import { configCmd } from '../lib/cli/commands/config.ts';
import { versionCmd } from '../lib/cli/commands/version.ts';
import { render } from '../lib/cli/commands/render.ts';
import { RENDERERS, renderKey } from '../lib/cli/commands/render/registry.ts';
import { doctor } from '../lib/cli/commands/render/doctor.ts';
import { status } from '../lib/cli/commands/render/status.ts';
import { statsText, statusRows, statusTable } from '../lib/cli/commands/status.ts';

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

/** A dir holding a gh that answers nothing, so doctor's release check stays off the network. */
function quietGh(r: { dir: string }): { bin: string; PATH: string } {
  const bin = path.join(r.dir, '..', `regbin-${path.basename(r.dir)}`);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  return { bin, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}

// Only stats carries a clock: generatedAt differs between two runs.
const sameClock = (s: string) => s.replace(/"generatedAt":"[^"]*"/, '"generatedAt":"-"');

/**
 * One agent-mode call as main() makes it, in-process, with stdout collected (Buffer chunks, the
 * test runner's own reports, pass through). Restores the mode, render key, stdout and exit code.
 */
async function agentOut(root: string, args: string[]): Promise<string> {
  const prevMode = outputMode();
  const prevKey = renderKeyOf();
  const prevExit = process.exitCode;
  const write = process.stdout.write;
  let printed = '';
  try {
    setOutputMode('agent');
    const { pos, flags } = parseArgs(args);
    setRenderKey(renderKey(pos));
    const { config, initialized } = loadConfig(root);
    // version and config print for themselves; everything else goes through dispatch and out().
    const d = pos[0] === 'version' || pos[0] === 'config' ? null : await dispatch(args, { root, config, initialized });
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk !== 'string') return (write as (...a: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
      printed += chunk;
      return true;
    }) as typeof process.stdout.write;
    if (pos[0] === 'version') versionCmd(flags);
    else if (pos[0] === 'config') configCmd(root, config, initialized, pos[1], pos.slice(2), flags);
    else if (!d!.printed) out(d!.data, d!.pretty ? { ...flags, pretty: true } : flags);
  } finally {
    process.stdout.write = write;
    process.exitCode = prevExit;
    setOutputMode(prevMode);
    setRenderKey(prevKey);
  }
  return printed;
}

// In-process, outside the concurrent block: it sets the module-wide mode, render key and PATH.
test('--json carries the data agent output prints', async () => {
  const r = repo();
  const gh = quietGh(r);
  const prevPath = process.env.PATH;
  try {
    process.env.PATH = gh.PATH;
    const both = async (args: string[]) => ({ agent: await agentOut(r.dir, args), json: await agentOut(r.dir, [...args, '--json']) });

    const version = await both(['version']);
    assert.deepEqual(Object.keys(JSON.parse(version.json)), ['version', 'commit', 'installedAs', 'node']);
    assert.equal(JSON.parse(version.json).version, JSON.parse(version.agent).version);

    const st = await both(['status']);
    assert.equal(st.agent, statusTable(r.dir, false) + '\n');
    assert.equal(st.json, JSON.stringify(statusRows(r.dir, false)) + '\n');

    const stats = await both(['stats']);
    assert.equal(stats.agent, statsText(computeStats(r.dir, {})) + '\n');
    assert.ok(JSON.parse(stats.json).counts);

    for (const args of [['requests'], ['job', 'list'], ['job', 'show', 'reg-job'], ['config', 'validate']]) {
      const x = await both(args);
      assert.equal(x.json, x.agent, args.join(' '));
    }

    const doc = await both(['doctor']);
    const d = JSON.parse(doc.agent);
    assert.equal(doc.agent, JSON.stringify(d, null, 2) + '\n', 'doctor always indents');
    assert.deepEqual(JSON.parse(doc.json), d);
  } finally {
    process.env.PATH = prevPath;
    r.cleanup();
    fs.rmSync(gh.bin, { recursive: true, force: true });
  }
});

describe('the CLI', { concurrency: 4 }, () => {
  test('agent and --json output is unchanged', async () => {
    const r = repo();
    const gh = quietGh(r);
    const env = { PATH: gh.PATH, FORGE_MODE: 'agent' };
    try {
      const agent = async (args: string[], extra: NodeJS.ProcessEnv = {}) => {
        const x = await forgeAsync(r.dir, args, { ...env, ...extra });
        assert.equal(x.stderr, '', `${args.join(' ')}: ${x.stderr}`);
        return x;
      };

      assert.equal((await agent(['version'])).stdout, JSON.stringify({ version: forgeVersion() }) + '\n');

      // The two mode-precedence rules, once each, on status: its agent text differs from its JSON.
      const [st, modeAgent, jsonHuman] = await Promise.all([
        agent(['status']),
        agent(['status', '--mode', 'agent'], { FORGE_MODE: 'human' }),
        agent(['status', '--json'], { FORGE_MODE: 'human' }),
      ]);
      assert.equal(st.stdout, statusTable(r.dir, false) + '\n');
      assert.match(st.stdout, /^job +stage +state /);
      assert.equal(modeAgent.stdout, st.stdout, '--mode agent is FORGE_MODE=agent');
      assert.equal(jsonHuman.stdout, JSON.stringify(statusRows(r.dir, false)) + '\n', '--json beats FORGE_MODE=human');

      const stats = await agent(['stats']);
      assert.ok(stats.stdout.startsWith('jobs '), stats.stdout);
      assert.equal(sameClock(stats.stdout), sameClock(statsText(computeStats(r.dir, {})) + '\n'));

      assert.equal((await agent(['requests'])).stdout, '[]\n');

      const list = await agent(['job', 'list']);
      assert.deepEqual(Object.keys(JSON.parse(list.stdout)[0]), ['id', 'title', 'stage', 'state', 'waitingOn', 'round', 'pr', 'owner', 'effort']);

      const show = await agent(['job', 'show', 'reg-job']);
      assert.equal(show.stdout, JSON.stringify(compactJob(r.dir, loadJob(r.dir, 'reg-job'))) + '\n');

      const validate = await agent(['config', 'validate']);
      assert.equal(validate.status, 0);
      const v = JSON.parse(validate.stdout);
      assert.deepEqual(Object.keys(v), ['ok', 'initialized', 'problems']);
      assert.equal(validate.stdout, JSON.stringify(v) + '\n');

      const doc = await agent(['doctor']);
      const d = JSON.parse(doc.stdout);
      assert.deepEqual(Object.keys(d), ['ok', 'checks']);
      assert.equal(doc.stdout, JSON.stringify(d, null, 2) + '\n', 'doctor always indents');
    } finally {
      r.cleanup();
      fs.rmSync(gh.bin, { recursive: true, force: true });
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
