// The background dev server: start a long-running command detached, prove a recorded pid is the
// one Forge started before the dashboard stops it, and probe whether its port answers.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureEnvironment } from '../environment/lifecycle.ts';
import { jobEnv, vars } from './job-command.ts';
import { loadJob, logEvent, renewLease, jobDir } from '#core/job/store.ts';
import { commandShell, loginShell } from '../guard/command-env.ts';
import { jobComponent } from '#core/config/components.ts';
import { applySinks } from '../environment/config-sinks-apply.ts';
import { commandPort } from '../environment/endpoints.ts';
import type { Config, EventActor } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { killAndWaitAsync, pidAlive } from '#core/os/process.ts';
import { ownDevProcess } from './dev-probe.ts';
import { readJson, writeJsonAtomic } from '#core/os/fs.ts';
import { withLock, withLockAsync } from '#core/os/lock.ts';
import { fill } from '#core/text.ts';
import { now } from '#core/utils.ts';
import { readSmallJson } from '#core/job/focus.ts';
import { LOG_ROTATE_BYTES } from '#core/job/session-files.ts';

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
    const sh = commandShell(cmd, { login: loginShell(config) });
    const { fd, file: logFile } = openBackgroundLog(root, config, id, name);
    const child = spawn(sh.file, sh.args, {
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

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

/**
 * A background command's log, `<jobDir>/logs/<name>.log`, opened for the child to append to. The
 * job's agents write the job dir and the child runs unsandboxed, so a planted link must not aim its
 * output anywhere else: the logs dir must resolve to where it should be under the real root, and the
 * log must be a regular file with a single link. A refused log throws a ForgeError naming it, and
 * the link and its target are left alone. A log at retention.logMaxBytes (null: past
 * LOG_ROTATE_BYTES, as for session logs) is first renamed to `<name>.log.1`, replacing the older one.
 */
export function openBackgroundLog(root: string, config: Config, id: string, name: string): { fd: number; file: string } {
  const logs = path.join(jobDir(root, id), 'logs');
  const file = path.join(logs, `${name}.log`);
  const refuse = (why: string): never => {
    throw new ForgeError(`refusing to write ${file}: ${why}`);
  };
  try {
    fs.mkdirSync(logs, { recursive: true });
  } catch {
    // A planted non-directory: the check below names it.
  }
  let real: string | null = null;
  try {
    real = fs.realpathSync(logs);
  } catch {}
  if (real !== path.join(fs.realpathSync(root), path.relative(root, logs))) refuse('its logs dir does not resolve to the job dir (a symlink?)');
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') refuse((e as Error).message);
  }
  if (st && (!st.isFile() || st.nlink !== 1)) refuse('it is not a regular file with a single link');
  const max = config.retention?.logMaxBytes;
  const cap = Number.isSafeInteger(max) && (max as number) > 0 ? (max as number) : null;
  if (st && (cap !== null ? st.size >= cap : st.size > LOG_ROTATE_BYTES)) {
    try {
      fs.renameSync(file, `${file}.1`);
    } catch (e) {
      refuse(`cannot rotate it: ${(e as Error).message}`);
    }
  }
  let fd: number;
  try {
    // O_NOFOLLOW and O_NONBLOCK hold if a link or FIFO is swapped in since the lstat.
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW | NONBLOCK, 0o644);
  } catch (e) {
    return refuse((e as Error).message);
  }
  const opened = fs.fstatSync(fd);
  if (!opened.isFile() || opened.nlink !== 1) {
    fs.closeSync(fd);
    refuse('it is not a regular file with a single link');
  }
  return { fd, file };
}

const DEV_STOP_WAIT_MS = 5_000;

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
