// The background dev server: start a long-running command detached, prove a recorded pid is the
// one Forge started before the dashboard stops it, and probe whether its port answers.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureEnvironment } from '../environment/lifecycle.ts';
import { jobEnv, vars } from './job-command.ts';
import { loadJob, logEvent, renewLease, jobDir } from '#core/job/store.ts';
import { posixShell } from '#core/os/platform.ts';
import { jobComponent } from '#core/config/components.ts';
import { applySinks } from '../environment/config-sinks-apply.ts';
import { commandPort } from '../environment/endpoints.ts';
import type { Config, EventActor } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { killAndWaitAsync, pidAlive, run } from '#core/os/process.ts';
import { readJson, writeJsonAtomic } from '#core/os/fs.ts';
import { withLock, withLockAsync } from '#core/os/lock.ts';
import { fill } from '#core/text.ts';
import { now } from '#core/utils.ts';
import { readSmallJson } from '#core/job/focus.ts';

/**
 * Long-running commands (dev servers) are detached and tracked by pid so a later session can stop them.
 * Idempotent per command: parallel reviewers share one job port, so a live recorded process is
 * returned instead of starting a second one that would collide on it. A live process whose port
 * does not answer yet is still reused (it may be booting); callers poll until `listening`.
 */
export async function startBackground(
  root: string,
  config: Config,
  id: string,
  name: string,
): Promise<{ pid: number | undefined; port: number | null; log: string; reused: boolean; listening: boolean | null }> {
  const job = loadJob(root, id);
  const template = config.commands[name];
  if (!template) throw new ForgeError(`no "${name}" command configured`);
  if (!job.worktree) throw new ForgeError(`job ${id} has no worktree yet`);
  // The server needs its backing services: a failed start exits 5 before any process starts.
  const env = ensureEnvironment(root, config, job, 'run');
  if (!env.ok) throw new ForgeError(`the job's environment did not start: ${env.error}`, 5);
  renewLease(root, id);
  const port = commandPort(config, job, jobComponent(config, job));
  const dir = jobDir(root, id);
  const pidFile = path.join(dir, 'runtime.json');
  // The lock covers check, spawn and write, so two concurrent calls cannot both spawn.
  const rec = withLock(path.join(dir, '.runtime.lock'), () => {
    const rt = readJson(pidFile, {});
    const prev = rt[name];
    if (prev && pidAlive(prev.pid)) return { pid: prev.pid, log: path.resolve(dir, String(prev.log ?? `logs/${name}.log`)), reused: true };
    // Filled before the log is opened, so a refused value leaves nothing behind.
    // Checked above; the narrowing does not reach into this callback.
    const v = vars(root, config, job, job.worktree!, port, template);
    const cmd = fill(template, v);
    // The component's sinks render before the server starts, as before a foreground command; a
    // reused live process (above) renders nothing.
    const component = jobComponent(config, job);
    const baseEnv = jobEnv(root, config, job, job.worktree!, port);
    const applied = component ? applySinks(root, config, job, component, { env: baseEnv, fillCmd: (t) => fill(t, v) }) : null;
    if (applied) logEvent(root, id, 'config-sinks', applied.summary);
    const sh = posixShell();
    const logFile = path.join(dir, 'logs', `${name}.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, 'a');
    const child = spawn(sh, ['-lc', cmd], {
      cwd: job.worktree!,
      env: { ...baseEnv, ...applied?.env },
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    fs.closeSync(fd);
    rt[name] = { pid: child.pid, startedAt: now(), log: path.relative(dir, logFile), port };
    writeJsonAtomic(pidFile, rt);
    logEvent(root, id, 'background-start', { name, pid: child.pid, port });
    return { pid: child.pid, log: logFile, reused: false };
  });
  const listening = port ? await portAnswers(port) : null;
  return { pid: rec.pid, port, log: rec.log, reused: rec.reused, listening };
}

/** How far the process's start time may be from runtime.json's `startedAt` (ps reports whole seconds). */
const DEV_START_SLACK_MS = 30_000;
const DEV_STOP_WAIT_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;

/** The process's working directory, or null when it can't be read (no /proc, no lsof, not ours to inspect). */
function processCwd(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  if (process.platform !== 'darwin') return null;
  const r = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { allowFail: true, timeoutMs: PROBE_TIMEOUT_MS });
  if (!r.ok) return null;
  const line = r.stdout.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

/**
 * One `ps -o pgid= -o tty= -o lstart=` row: the process group, whether the process has a controlling
 * terminal (`?` on Linux and `??` on macOS mean none), and its start time; null for anything else.
 */
export function parseDevProbe(stdout: string): { pgid: number; tty: boolean; started: number } | null {
  const m = /^\s*(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s*$/.exec(stdout.trim());
  if (!m) return null;
  const started = Date.parse(m[3]);
  return Number.isFinite(started) ? { pgid: Number(m[1]), tty: !/^\?+$/.test(m[2]), started } : null;
}

/**
 * Whether runtime.json's dev record names the dev server Forge started for this job. The record is in
 * the job dir, which the job's agents can write, so it is proved rather than trusted (as isOurChild in
 * lib/office/session/records.ts proves a session): the pid is not 1 or ours, leads its own group and has no controlling
 * terminal (startBackground spawns detached, which starts a new session; a shell the human opened in the
 * worktree, and anything it runs, keeps its terminal), is not our group, started within 30 s of
 * `startedAt`, and runs inside the job's contained worktree. The command line is not compared:
 * `sh -lc '<one command>'` execs that command, so the shell is often gone from it. Always false on
 * Windows, which has none of these probes.
 */
export function ownDevProcess(worktree: string, rec: unknown): boolean {
  if (process.platform === 'win32' || !rec || typeof rec !== 'object') return false;
  const { pid, startedAt } = rec as { pid?: unknown; startedAt?: unknown };
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  const recorded = typeof startedAt === 'string' ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(recorded)) return false;
  const env = { ...process.env, LC_ALL: 'C' };
  const ps = run('ps', ['-o', 'pgid=', '-o', 'tty=', '-o', 'lstart=', '-p', String(pid)], { allowFail: true, env, timeoutMs: PROBE_TIMEOUT_MS });
  const probe = ps.ok ? parseDevProbe(ps.stdout) : null;
  if (!probe || probe.pgid !== pid || probe.tty) return false;
  const own = run('ps', ['-o', 'pgid=', '-p', String(process.pid)], { allowFail: true, env, timeoutMs: PROBE_TIMEOUT_MS });
  if (!own.ok || Number(own.stdout.trim()) === pid) return false;
  if (Math.abs(probe.started - recorded) > DEV_START_SLACK_MS) return false;
  const cwd = processCwd(pid);
  if (!cwd) return false;
  const base = realpath(worktree);
  const real = realpath(cwd);
  return real === base || real.startsWith(base + path.sep);
}

/**
 * The dashboard's Stop: SIGTERM to the dev server's process group, SIGKILL after 5 s if it is still
 * alive, then only the `dev` key leaves runtime.json. Under the runtime lock, so it never races
 * startBackground. A pid it can't prove (ownDevProcess) is refused and nothing is signalled. No record
 * or a dead pid only clears the key. `forge stop` (stopBackground) is unchanged.
 */
export async function stopDevProven(root: string, id: string, worktree: string, actor: EventActor): Promise<{ stopped: boolean; refused?: number }> {
  const dir = jobDir(root, id);
  const pidFile = path.join(dir, 'runtime.json');
  return withLockAsync(path.join(dir, '.runtime.lock'), async () => {
    const rt = readSmallJson(pidFile) ?? {};
    const rec = rt.dev;
    const pid = rec && typeof rec === 'object' ? (rec as { pid?: unknown }).pid : undefined;
    const clear = () => {
      if (!Object.hasOwn(rt, 'dev')) return;
      delete rt.dev;
      writeJsonAtomic(pidFile, rt);
    };
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      clear();
      return { stopped: false };
    }
    // pid 1 is never a dev server Forge started (and its group signal would be -1), and our own pid always reads alive.
    if (pid === 1 || pid === process.pid) return { stopped: false, refused: pid };
    if (!pidAlive(pid)) {
      clear();
      return { stopped: false };
    }
    if (!ownDevProcess(worktree, rec)) return { stopped: false, refused: pid };
    await killAndWaitAsync(pid, DEV_STOP_WAIT_MS);
    clear();
    logEvent(root, id, 'background-stop', { names: ['dev'], actor });
    return { stopped: true };
  });
}

/** Whether something accepts TCP connections on the port, over IPv4 then IPv6. */
export async function portAnswers(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', '::1']) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect({ port, host });
      const done = (v: boolean) => {
        clearTimeout(timer);
        sock.destroy();
        resolve(v);
      };
      const timer = setTimeout(() => done(false), 500);
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
    if (ok) return true;
  }
  return false;
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
