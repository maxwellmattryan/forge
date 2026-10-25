// The permission modes `forge dash`'s pool holds for its sessions: a human's choice per scope, and
// the default for job sessions without one. In memory on purpose: a session can write files in the
// repo, runtime records included, so a mode read back from disk would be one the session could pick
// for itself.
import { INBOX_SCOPE, OFFICE_SCOPE } from '#core/job/requests.ts';
import { PERMISSION_MODES, commandPermissionMode } from '#integrations/claude/argv.ts';
import type { DaemonOptions } from './session/contract.ts';
import type { MachineSlots } from './slots.ts';
import type { DaemonPermissionMode, DaemonPoolState } from '#core/types.ts';

/**
 * createPool's options. `jobPermissionMode` is `forge dash --permission-mode`: the human's own command line.
 * `slots` is the machine dashboard's slot gate (./slots.ts), shared by every project's pool.
 */
export type PoolOptions = DaemonOptions & { jobPermissionMode?: DaemonPermissionMode | null; slots?: MachineSlots };

export interface ModeBook {
  /** Re-reads daemon.command's mode, the one a scope runs in when nobody chose another. */
  setCommand(template: unknown): void;
  /** The mode a spawn of `scope` gets: its own choice, else the job default for a job; null keeps daemon.command's. */
  launch(scope: string): DaemonPermissionMode | null;
  /** Whether a human chose a mode for this one scope. */
  chosen(scope: string): boolean;
  /** Records a human's choice for one scope; one equal to what it would run in anyway holds no entry, so it follows a later default. */
  choose(scope: string, mode: DaemonPermissionMode): void;
  /** Records the job sessions' default; daemon.command's own mode clears it. */
  chooseJobs(mode: DaemonPermissionMode): void;
  /** claude refused a switch to `mode` and still reports `live`: show what the session is really in. */
  refused(scope: string, mode: DaemonPermissionMode, live: string | null): void;
  state(): Pick<DaemonPoolState, 'permissionMode' | 'permissionModes' | 'jobPermissionMode'>;
}

export function createModeBook(jobDefault: DaemonPermissionMode | null = null): ModeBook {
  const modes = new Map<string, DaemonPermissionMode>();
  let base = 'default';
  let jobs: DaemonPermissionMode | null = PERMISSION_MODES.find((m) => m === jobDefault) ?? null;
  const shared = (scope: string) => scope === INBOX_SCOPE || scope === OFFICE_SCOPE;
  /** What a scope runs in without its own choice. */
  const fallback = (scope: string): string => (shared(scope) ? base : (jobs ?? base));
  return {
    setCommand(template) {
      base = commandPermissionMode(template);
    },
    launch: (scope) => modes.get(scope) ?? (shared(scope) ? null : jobs),
    chosen: (scope) => modes.has(scope),
    choose(scope, mode) {
      if (mode === fallback(scope)) modes.delete(scope);
      else modes.set(scope, mode);
    },
    chooseJobs(mode) {
      jobs = mode === base ? null : mode;
    },
    refused(scope, mode, live) {
      // The refused choice may be the scope's fallback, which holds no entry; a later choice wins.
      if ((modes.get(scope) ?? fallback(scope)) !== mode) return;
      const kept = PERMISSION_MODES.find((m) => m === live);
      if (kept && kept !== fallback(scope)) modes.set(scope, kept);
      else modes.delete(scope);
    },
    state: () => ({
      permissionMode: base,
      permissionModes: Object.fromEntries([...modes].sort(([a], [b]) => (a < b ? -1 : 1))),
      jobPermissionMode: jobs,
    }),
  };
}
