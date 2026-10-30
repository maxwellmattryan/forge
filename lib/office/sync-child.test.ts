// syncChildEnv, and a tracked core.hooksPath hook against a real `git fetch` under that env; runChild's stop
// signal against real node children.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scratchGitConfig, waitFor } from '../../test/helpers.ts';
import { SYNC_PINS } from '#integrations/git/runner.ts';
import { STDOUT_MAX, runChild, runChildOutput, syncChildEnv } from './sync-child.ts';

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) => execFileSync('git', args, { cwd, env, stdio: 'pipe', encoding: 'utf8' });

function repo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  scratchGitConfig((...a: string[]) => git(dir, a));
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', 'init']);
}

test('the sync child runs git with the pins', (t) => {
  const env = syncChildEnv('/r', {
    PATH: '/bin',
    FORGE_DAEMON: '1',
    FORGE_DAEMON_SCOPE: 'j1',
    FORGE_DAEMON_TRUST: 'x',
    FORGE_DAEMON_WRITE_ROOTS: '{}',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'Caller',
  });
  assert.equal(env.FORGE_ROOT, '/r');
  assert.equal(env.FORGE_MODE, 'agent');
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('FORGE_DAEMON')), []);
  assert.equal(env.GIT_CONFIG_COUNT, String(1 + SYNC_PINS.length));
  assert.deepEqual([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0], ['user.name', 'Caller'], "the caller's entry stays first");
  const pinned = SYNC_PINS.map((_, i) => [env[`GIT_CONFIG_KEY_${i + 1}`], env[`GIT_CONFIG_VALUE_${i + 1}`]]);
  assert.deepEqual(pinned, SYNC_PINS.map(([k, v]) => [k, v]));
  assert.ok(!pinned.some(([k]) => k === 'credential.helper'), 'credential.helper is never pinned');
  for (const k of ['core.hooksPath', 'core.fsmonitor', 'core.pager', 'diff.external', 'gpg.program']) assert.ok(pinned.some(([key]) => key === k), k);

  if (process.platform === 'win32') return t.diagnostic('the hook half skips on Windows');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sync-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const origin = path.join(base, 'origin');
  repo(origin);
  /** A checkout with a tracked .githooks/reference-transaction hook and core.hooksPath on it. */
  const checkout = (name: string) => {
    const dir = path.join(base, name);
    repo(dir);
    fs.mkdirSync(path.join(dir, '.githooks'));
    fs.writeFileSync(path.join(dir, '.githooks', 'reference-transaction'), '#!/bin/sh\necho ran > "$PWD/hook-ran"\n', { mode: 0o755 });
    git(dir, ['add', '-A']);
    git(dir, ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', 'hooks']);
    git(dir, ['config', 'core.hooksPath', '.githooks']);
    git(dir, ['remote', 'add', 'origin', origin]);
    return dir;
  };
  const pinnedDir = checkout('pinned');
  git(pinnedDir, ['fetch', '-q', 'origin'], syncChildEnv(pinnedDir, process.env));
  assert.equal(fs.existsSync(path.join(pinnedDir, 'hook-ran')), false, 'the hook never runs under the pins');
  const bareDir = checkout('bare');
  git(bareDir, ['fetch', '-q', 'origin']);
  assert.equal(fs.existsSync(path.join(bareDir, 'hook-ran')), true, 'the hook runs without them');
});

test('an aborted child is stopped: SIGTERM, then SIGKILL after the grace period', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX signals');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-child-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const graceMs = 100;
  // Each child writes its ready file (argv[1]) once its SIGTERM handling is in place, then runs until killed.
  const rows = [
    { name: 'honours SIGTERM', script: "require('fs').writeFileSync(process.argv[1], ''); setInterval(() => {}, 1000)", early: false, message: 'exit SIGTERM' },
    { name: 'ignores SIGTERM', script: "process.on('SIGTERM', () => {}); require('fs').writeFileSync(process.argv[1], ''); setInterval(() => {}, 1000)", early: false, message: 'exit SIGKILL' },
    { name: 'already aborted', script: 'setInterval(() => {}, 1000)', early: true, message: 'exit SIGTERM' },
  ];
  for (const row of rows) {
    const ready = path.join(base, `${rows.indexOf(row)}.ready`);
    const stop = new AbortController();
    if (row.early) stop.abort();
    const run = runChild(process.execPath, ['-e', row.script, ready], { cwd: base, env: process.env, stop: { signal: stop.signal, graceMs } });
    if (!row.early) await waitFor(() => fs.existsSync(ready), { what: `${row.name}: the child is ready` });
    const abortedAt = Date.now();
    stop.abort();
    const message = await run;
    assert.equal(message, row.message, row.name);
    if (row.message === 'exit SIGKILL') assert.ok(Date.now() - abortedAt >= graceMs - 5, `${row.name}: killed only after the grace period`);
  }
});

test("runChildOutput keeps a child's stdout, and runChild's message is unchanged", async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-child-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const run = (script: string) => runChildOutput(process.execPath, ['-e', script], { cwd: base, env: process.env, stdout: true });
  const ok = await run("process.stdout.write(JSON.stringify({ok: true}) + '\\n')");
  assert.deepEqual([ok.code, ok.signal, ok.error, JSON.parse(ok.stdout)], [0, null, null, { ok: true }]);
  const refused = await run("process.stdout.write('{\"error\":{\"message\":\"no\"}}'); process.stderr.write('first\\nlast\\n'); process.exit(3)");
  assert.deepEqual([refused.code, JSON.parse(refused.stdout).error.message], [3, 'no']);
  assert.equal(await runChild(process.execPath, ['-e', "process.stderr.write('first\\nlast\\n'); process.exit(3)"], { cwd: base, env: process.env }), 'last');
  // A child that prints past the cap is killed and its output reported as cut.
  const flood = await run(`const b = Buffer.alloc(1024 * 1024, 120); for (let i = 0; i < ${STDOUT_MAX / 1024 / 1024 + 2}; i++) process.stdout.write(b); setInterval(() => {}, 1000)`);
  assert.match(flood.error ?? '', /stdout passed 4 MiB/);
  assert.ok(flood.stdout.length <= STDOUT_MAX);
});
