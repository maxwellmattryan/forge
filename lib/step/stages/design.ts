// Design: the designer writes design.md, the spec-writer folds its spec deltas in, then back to spec.
import type { StepAction, StepInput } from '../../types.ts';
import { spawn, toStage } from '../actions.ts';
import { after, agent, ended } from '../facts.ts';
import { generic, missingOutput } from '../generic.ts';

export function design(x: StepInput): StepAction {
  const d = agent(x, 'designer');
  if (!ended(d)) return spawn(x, 'D1', 'designer');
  const m = missingOutput(x, 'designer');
  if (m) return m;
  const sw = agent(x, 'spec-writer');
  const folding = after(sw?.startedAt, d.endedAt);
  if (x.designDeltas && !folding) return spawn(x, 'D2', 'spec-writer');
  if (folding) {
    const g = generic(x, 'spec-writer');
    if (g) return g;
  }
  return toStage(x, 'D3', 'spec', 'back to the spec gate with the design');
}
