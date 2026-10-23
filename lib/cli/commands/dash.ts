// `forge dash`: start the dashboard in the foreground or as a detached, pid-tracked process.
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { paths, PLUGIN_ROOT } from '#core/paths.ts';
import { currentActor } from '#integrations/github/actor.ts';
import { setConfigValue } from '#core/config/set.ts';
import { PERMISSION_MODES, apiKeyVars } from '#integrations/claude/argv.ts';
import { reapOrphans } from '#office/session/records.ts';
import { daemonPlatformProblem } from '#core/os/platform.ts';
import { getPath } from '#core/shape.ts';
import { ForgeError } from '#core/errors.ts';
import { pidAlive, sleepSync } from '#core/os/process.ts';
import { readJson, readText, writeJsonAtomic } from '#core/os/fs.ts';
import * as yaml from '#core/format/yaml.ts';
import { out, outputMode } from './args.ts';
import { colorEnabled } from './render.ts';
import type { RunningServer } from '../../server/types.ts';
import type { Config, DaemonPermissionMode } from '#core/types.ts';
import type { HelpGroup } from '../types.ts';

export const HELP: HelpGroup[] = [
  {
    name: 'dash',
    summary: 'the live dashboard and its session pool',
    commands: [
      {
        command: 'dash',
        args: '[--background|--stop] [--port N] [--permission-mode MODE] [--dev] [--quiet]',
        summary: 'start the dashboard in the foreground (prints its URL), or detached with --background; --stop stops it and its sessions',
        flags: [
          ['--background', 'start it detached and print {url, pid}'],
          ['--stop', 'stop it and reap its sessions'],
          ['--port N', 'the first port to try (default: dashboard.port, 7400)'],
          ['--foreground', 'run in the foreground even when one is running'],
          ['--permission-mode MODE', "the job sessions' default permission mode until it stops: default (ask), auto or dontAsk (refuse); refused in a daemon session"],
          ['--dev', "serve npm run dev's watching build (node_modules/.cache/forge/dashboard-dev) instead of dashboard/dist; the daemon stays off until Start; refused while a dashboard runs for this repo"],
          ['--quiet', 'in the foreground in human mode, print only the banner (no activity log)'],
        ],
        exits: [[1, 'no free port near N, --dev while a dashboard is already running for this repo, or --permission-mode in a daemon session']],
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
  setConfigValue(root, 'daemon.auth', auth, () => currentActor(root));
  config.daemon.auth = auth;
  return { note: `daemon.auth: ${auth} written to .forge/config.yml` };
}

/**
 * Why the daemon a `forge dash` would boot won't start here, or null. Only when it would boot: a
 * dev dashboard or a repo without the daemon has nothing to refuse.
 */
export function daemonPlatformNote(config: Config, flags: Record<string, any>, platform: NodeJS.Platform = process.platform): string | null {
  if (flags.dev || !config.daemon.enabled) return null;
  return daemonPlatformProblem(platform);
}

/** What `forge dash` says before it serves: the billing note, or the platform refusal that skips the billing question. */
export async function dashNotes(root: string, config: Config, flags: Record<string, any>, platform: NodeJS.Platform = process.platform): Promise<{ note?: string; daemonRefused?: string }> {
  // The pool refuses to start on native Windows; the dashboard still serves, and says why up front.
  const refused = daemonPlatformNote(config, flags, platform);
  if (refused) return { daemonRefused: refused };
  // A dev dashboard never boots the daemon, so it has no billing question to ask or config to write.
  return flags.dev ? {} : settleDaemonAuth(root, config);
}

/** The detached child's argv: --quiet, since its stdio is ignored and an activity log would only cost it work. */
export function backgroundArgs(port: number, flags: Record<string, any>): string[] {
  const mode = jobPermissionMode(flags);
  return ['dash', '--foreground', '--port', String(port), ...(mode ? ['--permission-mode', mode] : []), ...(flags.dev ? ['--dev'] : []), '--quiet'];
}

// Auto lets most calls run unread, so only the human's own command line may make it every job's default.
const MODE_DAEMON_REFUSAL = "forge dash --permission-mode sets every job session's permission mode, which a daemon session may not do; a human runs it in their own terminal or chooses it in the dashboard";

/** --permission-mode, validated; null when absent. */
export function jobPermissionMode(flags: Record<string, any>, env: NodeJS.ProcessEnv = process.env): DaemonPermissionMode | null {
  const v = flags['permission-mode'];
  if (v === undefined) return null;
  if (env.FORGE_DAEMON === '1') throw new ForgeError(MODE_DAEMON_REFUSAL);
  const mode = PERMISSION_MODES.find((m) => m === v);
  if (!mode) throw new ForgeError(`--permission-mode must be one of ${PERMISSION_MODES.join(', ')} (got ${JSON.stringify(String(v).slice(0, 40))})`, 'usage', 'forge help dash');
  return mode;
}

export async function dash(root: string, config: Config, flags: Record<string, any>): Promise<void> {
  const mode = jobPermissionMode(flags);
  const rtFile = path.join(paths(root).runtime, 'dashboard.json');
  const current = readJson(rtFile, null);
  const alive = pidAlive(current?.pid);
  if (flags.stop) {
    if (alive) {
      // pidAlive checks the group first, so the server itself may already be gone.
      try {
        process.kill(current.pid, 'SIGTERM');
      } catch {}
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
  const note = await dashNotes(root, config, flags);
  if (flags.background) {
    const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'forge'), ...backgroundArgs(port, flags)], {
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
  if (note.daemonRefused) process.stderr.write(`${note.daemonRefused}\n`);
  // Before the server (and its sessions) start, so no live session holds a log it would delete. A
  // dev dashboard points at a scratch repo and deletes nothing; a failure never stops the server.
  if (!flags.dev) {
    try {
      const { applyRetention } = await import('#engine/ops/retention.ts');
      applyRetention(root, config, 'policy');
    } catch (e) {
      process.stderr.write(`retention: ${(e as Error).message}\n`);
    }
  }
  const { startServer } = await import('../../server/start.ts');
  // Agent mode and --quiet keep stdout exactly the banner, and run none of the log's hooks or polls.
  const activity = outputMode() === 'human' && !flags.quiet ? await import('../activity.ts') : null;
  const color = colorEnabled(Boolean(process.stdout.isTTY), process.env);
  const onRequest = activity?.requestLogger(activity.stdoutWriter, { color });
  let res: RunningServer | undefined;
  for (let p = port; p < port + 20; p++) {
    try {
      res = await startServer(root, { port: p, dev: Boolean(flags.dev), ...(mode ? { daemon: { jobPermissionMode: mode } } : {}), ...(onRequest ? { onRequest } : {}) });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    }
  }
  if (!res) throw new ForgeError(`no free port near ${port}`);
  writeJsonAtomic(rtFile, { pid: process.pid, url: res.url, startedAt: new Date().toISOString() });
  const server = res;
  let closing = false;
  let detach: (() => void) | null = null;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      detach?.();
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
  // After the banner, so it stays the first line; a session that spawned before this prints as the
  // tracker's baseline.
  if (activity) {
    try {
      detach = activity.attachActivityLog(root, server, { color });
    } catch {
      // The log never stops the dashboard.
    }
  }
}
