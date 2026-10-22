// `forge dash`'s activity log end to end: a spawned foreground dashboard with a stub claude. Every
// process a test spawns is killed in its `finally`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { forgeAsync, tempRepo, waitFor } from './helpers.ts';
import * as yaml from '../lib/core/format/yaml.ts';
import { CONFIG_SCHEMA_VERSION } from '../lib/core/job/schema.ts';
import { backgroundArgs } from '../lib/commands/dash.ts';

const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };
const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const BANNER = /^⚒️ {2}Forge dashboard → (http:\/\/127\.0\.0\.1:\d+)\n/;

/** A scratch repo with the daemon on and a stub claude that marks when it ran. */
function setup() {
  const repo = tempRepo();
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-stub-'));
  const marker = path.join(stubDir, 'ran');
  fs.writeFileSync(path.join(stubDir, 'claude'), `#!/bin/sh\ntouch '${marker}'\nexec cat >/dev/null\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(repo.dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, daemon: { enabled: true, command: 'claude {session}' } }));
  const { ANTHROPIC_API_KEY: _k, CLAUDE_API_KEY: _c, ...rest } = process.env;
  const env = { ...rest, FORGE_ROOT: repo.dir, NO_COLOR: '1', PATH: `${stubDir}${path.delimiter}${process.env.PATH}` };
  const procs: ChildProcess[] = [];
  const start = (args: string[]) => {
    const p = spawn(process.execPath, [BIN, 'dash', '--foreground', '--port', '0', ...args], { cwd: repo.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    const io = { out: '', err: '' };
    p.stdout!.on('data', (d) => (io.out += d));
    p.stderr!.on('data', (d) => (io.err += d));
    return { p, io };
  };
  const cleanup = () => {
    for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill('SIGTERM');
    // Give the server a moment to stop its sessions, then make sure nothing is left.
    setTimeout(() => {
      for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
    }, 3000).unref();
  };
  const remove = () => {
    repo.cleanup();
    fs.rmSync(stubDir, { recursive: true, force: true });
  };
  return { repo, marker, start, cleanup, remove };
}

const exited = (p: ChildProcess) => (p.exitCode !== null || p.signalCode !== null ? Promise.resolve() : new Promise<void>((r) => p.once('exit', () => r())));

/** Starts a dashboard, then drives a session spawn, a new job and a failing request through it. */
async function drive(s: ReturnType<typeof setup>, args: string[]) {
  const d = s.start(args);
  const banner = await waitFor(() => BANNER.exec(d.io.out), { what: `the banner (${args.join(' ')})` });
  await waitFor(() => fs.existsSync(s.marker), { what: 'the stub claude to run' });
  const job = await forgeAsync(s.repo.dir, ['job', 'new', '--title', 'Activity demo']);
  assert.equal(job.status, 0, job.stderr);
  const id = JSON.parse(job.stdout).id as string;
  const res = await fetch(`${banner[1]}/api/nope`);
  assert.equal(res.status, 404);
  await res.text();
  return { d, id };
}

describe('forge dash activity log', { concurrency: 4 }, () => {
  test('human mode prints the activity log', POSIX, async () => {
    const s = setup();
    try {
      const { d, id } = await drive(s, ['--mode', 'human']);
      await waitFor(() => /^\[\d{2}:\d{2}:\d{2}\] session _inbox spawned/m.test(d.io.out), { what: 'the spawned line' });
      await waitFor(() => new RegExp(`^\\[\\d{2}:\\d{2}:\\d{2}\\] job ${id} `, 'm').test(d.io.out), { what: 'the job line' });
      await waitFor(() => /^\[\d{2}:\d{2}:\d{2}\] http GET \/api\/nope 404 \d+ms$/m.test(d.io.out), { what: 'the http line' });
      assert.match(d.io.out, BANNER, 'the banner comes first');
      for (const k of ['[session]', '[http]', '[job]']) assert.ok(!d.io.out.includes(k), `no bracketed kind ${k}`);
      assert.ok(!d.io.out.includes('\x1b'), 'NO_COLOR keeps it plain');
      d.p.kill('SIGTERM');
      await exited(d.p);
    } finally {
      s.cleanup();
      s.remove();
    }
  });

  test('agent mode and --quiet print only the banner', POSIX, async () => {
    const a = setup();
    const q = setup();
    try {
      const [agent, quiet] = await Promise.all([drive(a, ['--mode', 'agent']), drive(q, ['--mode', 'human', '--quiet'])]);
      // Longer than the job tail's 1 s tick, so a line it would print has had its chance.
      await new Promise((r) => setTimeout(r, 1500));
      for (const { d } of [agent, quiet]) {
        const m = BANNER.exec(d.io.out);
        assert.ok(m, d.io.out);
        assert.equal(d.io.out, m[0], 'stdout is exactly the banner line');
        d.p.kill('SIGTERM');
      }
      await Promise.all([exited(agent.d.p), exited(quiet.d.p)]);
    } finally {
      a.cleanup();
      q.cleanup();
      a.remove();
      q.remove();
    }
  });

  test('background child gets --quiet', () => {
    assert.deepEqual(backgroundArgs(7400, {}), ['dash', '--foreground', '--port', '7400', '--quiet']);
    assert.deepEqual(backgroundArgs(7401, { dev: true }), ['dash', '--foreground', '--port', '7401', '--dev', '--quiet']);
  });

  test('help documents --quiet', async () => {
    const repo = tempRepo();
    try {
      const r = await forgeAsync(repo.dir, ['help', 'dash', '--json']);
      assert.equal(r.status, 0, r.stderr);
      const help = JSON.parse(r.stdout);
      assert.match(help.args, /--quiet/);
      assert.ok(help.flags.some(([flag]: [string]) => flag === '--quiet'));
    } finally {
      repo.cleanup();
    }
  });
});
