// The local dev flow: `forge dash --dev`, `npm run dev` (scripts/dev.ts) and `npm run dev:claude`
// (scripts/dev-claude.ts). Every process a test spawns is killed in its `finally`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { forgeAsync, tempRepo, waitFor } from './helpers.ts';
import * as yaml from '#core/format/yaml.ts';
import { CONFIG_SCHEMA_VERSION } from '#core/job/schema.ts';
import { DEV_DIST_DIR } from '#core/paths.ts';
import { devPlan } from '../scripts/dev.ts';

const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };
const ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'bin', 'forge');

const alive = (pid: number | undefined) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function writeConfig(dir: string, daemon: Record<string, unknown>) {
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, daemon }));
}

/** Resolves with the exit code (or signal) once `p` has exited. */
const exited = (p: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
  p.exitCode !== null || p.signalCode !== null
    ? Promise.resolve({ code: p.exitCode, signal: p.signalCode })
    : new Promise((r) => p.once('exit', (code, signal) => r({ code, signal })));

describe('forge dash --dev', { concurrency: 4 }, () => {
  test('dash --dev refuses beside a running dashboard', POSIX, async () => {
    const repo = tempRepo();
    try {
      writeConfig(repo.dir, { enabled: false });
      const rt = path.join(repo.dir, '.forge', 'runtime');
      fs.mkdirSync(rt, { recursive: true });
      const file = path.join(rt, 'dashboard.json');
      const url = 'http://127.0.0.1:7999';
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, url, startedAt: new Date().toISOString() }));
      const before = fs.readFileSync(file);
      for (const extra of [[], ['--foreground'], ['--background']]) {
        const r = await forgeAsync(repo.dir, ['dash', '--dev', ...extra, '--json']);
        assert.equal(r.status, 1, extra.join(' ') || 'plain');
        const err = JSON.parse(r.stdout.trim());
        const text = JSON.stringify(err);
        assert.ok(text.includes(url), text);
        assert.ok(text.includes(`pid ${process.pid}`), text);
        assert.ok(text.includes('forge dash --stop'), text);
        assert.ok(fs.readFileSync(file).equals(before), 'dashboard.json untouched');
      }
    } finally {
      repo.cleanup();
    }
  });

  test('dash --dev starts without the daemon or the auth prompt', POSIX, async () => {
    const repo = tempRepo();
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-stub-'));
    const marker = path.join(stubDir, 'ran');
    fs.writeFileSync(path.join(stubDir, 'claude'), `#!/bin/sh\ntouch '${marker}'\nexec cat >/dev/null\n`, { mode: 0o755 });
    writeConfig(repo.dir, { enabled: true, command: 'claude {session}' });
    const cfgFile = path.join(repo.dir, '.forge', 'config.yml');
    const cfgBefore = fs.readFileSync(cfgFile);
    const env = { ...process.env, FORGE_ROOT: repo.dir, ANTHROPIC_API_KEY: 'test', PATH: `${stubDir}${path.delimiter}${process.env.PATH}` };
    const procs: ChildProcess[] = [];
    const start = (args: string[]) => {
      const p = spawn(process.execPath, [BIN, 'dash', ...args, '--port', '0'], { cwd: repo.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      procs.push(p);
      const io = { out: '', err: '' };
      p.stdout!.on('data', (d) => (io.out += d));
      p.stderr!.on('data', (d) => (io.err += d));
      return { p, io };
    };
    try {
      const dev = start(['--dev']);
      const banner = await waitFor(() => /⚒️ {2}Forge dashboard \(dev\) → (http:\/\/127\.0\.0\.1:\d+)\n/.exec(dev.io.out), { what: 'the dev banner' });
      const url = banner[1];
      const rt = JSON.parse(fs.readFileSync(path.join(repo.dir, '.forge', 'runtime', 'dashboard.json'), 'utf8'));
      assert.equal(rt.pid, dev.p.pid);
      assert.equal(rt.url, url);
      const state = await (await fetch(`${url}/api/state`)).json();
      assert.equal(state.daemons.wanted, false);
      // Long enough for a boot start to have spawned the stub, as the control run shows it does.
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(fs.existsSync(marker), false, 'the stub claude never ran');
      assert.ok(fs.readFileSync(cfgFile).equals(cfgBefore), 'config.yml untouched');
      assert.doesNotMatch(dev.io.err, /daemon\.auth/);
      dev.p.kill('SIGTERM');
      assert.deepEqual(await exited(dev.p), { code: 0, signal: null });

      // The control: without --dev the same repo boots the inbox and runs the stub.
      const plain = start([]);
      await waitFor(() => fs.existsSync(marker), { what: 'the stub claude to run without --dev' });
      assert.match(plain.io.err, /daemon\.auth/, 'without --dev the auth note is printed');
      plain.p.kill('SIGTERM');
      await exited(plain.p);
    } finally {
      for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
      repo.cleanup();
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });

  test('help documents --dev', async () => {
    const repo = tempRepo();
    try {
      const r = await forgeAsync(repo.dir, ['help', 'dash', '--json']);
      assert.equal(r.status, 0, r.stderr);
      const help = JSON.parse(r.stdout);
      assert.match(help.args, /--dev/);
      assert.ok(help.flags.some(([flag]: [string]) => flag === '--dev'));
      const one = help.exits.find(([code]: [number]) => code === 1);
      assert.ok(one, 'an exit-1 row');
      assert.match(one[1], /--dev while a dashboard is already running/);
      const text = await forgeAsync(repo.dir, ['help', 'dash']);
      assert.match(text.stdout, /--dev/);
    } finally {
      repo.cleanup();
    }
  });
});

// ---- npm run dev (scripts/dev.ts) and npm run dev:claude (scripts/dev-claude.ts).

test('dev plan builds into the dev dir, never dashboard/dist', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-initcwd-'));
  try {
    const { vite, dash } = devPlan([], { INIT_CWD: d });
    assert.deepEqual(vite.args, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--watch', '--config', path.join(ROOT, 'dashboard', 'vite.config.mjs'), '--outDir', DEV_DIST_DIR, '--emptyOutDir']);
    assert.equal(vite.command, process.execPath);
    assert.equal(vite.cwd, ROOT);
    assert.equal(dash.command, process.execPath);
    assert.deepEqual(dash.args, [BIN, 'dash', '--dev']);
    assert.equal(dash.cwd, d);
    assert.equal(devPlan([], {}).dash.cwd, process.cwd(), 'cwd when INIT_CWD is unset');
    const withPort = devPlan(['--port', '7500'], { INIT_CWD: d });
    assert.deepEqual(withPort.dash.args, [BIN, 'dash', '--dev', '--port', '7500']);
    assert.deepEqual(devPlan(['--port', '0'], { INIT_CWD: d }).dash.args.slice(-2), ['--port', '0']);
    for (const bad of [['--background'], ['--port'], ['--port', 'x'], ['--port', '65536'], ['--port', '-1'], ['--port', '7500', '--dev'], ['7500']]) {
      assert.throws(() => devPlan(bad, { INIT_CWD: d }), /usage: npm run dev \[-- --port N\]/, bad.join(' '));
    }
    const dist = path.join(ROOT, 'dashboard', 'dist');
    for (const p of [vite, withPort.dash]) {
      for (const a of [p.command, ...p.args]) {
        const abs = path.resolve(p.cwd, a);
        assert.ok(abs !== dist && !abs.startsWith(dist + path.sep), `${a} resolves inside dashboard/dist`);
      }
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.dev, 'node scripts/dev.ts');
    assert.equal(pkg.scripts['dev:claude'], 'node scripts/dev-claude.ts');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// A stub child: records its pid when its handlers are in, and how it meets SIGTERM.
const CHILD = `
const fs = require('node:fs');
const [dir, name, mode] = process.argv.slice(1);
const f = (k) => dir + '/' + k + '-' + name;
process.on('SIGTERM', () => {
  fs.writeFileSync(f('term'), 'SIGTERM');
  if (mode === 'ignore') return;
  const done = () => { fs.writeFileSync(f('exited'), 'yes'); process.exit(0); };
  mode === 'slow' ? setTimeout(done, 300) : done();
});
setInterval(() => {}, 1000);
if (mode === 'exit3') setTimeout(() => process.exit(3), 300);
fs.writeFileSync(f('ready'), String(process.pid));
`;
const DRIVER = `
import fs from 'node:fs';
import { supervise } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts', 'dev.ts')).href)};
const dir = process.env.DRV_DIR;
const procs = JSON.parse(process.env.DRV_PROCS).map(([name, mode]) => ({ name, command: process.execPath, args: ['-e', process.env.DRV_CHILD, dir, name, mode], cwd: dir }));
const code = await supervise(procs, { killAfterMs: Number(process.env.DRV_KILL), log: () => {} });
fs.writeFileSync(dir + '/driver', JSON.stringify({ code, slowExited: fs.existsSync(dir + '/exited-slow') }));
process.exit(code);
`;

describe('dev supervisor stops both children on one signal', { concurrency: 4 }, () => {
  const drive = (procs: [string, string][], killAfterMs: number) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sup-'));
    const p = spawn(process.execPath, ['--input-type=module', '-e', DRIVER], {
      env: { ...process.env, DRV_DIR: dir, DRV_PROCS: JSON.stringify(procs), DRV_KILL: String(killAfterMs), DRV_CHILD: CHILD },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    p.stderr!.on('data', (d) => (err += d));
    const has = (k: string) => fs.existsSync(path.join(dir, k));
    const pidOf = (name: string) => Number(fs.readFileSync(path.join(dir, `ready-${name}`), 'utf8'));
    const ready = () => waitFor(() => procs.every(([n]) => has(`ready-${n}`)), { what: `children ready (${err})` });
    const result = () => JSON.parse(fs.readFileSync(path.join(dir, 'driver'), 'utf8'));
    const cleanup = () => {
      if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
      for (const [n] of procs) if (has(`ready-${n}`) && alive(pidOf(n))) process.kill(pidOf(n), 'SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    };
    return { p, has, pidOf, ready, result, cleanup };
  };

  test('SIGTERM reaches both children; exit 0 only after the slower one is gone', POSIX, async () => {
    const d = drive([['slow', 'slow'], ['fast', 'fast']], 15_000);
    try {
      await d.ready();
      d.p.kill('SIGTERM');
      assert.deepEqual(await exited(d.p), { code: 0, signal: null });
      assert.ok(d.has('term-slow') && d.has('term-fast'), 'both children got SIGTERM');
      assert.deepEqual(d.result(), { code: 0, slowExited: true }, 'the slower child had exited before the driver');
    } finally {
      d.cleanup();
    }
  });

  test('a child that exits by itself stops the other and sets the exit code', POSIX, async () => {
    const d = drive([['bad', 'exit3'], ['fast', 'fast']], 15_000);
    try {
      await d.ready();
      assert.deepEqual(await exited(d.p), { code: 3, signal: null });
      assert.ok(d.has('term-fast'), 'the other child got SIGTERM');
      assert.ok(!d.has('term-bad'));
    } finally {
      d.cleanup();
    }
  });

  test('a child that ignores SIGTERM is killed after killAfterMs', POSIX, async () => {
    const d = drive([['stubborn', 'ignore'], ['fast', 'fast']], 200);
    try {
      await d.ready();
      const pid = d.pidOf('stubborn');
      d.p.kill('SIGTERM');
      assert.deepEqual(await exited(d.p), { code: 0, signal: null });
      assert.ok(d.has('term-stubborn'));
      await waitFor(() => !alive(pid), { what: 'the stubborn child to be gone' });
    } finally {
      d.cleanup();
    }
  });

  test('a second signal kills the stragglers at once', POSIX, async () => {
    const d = drive([['a', 'ignore'], ['b', 'ignore']], 60_000);
    try {
      await d.ready();
      const pids = [d.pidOf('a'), d.pidOf('b')];
      d.p.kill('SIGTERM');
      await waitFor(() => d.has('term-a') && d.has('term-b'), { what: 'both children to get SIGTERM' });
      const t0 = Date.now();
      d.p.kill('SIGTERM');
      assert.deepEqual(await exited(d.p), { code: 0, signal: null });
      assert.ok(Date.now() - t0 < 5000, 'well before killAfterMs');
      await waitFor(() => pids.every((x) => !alive(x)), { what: 'both children to be gone' });
    } finally {
      d.cleanup();
    }
  });
});

test("dev:claude launches the checkout's plugin with its bin first", POSIX, async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-devclaude-')));
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claude-stub-'));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-nopath-'));
  const rec = path.join(stubDir, 'rec');
  fs.writeFileSync(
    path.join(stubDir, 'claude'),
    `#!/bin/sh\n{ printf '%s\\n' "$PWD"; printf '%s\\n' "$PATH"; for a in "$@"; do printf '%s\\n' "$a"; done; } > '${rec}'\nexit 7\n`,
    { mode: 0o755 },
  );
  const script = path.join(ROOT, 'scripts', 'dev-claude.ts');
  const run = (env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> =>
    new Promise((resolve) => {
      execFile(process.execPath, [script, '--foo', 'bar'], { cwd: ROOT, env }, (err, _out, stderr) => resolve({ code: err ? ((err as any).code ?? null) : 0, stderr }));
    });
  try {
    const PATH = `${stubDir}${path.delimiter}${process.env.PATH}`;
    const r = await run({ ...process.env, INIT_CWD: tmp, PATH });
    assert.equal(r.code, 7, r.stderr);
    const [pwd, seenPath, ...args] = fs.readFileSync(rec, 'utf8').trimEnd().split('\n');
    assert.deepEqual(args, ['--plugin-dir', ROOT, '--foo', 'bar']);
    assert.equal(seenPath, `${path.join(ROOT, 'bin')}${path.delimiter}${PATH}`);
    assert.equal(fs.realpathSync(pwd), tmp);

    const none = await run({ ...process.env, INIT_CWD: tmp, PATH: empty });
    assert.equal(none.code, 1);
    assert.match(none.stderr, /claude is not on PATH/);
  } finally {
    for (const d of [tmp, stubDir, empty]) fs.rmSync(d, { recursive: true, force: true });
  }
});
