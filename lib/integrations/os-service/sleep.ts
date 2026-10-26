// The machine's sleep assertion: caffeinate on macOS and systemd-inhibit on Linux, held by one helper
// child that exits on its own when the dashboard's pid dies, so a SIGKILLed dashboard leaves nothing
// behind. Its argv is fixed strings and that pid: no config or job text reaches it.
import { spawn } from 'node:child_process';
import type { SleepChild, SleepSpawn } from './types.ts';

/** How long a helper that failed to start or exited on its own waits before it is tried again. */
export const SLEEP_RETRY_MS = 60_000;

/** The helper's argv for `platform`, waiting on `pid`; null where Forge has none (Windows, the BSDs) or for a bad pid. */
export function sleepHoldCommand(platform: NodeJS.Platform, pid: number): string[] | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  if (platform === 'darwin') return ['caffeinate', '-i', '-w', String(pid)];
  if (platform === 'linux')
    return ['systemd-inhibit', '--what=idle:sleep', '--who=Forge', '--why=Forge has a mandate or job in flight', '--mode=block', 'tail', `--pid=${pid}`, '-f', '/dev/null'];
  return null;
}

/** What a hold reports: whether its helper runs, since when, and why the last one failed. */
export interface SleepHoldState {
  held: boolean;
  since: string | null;
  error: string | null;
}

export interface SleepHold {
  /** true: start the helper unless it runs or failed under `retryMs` ago; false: stop it. Never throws. */
  set(hold: boolean): void;
  state(): SleepHoldState;
  /** Stops the helper for good: a later set(true) does nothing. */
  release(): void;
  /** release() for a process `exit` handler: the kill is synchronous already. */
  killSync(): void;
}

/** One sleep assertion over `command`, started through `spawn`; `now` and `retryMs` are test seams. */
export function createSleepHold(opts: { command: string[]; spawn: SleepSpawn; now?: () => number; retryMs?: number }): SleepHold {
  const now = opts.now ?? Date.now;
  const retryMs = opts.retryMs ?? SLEEP_RETRY_MS;
  const [file, ...args] = opts.command;
  let child: SleepChild | null = null;
  let since: string | null = null;
  let error: string | null = null;
  /** The last failure, kept across set(false) so a retry still waits out its delay. */
  let failed: { at: number; error: string } | null = null;
  let released = false;

  const fail = (c: SleepChild, why: string): void => {
    if (child !== c) return;
    child = null;
    since = null;
    error = why;
    failed = { at: now(), error: why };
  };

  const stop = (): void => {
    const c = child;
    child = null;
    since = null;
    if (!c) return;
    try {
      c.kill('SIGTERM');
    } catch {}
  };

  return {
    set(hold) {
      if (!hold || released) {
        stop();
        error = null;
        return;
      }
      if (child) return;
      if (failed && now() - failed.at < retryMs) {
        error = failed.error;
        return;
      }
      let c: SleepChild;
      try {
        c = opts.spawn(file!, args);
      } catch (e) {
        const why = `${file} failed to start: ${(e as Error).message}`;
        error = why;
        failed = { at: now(), error: why };
        return;
      }
      child = c;
      since = new Date(now()).toISOString();
      error = null;
      failed = null;
      c.once('error', (e) => fail(c, `${file} failed to start: ${e.message}`));
      c.once('exit', (code) => fail(c, `${file} exited${code === null ? '' : ` with code ${code}`}`));
    },
    state: () => ({ held: child !== null, since, error }),
    release() {
      released = true;
      stop();
    },
    killSync() {
      released = true;
      stop();
    },
  };
}

/**
 * The real helper: not detached, so it stays in the dashboard's process group, with stdio ignored and
 * `/` as its cwd, outside every repo. Only `forge dash` (lib/cli/commands/dash.ts) passes it.
 */
export const spawnSleepHelper: SleepSpawn = (file, args) => spawn(file, args, { stdio: 'ignore', cwd: '/' });
