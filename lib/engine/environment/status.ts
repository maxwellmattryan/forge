// A job's environment as the dashboard shows it (issue #199): its dev server's state and last log lines,
// its backing services, and every running environment in the checkout with its CPU and memory. Docker is
// reached only through the CLI as an async child (forgeJson) or one argv-only `docker stats` call, so no
// dashboard request waits on lib/engine/environment/backing.ts's synchronous docker calls. runtime.json and logs/ are in the
// job dir, which the job's agents can write: both are read without following links or blocking on FIFOs.
// Starting, stopping and tearing an environment down is lib/engine/environment/lifecycle.ts.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { entriesOrNone, isManaged } from './backing.ts';
import { readLogPage } from '../../core/job/session-files.ts';
import { dockerRunAsync } from '../../integrations/docker/runner.ts';
import type { DockerStateName } from '../../integrations/docker/runner.ts';
import { jobEndpoints } from './endpoints.ts';
import { readSmallJson } from '../../core/job/focus.ts';
import { currentFocus } from '../workspace/focus-actions.ts';
import { isActive, jobDir, listJobs } from '../../core/job/store.ts';
import { PLUGIN_ROOT } from '../../core/paths.ts';
import { pidAlive } from '../../core/os/process.ts';
import { commandTemplate, portAnswers } from '../workspace/worktree.ts';
import type { Config, EnvironmentDev, EnvironmentRow, EnvironmentService, EnvironmentsResponse, EnvironmentUsage, JobEnvironmentResponse, LoadedJob } from '../../core/types.ts';

/** The most a CLI child may print: a status of every container fits many times over. */
const MAX_CLI_OUTPUT = 4 * 1024 * 1024;
const DEV_TAIL_LINES = 20;
const DEV_TAIL_BYTES = 16 * 1024;
const STATUS_TIMEOUT_MS = 10_000;
/** Docker's own name charset; a name that fails it never reaches an argv. */
export const DOCKER_NAME = /^[a-z0-9][a-z0-9_.-]*$/;

/**
 * One log file opened for reading: 'missing' when it does not exist, 'refused' when it (or its dir)
 * resolves outside the real `dirPath` or is not a regular file. Read through one non-blocking
 * descriptor checked to be a regular file; the caller closes it.
 */
export function openConfinedLog(root: string, dirPath: string, file: string): { fd: number; size: number } | 'missing' | 'refused' {
  let real: string;
  let dir: string;
  try {
    dir = fs.realpathSync(dirPath);
    real = fs.realpathSync(file);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'refused';
  }
  // The dir itself must be where it should be: a symlinked .forge/runtime, job dir or logs dir
  // would otherwise move the confinement root somewhere else.
  const expected = path.join(fs.realpathSync(root), path.relative(root, dirPath));
  if (dir !== expected || !real.startsWith(dir + path.sep)) return 'refused';
  let fd: number | undefined;
  try {
    // O_NONBLOCK: a FIFO planted as the log must not hang the server; fstat rejects it.
    // `real` is fully resolved, so O_NOFOLLOW only refuses a link swapped in since the check.
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      fs.closeSync(fd);
      return 'refused';
    }
    return { fd, size: stat.size };
  } catch {
    if (fd !== undefined) fs.closeSync(fd);
    return 'refused';
  }
}

/** `<jobDir>/logs/dev.log`, the only dev log the dashboard reads: runtime.json's `log` field is never used. */
export function openDevLog(root: string, id: string): ReturnType<typeof openConfinedLog> {
  const logs = path.join(jobDir(root, id), 'logs');
  return openConfinedLog(root, logs, path.join(logs, 'dev.log'));
}

/** The last lines of the dev log, oldest first; [] when it is missing, refused or unreadable. */
function devTail(root: string, id: string): string[] {
  const opened = openDevLog(root, id);
  if (typeof opened === 'string') return [];
  try {
    return readLogPage(opened.fd, opened.size, 0, { maxLines: DEV_TAIL_LINES, maxBytes: DEV_TAIL_BYTES }).lines.map((l) => l.line);
  } catch {
    return [];
  } finally {
    fs.closeSync(opened.fd);
  }
}

/** The recorded dev pid, when it is an integer above 1: pid 1 is never a dev server, so it reads as none (`stopped`), not `down`. */
function recordedDev(root: string, id: string): { pid: number | null; startedAt: string | null } {
  const rec = readSmallJson(path.join(jobDir(root, id), 'runtime.json'))?.dev;
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { pid: null, startedAt: null };
  const { pid, startedAt } = rec as { pid?: unknown; startedAt?: unknown };
  return { pid: typeof pid === 'number' && Number.isInteger(pid) && pid > 1 ? pid : null, startedAt: typeof startedAt === 'string' ? startedAt : null };
}

/** The port the dev command serves: the first component's (job.port), as endpointsFor in lib/server/start.ts reads it. */
function devPort(root: string, config: Config, job: LoadedJob): number | null {
  return jobEndpoints(root, config, job).components.find((c) => c.port === job.port)?.port ?? null;
}

/** The job's dev server, or null when no dev command is configured for it. */
async function devStatus(root: string, config: Config, job: LoadedJob): Promise<EnvironmentDev | null> {
  const dev = commandTemplate(config, job, 'dev');
  if (typeof dev !== 'string' || !dev.trim()) return null;
  const port = devPort(root, config, job);
  const { pid, startedAt } = recordedDev(root, job.id);
  if (pid === null) return { state: 'stopped', pid: null, port, listening: null, startedAt: null, tail: [] };
  if (!pidAlive(pid)) return { state: 'down', pid: null, port, listening: null, startedAt, tail: devTail(root, job.id) };
  if (port === null) return { state: 'running', pid, port, listening: null, startedAt, tail: [] };
  const listening = await portAnswers(port);
  return { state: listening ? 'running' : 'starting', pid, port, listening, startedAt, tail: [] };
}

export interface CliJson {
  exitCode: number | null;
  data: any;
  error: string | null;
  /** The CLI's error code (docs/CLI.md "Error codes"), or null when it printed none. */
  code: string | null;
}

/**
 * `forge <args> --json` as an async child: lib/engine/environment/backing.ts runs Docker through spawnSync, which would
 * freeze every dashboard request for as long as a docker call takes. Output is capped and the child is
 * killed on timeout. `error` is the CLI's error message, or why the child failed.
 */
export function forgeJson(root: string, args: string[], timeoutMs: number): Promise<CliJson> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'forge'), ...args, '--json'], {
      cwd: root,
      env: { ...process.env, FORGE_ROOT: root, FORGE_MODE: 'agent' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let why: string | null = null;
    const take = (list: Buffer[]) => (c: Buffer) => {
      bytes += c.length;
      if (bytes > MAX_CLI_OUTPUT) {
        why = 'output too large';
        child.kill('SIGKILL');
        return;
      }
      list.push(c);
    };
    child.stdout.on('data', take(out));
    child.stderr.on('data', take(err));
    const timer = setTimeout(() => {
      why = `timed out after ${Math.round(timeoutMs / 1000)} s`;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (e) => {
      why = e.message;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let data: any = null;
      try {
        data = JSON.parse(Buffer.concat(out).toString('utf8'));
      } catch {}
      const cliError = data && typeof data === 'object' && data.error && typeof data.error.message === 'string' ? data.error.message : null;
      const stderr = Buffer.concat(err).toString('utf8').trim().split('\n').slice(-3).join('\n');
      const error = why ?? cliError ?? (code === 0 ? null : stderr || `exited ${code}`);
      const cliCode = cliError && typeof data.error.code === 'string' ? data.error.code : null;
      resolve({ exitCode: why ? null : code, data: cliError ? null : data, error, code: why ? null : cliCode });
    });
  });
}

/** One `backing status <id>` service as the Environment card shows it. */
function toService(s: any): EnvironmentService | null {
  if (!s || typeof s !== 'object' || typeof s.name !== 'string') return null;
  const ports: Record<string, number> = {};
  if (s.ports && typeof s.ports === 'object') for (const [k, v] of Object.entries(s.ports)) if (Number.isInteger(v)) ports[k] = v as number;
  const states: EnvironmentService['state'][] = ['running', 'stopped', 'missing', 'unknown', 'external'];
  const state = states.includes(s.state) ? s.state : 'unknown';
  const health = s.health === 'healthy' || s.health === 'unhealthy' || s.health === 'starting' ? s.health : null;
  return { name: s.name, isolation: String(s.isolation ?? ''), managed: state !== 'external', container: typeof s.container === 'string' ? s.container : null, state, health, ports };
}

/**
 * GET /api/jobs/:id/environment: the dev server and the backing services. `redact` cleans a failed
 * child's message (it can carry paths) before it reaches the page.
 */
export async function jobEnvironment(root: string, config: Config, job: LoadedJob, redact: (s: string) => string): Promise<JobEnvironmentResponse> {
  const dev = await devStatus(root, config, job);
  let backing: EnvironmentService[] = [];
  let backingError: string | null = null;
  let docker: DockerStateName | null = null;
  let reported: unknown = null;
  // No backing config: nothing to ask Docker, so no child is spawned on every poll.
  if (entriesOrNone(config).length) {
    const r = await forgeJson(root, ['backing', 'status', job.id], STATUS_TIMEOUT_MS);
    if (r.exitCode === 0 && Array.isArray(r.data?.services)) {
      backing = r.data.services.map(toService).filter((s: EnvironmentService | null): s is EnvironmentService => s !== null);
      reported = r.data.docker;
    } else backingError = redact(r.error ?? 'backing status failed');
  }
  // `unknown` is both "Docker is unreachable" and "a container with someone else's labels": `backing status` says which.
  if (backing.some((s) => s.managed && s.state === 'unknown') && (reported === 'ok' || reported === 'missing' || reported === 'stopped')) docker = reported;
  return { job: job.id, active: isActive(job), worktree: Boolean(job.worktree), dev, backing, backingError, docker, at: new Date().toISOString() };
}

/** `1.50%` → 1.5; null for anything else (`--` while a container starts). */
export function parsePercent(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(s);
  return m ? Number(m[1]) : null;
}

const UNITS: Record<string, number> = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4 };

/** `12.5MiB / 7.6GiB` → the bytes in use (the part before the slash); null when unreadable. */
export function parseMemUsage(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const used = s.split('/')[0] ?? '';
  const m = /^\s*(\d+(?:\.\d+)?)\s*([KMGT]?i?B)\s*$/i.exec(used);
  if (!m) return null;
  const unit = UNITS[m[2].toLowerCase()];
  return unit === undefined ? null : Math.round(Number(m[1]) * unit);
}

/** CPU % and RSS bytes per process group, from one `ps` call; empty on Windows or a failure. */
function groupUsage(pgids: Set<number>): Promise<Map<number, EnvironmentUsage>> {
  const out = new Map<number, EnvironmentUsage>();
  if (!pgids.size || process.platform === 'win32') return Promise.resolve(out);
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pgid=,pcpu=,rss='], { timeout: STATUS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }, (e, stdout) => {
      if (e) return resolve(out);
      for (const line of String(stdout).split('\n')) {
        const m = /^\s*(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s*$/.exec(line);
        if (!m || !pgids.has(Number(m[1]))) continue;
        const prev = out.get(Number(m[1])) ?? { cpu: 0, memBytes: 0 };
        out.set(Number(m[1]), { cpu: Math.round(((prev.cpu ?? 0) + Number(m[2])) * 10) / 10, memBytes: (prev.memBytes ?? 0) + Number(m[3]) * 1024 });
      }
      resolve(out);
    });
  });
}

/** The docker state a failed `backing status` reports, from its error code. */
function dockerFromCode(code: string | null): DockerStateName | 'error' {
  if (code === 'docker_missing') return 'missing';
  if (code === 'docker_stopped') return 'stopped';
  return 'error';
}

/**
 * GET /api/environments: one row per job with a live dev pid or a running Forge container labelled with
 * it, and one `job: null` row for the shared containers. CPU and memory come from one `docker stats`
 * call (names only from the label-filtered listing) and one `ps` call.
 */
export async function environmentsSnapshot(root: string, config: Config): Promise<EnvironmentsResponse> {
  let docker: DockerStateName | 'error' = 'ok';
  let containers: { name: string; job: string | null; backing: string }[] = [];
  if (entriesOrNone(config).some(isManaged)) {
    const r = await forgeJson(root, ['backing', 'status'], STATUS_TIMEOUT_MS);
    if (r.exitCode === 0 && Array.isArray(r.data?.containers)) {
      containers = r.data.containers
        .filter((c: any) => c && c.state === 'running' && typeof c.name === 'string' && DOCKER_NAME.test(c.name))
        .map((c: any) => ({ name: c.name, job: typeof c.job === 'string' ? c.job : null, backing: String(c.backing ?? '') }));
    } else docker = dockerFromCode(r.code);
  }
  const stats = new Map<string, EnvironmentUsage>();
  if (containers.length) {
    const r = await dockerRunAsync(['stats', '--no-stream', '--format', '{{json .}}', '--', ...containers.map((c) => c.name)], { timeoutMs: STATUS_TIMEOUT_MS });
    for (const line of r.ok ? r.stdout.split('\n') : []) {
      try {
        const row = JSON.parse(line);
        if (typeof row?.Name === 'string') stats.set(row.Name, { cpu: parsePercent(row.CPUPerc), memBytes: parseMemUsage(row.MemUsage) });
      } catch {}
    }
  }
  const jobs = listJobs(root);
  const devs = new Map<string, { pid: number; port: number | null }>();
  for (const j of jobs) {
    const { pid } = recordedDev(root, j.id);
    if (pid !== null && pidAlive(pid)) devs.set(j.id, { pid, port: devPort(root, config, j) });
  }
  const usage = await groupUsage(new Set([...devs.values()].map((d) => d.pid)));
  const focus = currentFocus(root)?.id ?? null;
  const rows = new Map<string | null, EnvironmentRow>();
  const rowFor = (id: string | null): EnvironmentRow => {
    let row = rows.get(id);
    if (!row) {
      const job = id === null ? undefined : jobs.find((j) => j.id === id);
      row = { job: id, title: id === null ? 'Shared services' : (job?.title ?? id), state: job?.state ?? null, focused: id !== null && id === focus, dev: null, containers: [] };
      rows.set(id, row);
    }
    return row;
  };
  for (const [id, d] of devs) {
    const u = usage.get(d.pid);
    rowFor(id).dev = { pid: d.pid, port: d.port, cpu: u?.cpu ?? null, memBytes: u?.memBytes ?? null };
  }
  for (const c of containers) {
    const u = stats.get(c.name);
    rowFor(c.job).containers.push({ name: c.name, backing: c.backing, cpu: u?.cpu ?? null, memBytes: u?.memBytes ?? null });
  }
  const sorted = [...rows.values()].sort((a, b) => Number(a.job === null) - Number(b.job === null) || Number(b.focused) - Number(a.focused) || a.title.localeCompare(b.title));
  return { docker, rows: sorted, at: new Date().toISOString() };
}
