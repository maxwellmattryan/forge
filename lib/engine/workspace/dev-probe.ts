// The dev server's process proof: whether a recorded pid is the dev server Forge started for this
// job, read through a probe that tests replace.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '#core/os/process.ts';

/** How far the process's start time may be from runtime.json's `startedAt` (ps reports whole seconds). */
const DEV_START_SLACK_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

/** One process's group, whether it has a controlling terminal, and its start time (ms). */
export interface ProbeRow {
  pgid: number;
  tty: boolean;
  started: number;
}

/** What ownDevProcess asks of the OS: `systemProbe` in production, a plain object in tests. */
export interface ProcessProbe {
  platform: NodeJS.Platform;
  /** `ps -o pgid= -o tty= -o lstart=` for the pid, parsed by parseDevProbe; null when there is no row. */
  row(pid: number): ProbeRow | null;
  /** Our own process group, or null when it can't be read. */
  ownGroup(): number | null;
  /** The process's working directory, or null when it can't be read (no /proc, no lsof, not ours to inspect). */
  cwd(pid: number): string | null;
}

/**
 * One `ps -o pgid= -o tty= -o lstart=` row: the process group, whether the process has a controlling
 * terminal (`?` on Linux and `??` on macOS mean none), and its start time; null for anything else.
 */
export function parseDevProbe(stdout: string): ProbeRow | null {
  const m = /^\s*(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s*$/.exec(stdout.trim());
  if (!m) return null;
  const started = Date.parse(m[3]);
  return Number.isFinite(started) ? { pgid: Number(m[1]), tty: !/^\?+$/.test(m[2]), started } : null;
}

const psEnv = () => ({ ...process.env, LC_ALL: 'C' });

/** The probe over the real OS: ps, plus `/proc` on Linux and lsof on macOS for the working directory. */
export const systemProbe: ProcessProbe = {
  platform: process.platform,
  row(pid) {
    const ps = run('ps', ['-o', 'pgid=', '-o', 'tty=', '-o', 'lstart=', '-p', String(pid)], { allowFail: true, env: psEnv(), timeoutMs: PROBE_TIMEOUT_MS });
    return ps.ok ? parseDevProbe(ps.stdout) : null;
  },
  ownGroup() {
    const own = run('ps', ['-o', 'pgid=', '-p', String(process.pid)], { allowFail: true, env: psEnv(), timeoutMs: PROBE_TIMEOUT_MS });
    return own.ok ? Number(own.stdout.trim()) : null;
  },
  cwd(pid) {
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
  },
};

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
export function ownDevProcess(worktree: string, rec: unknown, probe: ProcessProbe = systemProbe): boolean {
  if (probe.platform === 'win32' || !rec || typeof rec !== 'object') return false;
  const { pid, startedAt } = rec as { pid?: unknown; startedAt?: unknown };
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  const recorded = typeof startedAt === 'string' ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(recorded)) return false;
  const row = probe.row(pid);
  if (!row || row.pgid !== pid || row.tty) return false;
  const own = probe.ownGroup();
  if (own === null || own === pid) return false;
  if (Math.abs(row.started - recorded) > DEV_START_SLACK_MS) return false;
  const cwd = probe.cwd(pid);
  if (!cwd) return false;
  const base = realpath(worktree);
  const real = realpath(cwd);
  return real === base || real.startsWith(base + path.sep);
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
