// Build: open a round, hold it to the round limits, run the builder, then verify.
import { isForemanActor } from '../../jobs.ts';
import { latestSecurityVerdict, pastTotalCeiling, totalRoundCeiling } from '../../foreman.ts';
import type { StepAction, StepInput } from '../../types.ts';
import { park, run, set, spawn, toStage } from '../actions.ts';
import { after, agent, endedIn, human, lastEvent, lastVerify, startedIn } from '../facts.ts';
import { needsInput, stuck } from '../generic.ts';

export function build(x: StepInput): StepAction {
  const j = x.job;
  const b = agent(x, 'builder');
  const rework = human(x, 'rework');
  const lv = lastVerify(x);
  if (j.round === 0 || j.verdicts[String(j.round)] || after(rework?.ts, lastEvent(x, (e) => e.type === 'round')?.ts)) return run(x, 'B1', ['job', 'round', j.id], 'start the next build round');
  // A rework that came after the previous round started is the one that opened this round (B1), so the whole round is exempt. Comparing with the builder's start lost the exemption once the builder ran.
  const previousRound = x.events.filter((e) => e.type === 'round').at(-2)?.ts;
  // The total-round ceiling counts every round, whoever opened it: past it only a person's rework or
  // revise-spec since the previous round started opens this one. The foreman's (CI reworks included) never does.
  const personRework = lastEvent(x, (e) => e.type === 'human' && (e.action === 'rework' || e.action === 'revise-spec') && !isForemanActor(e));
  if (pastTotalCeiling(x.config, j) && !after(personRework?.ts, previousRound)) {
    const ceiling = totalRoundCeiling(x.config, j);
    if (j.kind === 'eval') return set(x, 'B6', { stage: 'decide', state: 'running', reason: `eval: round ${j.round} exceeds the total-round ceiling ${ceiling}` }, 'an eval job has no human to clear rounds-exhausted: grade it');
    return park(x, 'B7', 'rounds-exhausted', `round ${j.round} exceeds the total-round ceiling ${ceiling}: only a human clears it`);
  }
  // Security always has to pass: while the latest security review isn't PASS, rounds run past
  // maxRounds, up to twice it, before the park (where the foreman may only rework or revise).
  const security = latestSecurityVerdict(j);
  const securityOpen = j.kind !== 'eval' && security !== null && security !== 'PASS';
  const limit = securityOpen ? j.maxRounds * 2 : j.maxRounds;
  if (j.round > limit && !after(rework?.ts, previousRound)) {
    if (j.kind === 'eval') return set(x, 'B6', { stage: 'decide', state: 'running', reason: `eval: round ${j.round} exceeds maxRounds ${j.maxRounds}` }, 'an eval job has no human to clear rounds-exhausted: grade it');
    return park(x, 'B2', 'rounds-exhausted', securityOpen ? `round ${j.round} exceeds twice maxRounds ${j.maxRounds} with the security review not PASS` : `round ${j.round} exceeds maxRounds ${j.maxRounds}`);
  }
  if (endedIn(b, j.round)) {
    const n = needsInput(x, 'builder');
    if (n) return n;
  }
  const runs = j.verifyRuns.filter((r) => r.round === j.round);
  const prev = runs.at(-2);
  if (lv && prev && !lv.ok && !prev.ok && lv.failure === 'integrity' && prev.failure === 'integrity' && b?.endedAt && after(b.endedAt, prev.at) && !after(b.endedAt, lv.at)) {
    return park(x, 'B3', 'escalation', 'integrity: verify failed twice on test integrity');
  }
  if (!startedIn(b, j.round) || (lv && !lv.ok && after(lv.at, b?.endedAt)) || after(rework?.ts, b?.startedAt)) return spawn(x, 'B4', 'builder'); // Never resumed: a rework builder is expendable and its brief carries the findings, so it need not drag the last round's context along.
  if (endedIn(b, j.round)) return toStage(x, 'B5', 'verify', 'the builder committed this round');
  return stuck(x);
}
