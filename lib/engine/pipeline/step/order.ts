// `forge job step`: the one decider of pipeline transitions, the way the CLI is already the one
// writer of state. `step` is pure: it reads a StepInput (everything loadStepInput read once) and
// returns the next action, so the same state always gives the same answer. It never writes; the
// orchestrator runs what it returns.
//
// Precedence is the order below: the tables in TABLES, then the rows within each table. The first
// row whose `when` holds decides, and each row is one transition with its own rule ID.
import type { StepAction, StepInput } from '#core/types.ts';
import { computeFacts } from './facts.ts';
import { DOWNSTREAM, PROPOSALS, PROTECTED, SECRETS } from './gates.ts';
import { X1 } from './generic.ts';
import { GLOBAL, KIND } from './global.ts';
import { firstMatch } from './rules.ts';
import type { Ctx, Table } from './rules.ts';
import { BUILD } from './stages/build.ts';
import { DECIDE } from './stages/decide.ts';
import { DESIGN } from './stages/design.ts';
import { INTAKE } from './stages/intake.ts';
import { INTEGRATE } from './stages/integrate.ts';
import { PLAN } from './stages/plan.ts';
import { PR } from './stages/pr.ts';
import { REVIEW } from './stages/review.ts';
import { SPEC } from './stages/spec.ts';
import { VERIFY } from './stages/verify.ts';

/** Every table, in the order step walks them: global, kind, the gates, the job's stage, then X1. */
export const TABLES: Table<any>[] = [
  GLOBAL,
  KIND,
  SECRETS,
  PROTECTED,
  PROPOSALS,
  DOWNSTREAM,
  INTAKE,
  PLAN,
  SPEC,
  DESIGN,
  BUILD,
  VERIFY,
  REVIEW,
  DECIDE,
  INTEGRATE,
  PR,
  { name: 'fallback', applies: () => true, rules: [X1] },
];

/** The next action for the job. Pure: reads only `x`. */
export function step(x: StepInput): StepAction {
  const base: Ctx = { x, f: computeFacts(x) };
  for (const t of TABLES) {
    if (!t.applies(base)) continue;
    const a = firstMatch(t.rules, t.context ? t.context(base) : base);
    if (a) return a;
  }
  // The fallback table always matches; this only satisfies the type.
  return X1.then(base);
}
