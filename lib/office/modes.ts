// The permission modes `forge dash`'s pool holds for its sessions: a human's choice per scope, the run's
// launch mode (`forge dash --permission-mode`) that the job and inbox sessions start in, and the
// default for job sessions, which starts at the launch mode and only the popover moves. A chat launches in
// `default` (it asks) unless its owner chose otherwise, whatever daemon.command or the launch mode say. In
// memory on purpose: a session can write files in the repo, runtime records included, so a mode read back
// from disk would be one the session could pick for itself.
import { isChatScope, sharedScope as shared } from '#core/job/requests.ts';
import { PERMISSION_MODES, commandPermissionMode } from '#integrations/claude/argv.ts';
import type { DaemonOptions } from './session/contract.ts';
import type { MachineSlots } from './slots.ts';
import type { DaemonPermissionMode, DaemonPoolState } from '#core/types.ts';

/**
 * createPool's options. `launchPermissionMode` is `forge dash --permission-mode`, the human's own command line:
 * the run's launch mode, which every job and inbox session starts in unless a human chose another for it.
 * `slots` is the machine dashboard's slot gate (./slots.ts), shared by every project's pool. `runPass`
 * stands in for the Office pass child (./sync-child.ts runPassChild), as `runSync` does for sync's; its signal
 * aborts when the pool closes, and close() waits for its promise.
 */
export type PoolOptions = DaemonOptions & { launchPermissionMode?: DaemonPermissionMode | null; slots?: MachineSlots; runPass?: (root: string, signal: AbortSignal) => Promise<string | null> };

export interface ModeBook {
  /** Re-reads daemon.command's mode, the one a scope runs in when nobody chose another and the run has no launch mode. */
  setCommand(template: unknown): void;
  /**
   * The mode a spawn of `scope` gets: its own choice, else `default` for a chat, else the launch mode for the inbox
   * and office, else the job default for a job; null keeps daemon.command's.
   */
  launch(scope: string): DaemonPermissionMode | null;
  /** Whether a human chose a mode for this one scope. */
  chosen(scope: string): boolean;
  /** Records a human's choice for one scope; one equal to what it would run in anyway holds no entry, so it follows a later default. */
  choose(scope: string, mode: DaemonPermissionMode): void;
  /** Records the job sessions' default (job sessions only, never the inbox, office or a chat); daemon.command's own mode clears it. */
  chooseJobs(mode: DaemonPermissionMode): void;
  /** claude refused a switch to `mode` and still reports `live`: show what the session is really in. */
  refused(scope: string, mode: DaemonPermissionMode, live: string | null): void;
  state(): Pick<DaemonPoolState, 'permissionMode' | 'permissionModes' | 'jobPermissionMode' | 'launchPermissionMode'>;
}

export function createModeBook(launchMode: DaemonPermissionMode | null = null): ModeBook {
  const modes = new Map<string, DaemonPermissionMode>();
  let base = 'default';
  const launch: DaemonPermissionMode | null = PERMISSION_MODES.find((m) => m === launchMode) ?? null;
  // The launch mode is only the job default's starting value: the popover's explicit choice replaces it.
  let jobs: DaemonPermissionMode | null = launch;
  /** What a scope runs in without its own choice. */
  const fallback = (scope: string): string => (isChatScope(scope) ? 'default' : shared(scope) ? (launch ?? base) : (jobs ?? base));
  return {
    setCommand(template) {
      base = commandPermissionMode(template);
    },
    launch: (scope) => modes.get(scope) ?? (isChatScope(scope) ? 'default' : shared(scope) ? launch : jobs),
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
      launchPermissionMode: launch,
    }),
  };
}
