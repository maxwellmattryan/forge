// Transition hooks: what setJob calls once per stage, state or waitingOn change, so a higher layer
// (notify, registered by lib/cli/main.ts at start) can follow every writer without core importing it.
import type { LoadedJob, TransitionSide } from '../types.ts';

/** Called once per stage, state or waitingOn change setJob makes. */
export type TransitionHook = (root: string, job: LoadedJob, from: TransitionSide, to: TransitionSide) => void;

// A Set: the same function registered twice runs once, and iteration keeps registration order.
const hooks = new Set<TransitionHook>();

/** Registers `hook` and returns the function that removes it. */
export function onTransition(hook: TransitionHook): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

/** Calls every hook in registration order. A hook must never fail the state change it observes, nor stop the hooks after it. */
export function runTransitionHooks(root: string, job: LoadedJob, from: TransitionSide, to: TransitionSide): void {
  for (const hook of [...hooks]) {
    try {
      hook(root, job, from, to);
    } catch {}
  }
}
