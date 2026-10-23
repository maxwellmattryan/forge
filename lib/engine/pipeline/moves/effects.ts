// A move's effects behind one seam: the environment a finished job leaves, the Foreman's gate
// request and the tracker mirror. The real adapter is the default without any registration, so a
// process that never registers can't skip a gate request; only tests swap it with useMoveEffects.
import { finishEnvironment, finishEnvironmentStopOnly } from '../../environment/lifecycle.ts';
import { mirrorToTracker } from '../../trackers/mirror.ts';
import { maybeEnqueueGate } from './foreman-gates.ts';
import type { EnvironmentDownResult, EnvironmentFinishStopResult } from '../../environment/types.ts';
import type { Config, ForgeRequest, Job } from '#core/types.ts';

/** A finished job's environment: torn down, or only stopped (the inbox and office sessions). */
export type EnvironmentMode = 'teardown' | 'stop';

/** What a move runs after its write, each against the job before and after it. */
export interface MoveEffects {
  environment(root: string, config: Config, before: Job, after: Job, mode: EnvironmentMode): EnvironmentDownResult | EnvironmentFinishStopResult | null;
  gate(root: string, config: Config, before: Job, after: Job): ForgeRequest | null;
  mirror(root: string, config: Config, job: Job): Promise<void>;
}

export const realMoveEffects: MoveEffects = {
  environment: (root, config, before, after, mode) => (mode === 'stop' ? finishEnvironmentStopOnly(root, config, before, after) : finishEnvironment(root, config, before, after)),
  gate: (root, config, before, after) => maybeEnqueueGate(root, config, before, after),
  mirror: (root, config, job) => mirrorToTracker(root, config, job),
};

let current: MoveEffects = realMoveEffects;

/** The effects moveJob runs now. */
export const currentMoveEffects = (): MoveEffects => current;

/** Swaps in `effects` (tests only) and returns the function that restores the previous ones. */
export function useMoveEffects(effects: MoveEffects): () => void {
  const previous = current;
  current = effects;
  return () => {
    current = previous;
  };
}
