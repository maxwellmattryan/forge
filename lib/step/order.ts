// `forge job step`: the one decider of pipeline transitions, the way the CLI is already the one
// writer of state. `step` is pure: it reads a StepInput (everything loadStepInput read once) and
// returns the next action, so the same state always gives the same answer and every rule is a
// table row in test/step.test.ts. It never writes; the orchestrator runs what it returns.
import type { StepAction, StepInput } from '../types.ts';
import { computeFacts } from './facts.ts';
import { downstreamGate, protectedGate, repoProposalGate, secretGate } from './gates.ts';
import { stuck } from './generic.ts';
import { globalStep, kindStep } from './global.ts';
import { build } from './stages/build.ts';
import { decideStage } from './stages/decide.ts';
import { design } from './stages/design.ts';
import { intake } from './stages/intake.ts';
import { integrate } from './stages/integrate.ts';
import { plan } from './stages/plan.ts';
import { pr } from './stages/pr.ts';
import { review } from './stages/review.ts';
import { spec } from './stages/spec.ts';
import { verify } from './stages/verify.ts';

/** The next action for the job. Pure: reads only `x`. */
export function step(x: StepInput): StepAction {
  const f = computeFacts(x);
  const g = globalStep(x, f) ?? kindStep(x) ?? secretGate(x) ?? protectedGate(x) ?? repoProposalGate(x) ?? downstreamGate(x);
  if (g) return g;
  switch (x.job.stage) {
    case 'backlog':
      return intake(x);
    case 'plan':
      return plan(x);
    case 'spec':
      return spec(x);
    case 'design':
      return design(x);
    case 'build':
      return build(x);
    case 'verify':
      return verify(x);
    case 'review':
      return review(x);
    case 'decide':
      return decideStage(x, f);
    case 'integrate':
      return integrate(x, f);
    case 'pr':
      return pr(x);
  }
  return stuck(x);
}
