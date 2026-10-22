// GA1–GA11: a gate a logged `human` decision (a person's or the foreman's) answered. Step runs the
// follow-up `forge job set` the human commands used to run by hand, so `forge job human` plus a
// resume is the whole recipe from any session. A decision answers only the park it was given at
// (gateAnswer), and only with an action this table lists for that gate; anything else waits (G4b).
import { isRepoProposalPark } from '../repo-proposals.ts';
import type { StepInput, WaitingOn } from '../core/types.ts';
import { set } from './actions.ts';
import { gateAnswer } from './facts.ts';
import type { Ctx, Rule, RuleId } from './rules.ts';

/** Stages with no build yet: approving or reworking an escalation there would ship or rebuild nothing. */
const PRE_BUILD = ['backlog', 'plan', 'spec', 'design'];

const preBuild = (x: StepInput) => PRE_BUILD.includes(x.job.stage);
const notProposal = (x: StepInput) => !isRepoProposalPark(x.job);

/** A row: the job waits on one of `gates`, `extra` holds, and a decision with one of `actions` answered this park. */
function answered(
  id: RuleId,
  gates: readonly WaitingOn[],
  actions: readonly string[],
  extra: (x: StepInput) => boolean,
  to: { stage?: string },
  then: string,
): Rule {
  return {
    id,
    when: ({ x, f }: Ctx) => x.job.state === 'waiting' && gates.includes(x.job.waitingOn as WaitingOn) && extra(x) && gateAnswer(x, f, actions) !== null,
    then: ({ x, f }: Ctx) => {
      const action = String(gateAnswer(x, f, actions)!.e.action);
      return set(x, id, { stage: to.stage, state: 'running' }, `a recorded ${action} answered the ${x.job.waitingOn} gate: ${then}`);
    },
  };
}

const always = () => true;
const SHIP: readonly WaitingOn[] = ['escalation', 'rounds-exhausted'];

export const ANSWERED: Rule[] = [
  answered('GA1', ['spec-approval'], ['approve-spec'], always, {}, 'build from the approved spec'),
  answered('GA2', SHIP, ['approve'], (x) => !preBuild(x) && x.job.stage !== 'integrate', { stage: 'integrate' }, 'ship it'),
  answered('GA2b', SHIP, ['approve'], (x) => x.job.stage === 'integrate', { stage: 'decide' }, 'decide again'),
  answered('GA3', ['infra'], ['approve'], always, { stage: 'integrate' }, 'the runbook steps are done'),
  answered('GA4', ['conflicts'], ['approve', 'rework'], always, { stage: 'integrate' }, 'the integrator fixes them'),
  answered('GA5', ['issue-link'], ['approve'], always, {}, 'carry on'),
  answered('GA6', ['human'], ['approve'], notProposal, {}, 'run the check again'),
  // RP1 parks again while any proposal is still pending.
  answered('GA6b', ['human'], ['approve-repos', 'reject-repos'], (x) => !notProposal(x), {}, 'carry on with the decided repos'),
  // The repo cap is lifted by a period ack, never an approve; a job budget only once nothing is still over.
  answered('GA7', ['budget'], ['approve'], (x) => !String(x.job.reason ?? '').startsWith('repo budget:') && Array.isArray(x.budgetExceeded) && x.budgetExceeded.length === 0, {}, 'carry on'),
  // Before G3: a person's rework on an open PR moves the job to build before the claim goes.
  answered('GA8', ['escalation', 'rounds-exhausted', 'infra', 'pr-review', 'human'], ['rework'], (x) => !preBuild(x) && notProposal(x), { stage: 'build' }, 'build again with the note'),
  answered('GA9', ['spec-approval', 'escalation', 'rounds-exhausted', 'human'], ['revise-spec'], notProposal, { stage: 'spec' }, 'rewrite the spec with the note'),
  answered('GA10', ['split-approval'], ['approve-split', 'revise-split'], always, { stage: 'plan' }, 'plan again'),
  answered('GA11', ['input'], ['answer'], always, {}, 'resume the agent that asked'),
];
