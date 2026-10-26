// The shapes of the OS service managers and the sleep helper, type-only: a unit's program,
// environment and log, the runner its manager's CLI goes through, and the helper child a test fakes.

/** What a login service runs: an argv with no shell, its environment, its cwd and the file stdout and stderr append to. */
export interface ServiceUnit {
  program: string[];
  env: Record<string, string>;
  workingDirectory: string;
  log: string;
}

/** Runs one service manager command (launchctl, systemctl) without a shell; a test passes a recorder. */
export type ServiceRun = (file: string, args: string[]) => { ok: boolean; status: number | null; stdout: string; stderr: string };

/** The sleep helper's child: what createSleepHold uses of a ChildProcess. */
export interface SleepChild {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  once(ev: 'exit', fn: (code: number | null) => void): unknown;
  once(ev: 'error', fn: (e: Error) => void): unknown;
}

/** Starts the sleep helper: the real spawn in `forge dash` (sleep.ts), a fake in tests. */
export type SleepSpawn = (file: string, args: string[]) => SleepChild;
