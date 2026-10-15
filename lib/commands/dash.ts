// `forge dash`: start the dashboard in the foreground or as a detached, pid-tracked process.
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { paths, PLUGIN_ROOT } from '../paths.ts';
import { setConfigValue } from '../config-set.ts';
import { apiKeyVars, reapOrphans } from '../daemon.ts';
import { ForgeError, getPath, readJson, readText, sleepSync, writeJsonAtomic } from '../util.ts';
import * as yaml from '../yaml.ts';
import { pidAlive } from '../worktree.ts';
import { out } from './args.ts';
import type { RunningServer } from '../server.ts';
import type { Config, HelpGroup } from '../types.ts';

export const HELP: HelpGroup[] = [
  {
    name: 'dash',
    summary: 'the live dashboard and its session pool',
    commands: [
      {
        command: 'dash',
        args: '[--background|--stop] [--port N] [--dev]',
        summary: 'start the dashboard in the foreground (prints its URL), or detached with --background; --stop stops it and its sessions',
        flags: [
          ['--background', 'start it detached and print {url, pid}'],
          ['--stop', 'stop it and reap its sessions'],
          ['--port N', 'the first port to try (default: dashboard.port, 7400)'],
          ['--foreground', 'run in the foreground even when one is running'],
          ['--dev', "serve npm run dev's watching build (node_modules/.cache/forge/dashboard-dev) instead of dashboard/dist; the daemon stays off until Start; refused while a dashboard runs for this repo"],
        ],
        exits: [[1, 'no free port near N, or --dev while a dashboard is already running for this repo']],
      },
    ],
  },
];

/**
 * An ANTHROPIC_API_KEY in this shell would make headless sessions bill an API account instead of
 * the Claude login, which almost nobody wants, so sessions drop it unless `daemon.auth` says
 * api-key. The first time a daemon-enabled repo starts with a key set and no explicit choice in
 * config.yml, a terminal asks once and records the answer; anywhere else (a Claude Code session,
 * a script) the subscription is assumed and the output says so.
 */
async function settleDaemonAuth(root: string, config: Config): Promise<{ note?: string }> {
  const keys = apiKeyVars(process.env);
  if (!config.daemon.enabled || !keys.length) return {};
  const file = paths(root).config;
  let explicit: unknown;
  try {
    explicit = getPath(yaml.parse(readText(file)) ?? {}, 'daemon.auth');
  } catch {
    return {};
  }
  const vars = keys.join(' and ');
  if (explicit !== undefined) return {};
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return { note: `${vars} is set but daemon sessions run on your Claude login; set daemon.auth: api-key in .forge/config.yml to bill the API key instead` };
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  let answer = '';
  try {
    answer = await rl.question(`${vars} is set in this shell. Daemon sessions run on your Claude login unless you choose the API key.\nBill daemon sessions to the API key instead? [y/N] `);
  } finally {
    rl.close();
  }
  const auth = /^y(es)?$/i.test(answer.trim()) ? 'api-key' : 'subscription';
  setConfigValue(root, 'daemon.auth', auth);
  config.daemon.auth = auth;
  return { note: `daemon.auth: ${auth} written to .forge/config.yml` };
}

export async function dash(root: string, config: Config, flags: Record<string, any>): Promise<void> {
  const rtFile = path.join(paths(root).runtime, 'dashboard.json');
  const current = readJson(rtFile, null);
  const alive = current?.pid && (() => {
    try {
      process.kill(current.pid, 0);
      return true;
    } catch {
      return false;
    }
  })();
  if (flags.stop) {
    if (alive) {
      process.kill(current.pid, 'SIGTERM');
      // The server stops its sessions on SIGTERM before exiting: up to 5 s of grace, then SIGKILL
      // and up to 5 s more. 12 s covers that with room to close the server.
      for (let i = 0; i < 240 && pidAlive(current.pid); i++) sleepSync(50);
    }
    writeJsonAtomic(rtFile, {});
    // Whatever the server could not stop (it was SIGKILLed, or hung) is reaped here.
    const { reaped } = reapOrphans(root);
    return out({ stopped: Boolean(alive), daemonReaped: reaped.length > 0 }, flags);
  }
  // A dev dashboard must never take over (or silently stand beside) the repo's live one: they would
  // share dashboard.json and the session pool's records.
  if (flags.dev && alive) {
    throw new ForgeError(
      `a dashboard is already running for this repo at ${current.url} (pid ${current.pid}); stop it with forge dash --stop, or point npm run dev at a scratch repo with FORGE_ROOT=<dir>`,
      'failed',
      'forge dash --stop',
    );
  }
  if (alive && !flags.foreground) return out({ url: current.url, pid: current.pid, running: true }, flags);
  const port = Number(flags.port ?? config.dashboard.port ?? 7400);
  // A dev dashboard never boots the daemon, so it has no billing question to ask or config to write.
  const note = flags.dev ? {} : await settleDaemonAuth(root, config);
  if (flags.background) {
    const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'forge'), 'dash', '--foreground', '--port', String(port), ...(flags.dev ? ['--dev'] : [])], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    for (let i = 0; i < 60; i++) {
      const rt = readJson(rtFile, null);
      if (rt?.pid === child.pid) return out({ url: rt.url, pid: child.pid, started: true, ...note }, flags);
      sleepSync(50);
    }
    return out({ url: `http://127.0.0.1:${port}`, pid: child.pid, started: true, unconfirmed: true, ...note }, flags);
  }
  if (note.note) process.stderr.write(`${note.note}\n`);
  const { startServer } = await import('../server.ts');
  let res: RunningServer | undefined;
  for (let p = port; p < port + 20; p++) {
    try {
      res = await startServer(root, { port: p, dev: Boolean(flags.dev) });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    }
  }
  if (!res) throw new ForgeError(`no free port near ${port}`);
  writeJsonAtomic(rtFile, { pid: process.pid, url: res.url, startedAt: new Date().toISOString() });
  const server = res;
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // Last resort (an uncaught exception, a plain exit): signal every session's group synchronously.
  process.on('exit', () => server.pool.killSync());
  process.stdout.write(`⚒️  Forge dashboard${flags.dev ? ' (dev)' : ''} → ${res.url}\n`);
}
