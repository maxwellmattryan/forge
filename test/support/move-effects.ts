// A recording stand-in for a move's effects (lib/engine/pipeline/moves/effects.ts): each call is
// recorded with the job it acted on and the transition it saw. Swap it in with useMoveEffects and
// restore it in `finally`; the swap is module-global, so keep such tests out of concurrent blocks.
import type { EnvironmentMode, MoveEffects } from '#engine/pipeline/moves/effects.ts';
import type { Job } from '#core/types.ts';

/** A job's stage, state and waitingOn, as an effect saw it. */
export interface MoveSide {
  stage: string;
  state: string;
  waitingOn: string | null;
}

/** One effect call: `from` is null for the mirror, which sees only the job it mirrors. */
export interface MoveEffectCall {
  effect: 'environment' | 'gate' | 'mirror';
  job: string;
  from: MoveSide | null;
  to: MoveSide;
  mode?: EnvironmentMode;
}

const side = (j: Job): MoveSide => ({ stage: j.stage, state: j.state, waitingOn: j.waitingOn });

/**
 * MoveEffects that record every call in `calls`, then hand it to `delegate` when given one, and
 * otherwise return null (environment, gate) or resolve (mirror).
 */
export function recordingMoveEffects(delegate?: MoveEffects): MoveEffects & { calls: MoveEffectCall[] } {
  const calls: MoveEffectCall[] = [];
  return {
    calls,
    environment(root, config, before, after, mode) {
      calls.push({ effect: 'environment', job: after.id, from: side(before), to: side(after), mode });
      return delegate ? delegate.environment(root, config, before, after, mode) : null;
    },
    gate(root, config, before, after) {
      calls.push({ effect: 'gate', job: after.id, from: side(before), to: side(after) });
      return delegate ? delegate.gate(root, config, before, after) : null;
    },
    async mirror(root, config, job) {
      calls.push({ effect: 'mirror', job: job.id, from: null, to: side(job) });
      if (delegate) await delegate.mirror(root, config, job);
    },
  };
}
