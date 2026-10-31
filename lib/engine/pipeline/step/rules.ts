// The rule IDs of `forge job step` and the shape of its tables. Imports types only, so every other
// module under lib/engine/pipeline/step/ can import it without a cycle.
import type { StepAction, StepInput } from '../types.ts';
import type { Facts } from './facts.ts';

/** One ID per transition. A variant of a rule keeps its family's ID with a letter suffix. */
export const RULES = [
  // Global: a finished, failed or parked job, running agents, a lost run, a stopped environment.
  'G1', 'G2', 'G3', 'G3b', 'G3c', 'G4', 'G4b', 'E1', 'G5', 'L1',
  // A gate a logged human or foreman decision answered: run its follow-up job set.
  'GA1', 'GA2', 'GA2b', 'GA3', 'GA4', 'GA5', 'GA6', 'GA6b', 'GA7', 'GA8', 'GA9', 'GA10', 'GA11',
  // A sampled merged job's post-merge score run: spawn the judge, wait, record.
  'JS1', 'JS2', 'JS3',
  // Per role, in any stage: an agent replied NEEDS-INPUT (N), or ended without its output (M).
  'N1', 'N1b', 'N2', 'M1', 'M2',
  // Per role: an agent replied NEEDS-PERMISSION after one of its prompts timed out (NP).
  'NP1', 'NP1b',
  // A retro job starts with its worktree, prepare, the digests and the retro agent, and ends when the retro proposes nothing.
  'K1b', 'K1c', 'K1d', 'K1', 'K1e', 'K2',
  // Gates before the stage rules: secret scan, protected paths, repo proposals, downstream consumers.
  'SC1', 'SC1b', 'SC2', 'SC3', 'SC3b',
  'PP1', 'PP2', 'PP2b',
  'RP1', 'RP2',
  'DS1',
  // I6–I6d: an adopted PR is synced, then parked for a person (closed), integrated (behind or conflicting) or reviewed.
  'I1', 'I3', 'I4', 'I5', 'I6', 'I6b', 'I6c', 'I6d', 'I7', 'I8',
  'P1', 'P2', 'P2b', 'P3', 'P4', 'P5',
  'SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'SP6', 'SP7',
  // The spec-writer's split check proposed a split: on to the planner.
  'SP8',
  'D1', 'D2', 'D3',
  'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B6b', 'B7', 'B8',
  'V1', 'V2', 'V2b', 'V3', 'V3b',
  // Verifiers between a passing verify and the panel: run, spawn the verifier agent, record its answers.
  'VF1', 'VF2', 'VF2b', 'VF3',
  'RV1', 'RV2', 'RV3', 'RV4', 'RV5', 'RV5b', 'RV6', 'RV7', 'RV8', 'RV8b', 'RV8c', 'RV8d', 'RV9', 'RV10', 'RV11',
  'DC1', 'DC2', 'DC3', 'DC4', 'DC5', 'DC6', 'DC9', 'DC9b', 'DC10', 'DC11',
  // The gate reasons, once per review, before the approver (PR19 computes them in pr for a job decided without them).
  'DC12',
  // The recall eval before the approver when the diff changes reviewer prompts.
  'RC1',
  // A clean pass (approver.skipWhenClean): Forge records the APPROVE without the approver.
  'DC13',
  'IG1', 'IG2', 'IG2b', 'IG3', 'IG4', 'IG5', 'IG6', 'IG7', 'IG7b', 'IG8', 'IG9', 'IG10', 'IG10b', 'IG10c', 'IG11', 'IG12', 'IG13',
  'PR1', 'PR2', 'PR2b', 'PR3', 'PR4', 'PR5', 'PR6', 'PR7', 'PR8', 'PR9', 'PR9b', 'PR9c', 'PR10', 'PR11', 'PR12',
  // The held push (PR13), the merge gates on the open PR (PR15: the one escalation park, PR17: the recall eval), what
  // the PR says of them (PR14, PR18), the gate reasons of a job decided without them (PR19), and the merge queue's
  // hold behind a ready PR ranked ahead in the mandate's overlap group (PR20).
  'PR13', 'PR14', 'PR15', 'PR17', 'PR18', 'PR19', 'PR20',
  // No rule matched: a state step can't advance, parked visibly instead of looping.
  'X1',
] as const;

export type RuleId = (typeof RULES)[number];

/** What every row reads: the input, and the facts computed from it once per step. */
export interface Ctx {
  x: StepInput;
  f: Facts;
}

/** One transition: the first row whose `when` holds decides, and `then` builds its one action. */
export interface Rule<C = Ctx> {
  id: RuleId;
  when: (c: C) => boolean;
  then: (c: C) => StepAction;
}

/** The context of a shared per-role row: the role it runs for at this position. */
export interface RoleCtx extends Ctx {
  role: string;
  retryLine?: string;
}

/** Shared per-role rows (N, M) at one position of a table, for the role `role` picks; null skips them. */
export interface RoleRows<C = Ctx> {
  role: (c: C) => string | null;
  retryLine?: (c: C) => string | undefined;
  rows: readonly Rule<RoleCtx>[];
}

export type Row<C = Ctx> = Rule<C> | RoleRows<C>;

/** A stage's (or a gate's) rows, in precedence order; `context` adds values its rows share, computed once. */
export interface Table<C extends Ctx = Ctx> {
  name: string;
  applies: (c: Ctx) => boolean;
  context?: (c: Ctx) => C;
  rules: readonly Row<C>[];
}

const isGroup = <C>(r: Row<C>): r is RoleRows<C> => 'rows' in r;

/** The first row in list order whose `when` holds, as its action; null when none does. */
export function firstMatch<C extends Ctx>(rows: readonly Row<C>[], c: C): StepAction | null {
  for (const r of rows) {
    if (isGroup(r)) {
      const role = r.role(c);
      if (role === null) continue;
      const a = firstMatch(r.rows, { x: c.x, f: c.f, role, retryLine: r.retryLine?.(c) });
      if (a) return a;
    } else if (r.when(c)) return r.then(c);
  }
  return null;
}

/** A table's rows in evaluation order, shared per-role rows expanded where they run. */
export const flatRows = (rows: readonly Row<any>[]): Rule<any>[] => rows.flatMap((r) => (isGroup(r) ? [...r.rows] : [r]));

/** A table that applies in one stage. */
export const inStage = (stage: string) => (c: Ctx) => c.x.job.stage === stage;
