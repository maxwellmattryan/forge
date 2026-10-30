// syncChildEnv, and a tracked core.hooksPath hook against a real `git fetch` under that env; runChild's stop
// signal against real node children; runForgeCall against a real `bin/forge` stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { scratchGitConfig, waitFor } from '../../../test/helpers.ts';
import { SYNC_PINS } from '#integrations/git/runner.ts';
import { STDOUT_MAX, runChild, runChildOutput, runForgeCall, syncChildEnv } from './children.ts';

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

test('runForgeCall returns the exit code and parsed JSON', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX signals');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-call-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // A module node loads before bin/forge: it answers in forge's place, then exits, so no real command runs.
  const preload = (name: string, body: string) => {
    const file = path.join(base, `${name}.mjs`);
    fs.writeFileSync(file, `import fs from 'node:fs';\n${body}\n`);
    return { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(pathToFileURL(file).href)}`.trim() };
  };
  const stop = { signal: new AbortController().signal, graceMs: 100 };
  const rows = [
    {
      name: 'JSON and exit 3',
      env: preload('json', `fs.writeSync(1, JSON.stringify({ id: 'j1', n: 2 }) + '\\n'); fs.writeSync(2, 'noise\\nforge: request 1-a is being handled by session s\\n'); process.exit(3);`),
      want: { code: 3, signal: null, json: { id: 'j1', n: 2 }, error: 'request 1-a is being handled by session s' },
    },
    {
      name: 'a JSON error line',
      env: preload('err', `fs.writeSync(2, JSON.stringify({ error: 'repo budget: held' }) + '\\n'); process.exit(4);`),
      want: { code: 4, signal: null, json: null, error: 'repo budget: held' },
    },
    {
      name: 'output over 1 MiB',
      env: preload('big', `const chunk = 'x'.repeat(64 * 1024); for (let i = 0; i < 40; i++) fs.writeSync(1, chunk); process.exit(0);`),
      want: { code: null, signal: 'SIGKILL', json: null, error: 'output over 1 MiB' },
    },
  ];
  for (const row of rows) {
    const r = await runForgeCall(base, ['sync'], { env: row.env, stop });
    assert.deepEqual({ code: r.code, signal: r.signal, json: r.json, error: r.error }, row.want, row.name);
    assert.ok(Number.isFinite(r.ms) && r.ms >= 0, `${row.name}: ms`);
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
