// The rule IDs of `forge job step` and the shape of a table row. Types only, so every other
// module under lib/step/ can import it without a cycle.
import type { StepAction } from '../types.ts';

export const RULES = [
  'G1', 'G2', 'G3', 'G4', 'G5', 'L1', 'N1', 'N2', 'M1', 'M2', 'K1', 'K2',
  'I1', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8',
  'P1', 'P2', 'P3', 'P4', 'P5',
  'SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'SP6', 'SP7',
  'D1', 'D2', 'D3',
  'B1', 'B2', 'B3', 'B4', 'B5',
  // An eval job past maxRounds goes to decide to be graded: no human clears rounds-exhausted. Appended, as IDs are stable.
  'B6',
  'V1', 'V2', 'V3',
  // Verifiers between a passing verify and the panel: run, spawn the verifier agent, record its answers.
  'VF1', 'VF2', 'VF3',
  'RV1', 'RV2', 'RV3', 'RV4', 'RV5', 'RV6', 'RV7', 'RV8',
  // Runs first in review, but IDs are stable, so it was appended rather than renumbering the rest.
  'RV9',
  // Rounds 2+ under review.onRework narrow: spawn only the rework panel. Appended, as IDs are stable.
  'RV10',
  'DC1', 'DC2', 'DC3', 'DC4', 'DC5', 'DC6', 'DC7', 'DC8', 'DC9', 'DC10',
  'IG1', 'IG2', 'IG3', 'IG4', 'IG5', 'IG6', 'IG7', 'IG8', 'IG9', 'IG10', 'IG11',
  'PR1', 'PR2', 'PR3', 'PR4', 'PR5',
  // Interim strategies deferred a PR: park on a human canary publish (PR6), reopen (PR7), or wait for a merge (PR8).
  'PR6', 'PR7', 'PR8',
  // A recorded release: verify bumps its consumers (PR9, run before PR2), then an all-released draft
  // consumer leaves draft (PR10, run before PR4). Appended, as IDs are stable.
  'PR9', 'PR10',
  // A secret scan stopped the job: park on `human` (SC1, SC3), or scan again once a human approved (SC2).
  'SC1', 'SC2', 'SC3',
  // Protected paths: park on `human` until a human approves the current content (PP1), or send a
  // refused path back to build (PP2).
  'PP1', 'PP2',
  // Repo proposals: park on `human` while an agent's proposal waits (RP1), then create an approved
  // repo's worktree (RP2). Appended, though they run before the stage rules, as IDs are stable.
  'RP1', 'RP2',
  // Downstream verification: add a changed library's linked consumers as verify-only repos (DS1).
  // Appended, though it runs before the stage rules, as IDs are stable.
  'DS1',
  // A sampled merged job's post-merge score run: wait, spawn the judge, record. Appended, as IDs are stable.
  'JS1', 'JS2', 'JS3',
  // A resumed job whose environment a park stopped: start it again (E1). Appended, though it runs
  // right after G4, as IDs are stable.
  'E1',
  // A pull of the PR's remote branch conflicted after the last verify: park on a human (PR11).
  // Appended, as IDs are stable.
  'PR11',
  // A build round past the total-round ceiling that no person reopened parks for a human (B7, run
  // before B2). Appended, as IDs are stable.
  'B7',
  // No rule matched: a state step can't advance, parked visibly instead of looping.
  'X1',
] as const;

export type RuleId = (typeof RULES)[number];
