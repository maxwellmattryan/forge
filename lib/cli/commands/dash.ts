// `forge dash`: the machine's one dashboard for every registered project, started in the foreground or
// as a detached, pid-tracked process, registering the repo it runs in.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { exists, forgeHome, paths, PLUGIN_ROOT } from '#core/paths.ts';
import { loadConfig } from '#core/config/load.ts';
import { addProject, ensureMachineDirs, listProjects, projectByRoot } from '#engine/project/machine-index.ts';
import { approveTrust } from '#engine/project/trust-approval.ts';
import { currentActor } from '#integrations/github/actor.ts';
import { setConfigValue } from '#core/config/set.ts';
import { PERMISSION_MODES, apiKeyVars } from '#integrations/claude/argv.ts';
import { reapOrphans } from '#office/session/records.ts';
import { daemonPlatformProblem } from '#core/os/platform.ts';
import { getPath } from '#core/shape.ts';
import { ForgeError } from '#core/errors.ts';
import { pidAlive, sleepSync } from '#core/os/process.ts';
import { readText, writeJsonAtomic, writeJsonPrivate } from '#core/os/fs.ts';
import { legacyDashboardFile, loopbackOrigin, machineDashboardFile, provenDashboard, readDashboardRecord, type DashboardRecord } from '#engine/ops/dashboard-record.ts';
import { adoptCommandPath } from '#engine/guard/command-path.ts';
import { spawnSleepHelper } from '#integrations/os-service/sleep.ts';
import * as yaml from '#core/format/yaml.ts';
import { out, outputMode } from './args.ts';
import { colorEnabled } from './render.ts';
import type { RunningServer } from '../../server/types.ts';
import type { Config, DaemonPermissionMode } from '#core/types.ts';
import type { HelpGroup } from '../types.ts';

export const HELP: HelpGroup[] = [
  {
    name: 'dash',
    summary: "the machine's dashboard and every registered project's session pool",
    commands: [
      {
        command: 'dash',
        args: '[--background|--stop|--service] [--port N] [--permission-mode MODE] [--dev] [--quiet]',
        summary:
          "open the machine's dashboard, one server for every project in the machine index: in a repo with .forge/config.yml it registers that repo first (forge project add's default name) and, when it registers it or starts the dashboard, approves the files Forge trusts there as they are (a project's daemon boots with the dashboard only while they still match; a report for a repo already registered approves nothing), then prints the running one's {url: <origin>/?project=<name>, pid, running: true, project, added, permissionMode}, or starts it in the foreground (prints its URL), or detached with --background ({url, pid, started: true, project, added, permissionMode}); outside a project it registers nothing (project: null). permissionMode is the run's launch mode (--permission-mode), or null. Its record is <FORGE_HOME>/dashboard.json ({pid, url, startedAt, permissionMode}, 0600, never the token; the mode is only reported, never applied); a daemon session may only get the report for a registered project",
        flags: [
          ['--background', 'start it detached and print {url, pid, started: true, project, added, permissionMode}'],
          ['--stop', "stop the machine's dashboard and, in a repo, an older per-repo dashboard (.forge/runtime/dashboard.json), then reap every registered project's orphaned sessions ({stopped, daemonReaped}); a record whose pid is not provably that dashboard is cleared without signalling anything"],
          ['--port N', "the first port to try (default: this repo's dashboard.port, 7400)"],
          ['--foreground', 'run in the foreground even when one is running'],
          ['--permission-mode MODE', 'the permission mode every job, inbox and office session of every project starts in until it stops: default (ask), auto or dontAsk (refuse); a running dashboard with another mode is reported, never changed; refused in a daemon session'],
          ['--dev', "serve npm run dev's watching build (node_modules/.cache/forge/dashboard-dev) instead of dashboard/dist for every project of FORGE_HOME, with no pool booting until Start; it builds nothing itself, so start it through npm run dev; refused from a forge without Vite (an installed plugin) and while a proven machine dashboard runs (a stale record does not block it)"],
          ['--quiet', 'in the foreground in human mode, print only the banner (no activity log)'],
          [
            '--service',
            "what the login service runs (forge service install): in the foreground, and once the boot passes of the projects loaded at start settle, it records the restart in <FORGE_HOME>/runtime/uptime.json and sends each project with running jobs or open Office requests one service-restarted notification; a usage error with --background, --stop or --dev",
          ],
        ],
        exits: [
          [
            1,
            "no free port near N, --dev from a forge without Vite or while a proven machine dashboard is running, this repo's default name registered for another path, --permission-mode in a daemon session, --permission-mode that differs from the running machine dashboard's, or a daemon session that would start, stop or register, or ran --service (only the report for a registered project is allowed)",
          ],
        ],
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

/** Retention for every registered project the server will load, each under its own config; a failure never stops the server. */
async function retainAll(home: string): Promise<void> {
  let projects: { path: string; status: string }[] = [];
  try {
    projects = listProjects(home).projects;
  } catch (e) {
    return void process.stderr.write(`retention: ${(e as Error).message}\n`);
  }
  const { applyRetention } = await import('#engine/ops/retention.ts');
  for (const p of projects) {
    if (p.status !== 'ok') continue;
    try {
      applyRetention(p.path, loadConfig(p.path).config, 'policy');
    } catch (e) {
      process.stderr.write(`retention (${p.path}): ${(e as Error).message}\n`);
    }
  }
}

/** The detached child's argv: --quiet, since its stdio is ignored and an activity log would only cost it work. */
export function backgroundArgs(port: number, flags: Record<string, any>): string[] {
  const mode = launchPermissionMode(flags);
  return ['dash', '--foreground', '--port', String(port), ...(mode ? ['--permission-mode', mode] : []), ...(flags.dev ? ['--dev'] : []), '--quiet'];
}

// Auto lets most calls run unread, so only the human's own command line may make it the run's launch mode.
const MODE_DAEMON_REFUSAL =
  'forge dash --permission-mode sets the permission mode every session of the run starts in, which a daemon session may not do; a human runs it in their own terminal or chooses it in the dashboard';

/** --permission-mode, validated: the run's launch mode; null when absent. */
export function launchPermissionMode(flags: Record<string, any>, env: NodeJS.ProcessEnv = process.env): DaemonPermissionMode | null {
  const v = flags['permission-mode'];
  if (v === undefined) return null;
  if (env.FORGE_DAEMON === '1') throw new ForgeError(MODE_DAEMON_REFUSAL);
  const mode = PERMISSION_MODES.find((m) => m === v);
  if (!mode) throw new ForgeError(`--permission-mode must be one of ${PERMISSION_MODES.join(', ')} (got ${JSON.stringify(String(v).slice(0, 40))})`, 'usage', 'forge help dash');
  return mode;
}

/** Why a `forge dash --permission-mode <mode>` was not applied to the running machine dashboard. */
function modeMismatch(current: DashboardRecord, mode: DaemonPermissionMode): string {
  const running = current.permissionMode ? `runs with --permission-mode ${current.permissionMode}` : "runs without --permission-mode (each project's sessions start in daemon.command's mode)";
  return `the machine's dashboard at ${current.url} (pid ${current.pid}) ${running}, so --permission-mode ${mode} was not applied; stop it with forge dash --stop and start it again with --permission-mode ${mode}, or run forge dash without the flag`;
}

// Registering a project boots a pool under that project's config, and starting or stopping the
// server reaches every project's sessions: a human's call, never a session's.
const DASH_DAEMON_REFUSAL = "forge dash starts, stops and registers the machine's dashboard, which a daemon session may not do; a human runs it in their own terminal";

/** SIGTERM to a proven dashboard, then a wait for it to stop its sessions and exit. */
function stopProven(pid: number): void {
  // pidAlive checks the group first, so the server itself may already be gone.
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
  // The server stops its sessions on SIGTERM before exiting: up to 5 s of grace, then SIGKILL
  // and up to 5 s more. 12 s covers that with room to close the server.
  for (let i = 0; i < 240 && pidAlive(pid); i++) sleepSync(50);
}

/** `forge dash --stop`: the machine dashboard, and in a repo an older per-repo one, then every registered project's orphans. */
function stopDashboards(home: string, root: string | null, current: DashboardRecord | null, flags: Record<string, any>): void {
  if (current) stopProven(current.pid);
  ensureMachineDirs(home);
  writeJsonPrivate(machineDashboardFile(home), {});
  let legacy: DashboardRecord | null = null;
  if (root) {
    const file = legacyDashboardFile(root);
    legacy = provenDashboard(file);
    if (legacy) stopProven(legacy.pid);
    if (fs.existsSync(file)) writeJsonAtomic(file, {});
  }
  // Whatever a server could not stop (it was SIGKILLed, or hung) is reaped here.
  const roots = new Set<string>(root ? [root] : []);
  try {
    for (const p of listProjects(home).projects) if (p.status !== 'missing') roots.add(p.path);
  } catch {
    // An unreadable index still reaps this repo's.
  }
  let reaped = 0;
  for (const r of roots) reaped += reapOrphans(r).reaped.length;
  return out({ stopped: Boolean(current || legacy), daemonReaped: reaped > 0 }, flags);
}

/**
 * `forge dash`: the machine's one dashboard, for every registered project. In a repo with
 * `.forge/config.yml` (`root` and `config`) it registers that repo first; outside one (`root` null,
 * or `initialized` false) it registers nothing.
 */
export async function dash(root: string | null, config: Config | null, flags: Record<string, any>, initialized = root !== null): Promise<void> {
  if (flags.service && (flags.background || flags.stop || flags.dev)) throw new ForgeError('--service runs the dashboard in the foreground, so it takes no --background, --stop or --dev', 'usage', 'forge help dash');
  const mode = launchPermissionMode(flags);
  const home = forgeHome();
  const machineFile = machineDashboardFile(home);
  // The record is proven before its pid is signalled or its url shown: anything else counts as no dashboard at all.
  const current = provenDashboard(machineFile);
  const project = root && initialized && config ? root : null;
  const uninitialized = root && !project ? { note: `${root} has no .forge/config.yml; run /forge init to serve it here` } : {};
  if (process.env.FORGE_DAEMON === '1') {
    // Only a report: a running machine dashboard, for a project already registered.
    const known = project ? projectByRoot(home, project) : null;
    if (flags.stop || flags.dev || flags.background || flags.foreground || flags.service || !current || !known) throw new ForgeError(DASH_DAEMON_REFUSAL);
    return out({ url: `${current.url}/?project=${known.name}`, pid: current.pid, running: true, project: known.name, added: false, permissionMode: current.permissionMode }, flags);
  }
  if (flags.stop) return stopDashboards(home, root, current, flags);
  // The dev build comes from a checkout's `npm run dev`; an installed plugin has no Vite, so its page would
  // answer 503 for good.
  if (flags.dev && !exists(path.join(PLUGIN_ROOT, 'node_modules', 'vite'))) {
    throw new ForgeError(`--dev serves a Forge checkout's npm run dev build, and this forge (${PLUGIN_ROOT}) has none; run npm run dev [-- --permission-mode MODE] in the checkout`);
  }
  // The running server keeps the mode it was started with: a different flag would look applied when it is not, so
  // it is refused before this command registers, approves or writes anything.
  if (current && mode !== null && !flags.foreground && !flags.dev && mode !== current.permissionMode) throw new ForgeError(modeMismatch(current, mode), 'failed', 'forge dash --stop');
  // A human's `forge dash` in this repo approves the files Forge trusts as they are now when it starts the dashboard or
  // registers the repo: its pool boots with them, and a later restart boots it only while they stay the same. A dev
  // dashboard boots nothing, so it approves nothing.
  const approve = (): void => {
    if (project && !flags.dev) approveTrust(home, fs.realpathSync(project));
  };
  let named: { project: string | null; added?: boolean } = { project: null };
  if (project) {
    // Before the registration, so a running server that loads it at once already finds the files approved. Only for a
    // repo this registers: opening the running dashboard for a registered one approves nothing, so a change since its
    // last approval (one a "trusted config changed" notice points at) still waits for Start.
    if (current && projectByRoot(home, project) === null) approve();
    const r = addProject(home, fs.realpathSync(project));
    named = { project: r.project.name, added: r.added };
  }
  const urlOf = (origin: string) => (named.project ? `${origin}/?project=${named.project}` : origin);
  // A dev dashboard must never take over (or silently stand beside) the machine's live one: they would
  // share the record and every project's session records.
  if (flags.dev && current) {
    throw new ForgeError(
      `the machine's dashboard is already running at ${current.url} (pid ${current.pid}); stop it with forge dash --stop, or run npm run dev with a scratch FORGE_HOME=<dir>`,
      'failed',
      'forge dash --stop',
    );
  }
  // The running server picks up a new registration at its next index refresh (2 s).
  if (current && !flags.foreground) return out({ url: urlOf(current.url), pid: current.pid, running: true, ...named, permissionMode: current.permissionMode, ...uninitialized }, flags);
  const port = Number(flags.port ?? config?.dashboard.port ?? 7400);
  const note = project && config ? await dashNotes(project, config, flags) : {};
  // After the notes: the billing answer may have written daemon.auth to config.yml, which the pool must boot with.
  approve();
  if (flags.background) {
    const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'forge'), ...backgroundArgs(port, flags)], {
      cwd: root ?? process.cwd(),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    // The child captures the login shell's PATH (up to 5 s) and loads the server before it writes its
    // record. 15 s covers that on a loaded machine; a healthy start returns as soon as the record appears.
    for (let i = 0; i < 300; i++) {
      // The pid is the child just spawned, so only the url needs proving.
      const rt = readDashboardRecord(machineFile);
      const url = rt && rt.pid === child.pid ? loopbackOrigin(rt.url) : null;
      if (url) return out({ url: urlOf(url), pid: child.pid, started: true, ...named, permissionMode: mode, ...uninitialized, ...note }, flags);
      sleepSync(50);
    }
    return out({ url: urlOf(`http://127.0.0.1:${port}`), pid: child.pid, started: true, unconfirmed: true, ...named, permissionMode: mode, ...uninitialized, ...note }, flags);
  }
  if ('note' in uninitialized) process.stderr.write(`${uninitialized.note}\n`);
  if (note.note) process.stderr.write(`${note.note}\n`);
  if (note.daemonRefused) process.stderr.write(`${note.daemonRefused}\n`);
  // Once, before any session or command starts: a dashboard launched from a GUI or launchd has none of
  // the profile's PATH, and every configured command and daemon session inherits what this sets.
  try {
    adoptCommandPath(process.env);
  } catch (e) {
    process.stderr.write(`command PATH: ${(e as Error).message}\n`);
  }
  // Before the server (and its sessions) start, so no live session holds a log it would delete. A
  // dev dashboard serves scratch repos and deletes nothing; a failure never stops the server.
  if (!flags.dev) await retainAll(home);
  const { startServer } = await import('../../server/start.ts');
  // Agent mode and --quiet keep stdout exactly the banner, and run none of the log's hooks or polls.
  const activity = outputMode() === 'human' && !flags.quiet ? await import('../activity.ts') : null;
  const color = colorEnabled(Boolean(process.stdout.isTTY), process.env);
  const onRequest = activity?.requestLogger(activity.stdoutWriter, { color });
  let res: RunningServer | undefined;
  for (let p = port; p < port + 20; p++) {
    try {
      res = await startServer({
        home,
        port: p,
        dev: Boolean(flags.dev),
        ...(mode ? { daemon: { launchPermissionMode: mode } } : {}),
        ...(onRequest ? { onRequest } : {}),
        // The one place the real sleep helper is passed: FORGE_KEEP_AWAKE=never here turns it off.
        ...(flags.dev ? {} : { keepAwake: { spawn: spawnSleepHelper, env: process.env } }),
      });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    }
  }
  if (!res) throw new ForgeError(`no free port near ${port}`);
  // Outside every repo, 0600 in a 0700 home: no session can plant or read it, and it never holds the token.
  ensureMachineDirs(home);
  // permissionMode is only reported (a mismatched launch, forge daemon status): nothing reads it back to set a mode.
  writeJsonPrivate(machineFile, { pid: process.pid, url: res.url, startedAt: new Date().toISOString(), permissionMode: mode });
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
  process.on('exit', () => server.killSync());
  process.stdout.write(`⚒️  Forge dashboard${flags.dev ? ' (dev)' : ''} → ${urlOf(res.url)}\n`);
  // A start by hand sends nothing: only the login service's start is a restart worth telling a team about.
  if (flags.service) {
    const { recordRestart } = await import('../../server/uptime.ts');
    void res.booted().then((boots) => recordRestart(home, boots));
  }
  // After the banner, so it stays the first line; a session that spawned before this prints as the
  // tracker's baseline.
  if (activity) {
    try {
      detach = activity.attachActivityLog(server, { color });
    } catch {
      // The log never stops the dashboard.
    }
  }
}
