// The local dev flow: `forge dash --dev`, `npm run dev` (scripts/dev.ts) and `npm run dev:claude`
// (scripts/dev-claude.ts). Every process a test spawns is killed in its `finally`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { forgeAsync, tempRepo, waitFor } from './helpers.ts';
import * as yaml from '../lib/yaml.ts';

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
  fs.writeFileSync(path.join(dir, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: 2, daemon }));
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
