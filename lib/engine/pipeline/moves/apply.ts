// The one move: a locked write of a job's stage, state or waitingOn, then its effects in a fixed
// order (environment, the Foreman's gate request, the tracker mirror), so every caller gets the same
// follow-up whoever moves the job. Notifications follow every transition through setJob's hooks.
import { setJob } from '#core/job/store.ts';
import { currentMoveEffects } from './effects.ts';
import type { EnvironmentMode } from './effects.ts';
import type { EnvironmentDownResult, EnvironmentFinishStopResult } from '../../environment/types.ts';
import type { Config, ForgeRequest, Job, LoadedJob } from '#core/types.ts';

export interface MoveOptions {
  /** A finished job's environment: torn down (default) or only stopped (the inbox and office sessions). */
  environment?: EnvironmentMode;
  /** false only where Forge doesn't hold the issue: a cancel after a failed tracker claim. */
  mirror?: boolean;
  /** Runs after the write and before the effects, which see the job it returns (job set's dependency refresh). */
  afterWrite?: (job: LoadedJob) => LoadedJob;
}

export interface MoveResult {
  job: LoadedJob;
  before: LoadedJob;
  gate: ForgeRequest | null;
  environment: EnvironmentDownResult | EnvironmentFinishStopResult | null;
}

/**
 * Writes `change` with setJob, then runs each effect once against `before`, the job exactly as
 * setJob's lock read it, so a write landing between a caller's own read and this move can neither
 * queue a second gate request nor hide a new park. Resolves once the mirror has finished.
 */
export async function moveJob(root: string, config: Config, id: string, change: Parameters<typeof setJob>[2], opts: MoveOptions = {}): Promise<MoveResult> {
  const { derive } = change;
  // Set inside derive, so `as` keeps the type from narrowing to null.
  let before = null as LoadedJob | null;
  const written = setJob(root, id, {
    ...change,
    // setJob calls derive inside the lock before any mutation, so this is what the write replaced.
    derive: (j) => {
      before = structuredClone(j);
      return derive ? derive(j) : null;
    },
  });
  const after = opts.afterWrite ? opts.afterWrite(written) : written;
  const effects = currentMoveEffects();
  const environment = effects.environment(root, config, before!, after, opts.environment ?? 'teardown');
  const gate = effects.gate(root, config, before!, after);
  if (opts.mirror !== false) await effects.mirror(root, config, after);
  return { job: after, before: before!, gate, environment };
}

/** The mirror effect alone, for a caller that wrote nothing through a move (a dependency release, a delete). */
export async function mirrorJob(root: string, config: Config, job: Job): Promise<void> {
  await currentMoveEffects().mirror(root, config, job);
}
