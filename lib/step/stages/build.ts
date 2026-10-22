// Build: open a round, hold it to the round limits, run the builder, then verify.
import { latestSecurityVerdict, pastTotalCeiling, totalRoundCeiling } from '../../foreman.ts';
import { isForemanActor } from '../../core/job/store.ts';
import type { JobAgent, JobEvent, VerifyRun } from '../../core/types.ts';
import { park, run, set, spawn, toStage } from '../actions.ts';
import { after, afterIdx, agent, endedIn, lastIdx, lastVerify, startedIn } from '../facts.ts';
import { needsInputRows } from '../generic.ts';
import { inStage } from '../rules.ts';
import type { Ctx, Table } from '../rules.ts';

interface BuildCtx extends Ctx {
  b: JobAgent | undefined;
  lv: VerifyRun | undefined;
  /** The last human rework, any actor. */
  reworkAt: number;
  rework: JobEvent | undefined;
  rounds: number[];
  /** Past the total-round ceiling, and no person's rework or revise-spec since the previous round started. */
  overCeiling: boolean;
  /** Past maxRounds (twice it while the security review isn't PASS), and no rework since the previous round started. */
  overLimit: boolean;
  securityOpen: boolean;
}

function context(c: Ctx): BuildCtx {
  const { x } = c;
  const j = x.job;
  const reworkAt = lastIdx(x, (e) => e.type === 'human' && e.action === 'rework');
  const rounds = x.events.flatMap((e, i) => (e.type === 'round' ? [i] : []));
  // A rework that came after the previous round started is the one that opened this round (B1), so the whole round is exempt. Comparing with the builder's start lost the exemption once the builder ran.
  const previousRound = rounds.at(-2) ?? null;
  // The total-round ceiling counts every round, whoever opened it: past it only a person's rework or
  // revise-spec since the previous round started opens this one. The foreman's (CI reworks included) never does.
  const personRework = lastIdx(x, (e) => e.type === 'human' && (e.action === 'rework' || e.action === 'revise-spec') && !isForemanActor(e));
  // Security always has to pass: while the latest security review isn't PASS, rounds run past
  // maxRounds, up to twice it, before the park (where the foreman may only rework or revise).
  const security = latestSecurityVerdict(j);
  const securityOpen = j.kind !== 'eval' && security !== null && security !== 'PASS';
  const limit = securityOpen ? j.maxRounds * 2 : j.maxRounds;
  return {
    ...c,
    b: agent(x, 'builder'),
    lv: lastVerify(x),
    reworkAt,
    rework: x.events[reworkAt],
    rounds,
    overCeiling: pastTotalCeiling(x.config, j) && !afterIdx(personRework, previousRound),
    overLimit: j.round > limit && !afterIdx(reworkAt, previousRound),
    securityOpen,
  };
}

const ROUNDS_WHY = 'an eval job has no human to clear rounds-exhausted: grade it';

/** Verify failed twice on test integrity around one builder run. */
function integrityTwice({ x, b, lv }: BuildCtx): boolean {
  const prev = x.job.verifyRuns.filter((r) => r.round === x.job.round).at(-2);
  return Boolean(lv && prev && !lv.ok && !prev.ok && lv.failure === 'integrity' && prev.failure === 'integrity' && b?.endedAt && after(b.endedAt, prev.at) && !after(b.endedAt, lv.at));
}

export const BUILD: Table<BuildCtx> = {
  name: 'build',
  applies: inStage('build'),
  context,
  rules: [
    { id: 'B1', when: ({ x, reworkAt, rounds }) => x.job.round === 0 || Boolean(x.job.verdicts[String(x.job.round)]) || afterIdx(reworkAt, rounds.at(-1) ?? null), then: ({ x }) => run(x, 'B1', ['job', 'round', x.job.id], 'start the next build round') },
    {
      id: 'B6',
      when: (c) => c.overCeiling && c.x.job.kind === 'eval',
      then: ({ x }) => set(x, 'B6', { stage: 'decide', state: 'running', reason: `eval: round ${x.job.round} exceeds the total-round ceiling ${totalRoundCeiling(x.config, x.job)}` }, ROUNDS_WHY),
    },
    { id: 'B7', when: (c) => c.overCeiling, then: ({ x }) => park(x, 'B7', 'rounds-exhausted', `round ${x.job.round} exceeds the total-round ceiling ${totalRoundCeiling(x.config, x.job)}: only a human clears it`) },
    { id: 'B6b', when: (c) => c.overLimit && c.x.job.kind === 'eval', then: ({ x }) => set(x, 'B6b', { stage: 'decide', state: 'running', reason: `eval: round ${x.job.round} exceeds maxRounds ${x.job.maxRounds}` }, ROUNDS_WHY) },
    {
      id: 'B2',
      when: (c) => c.overLimit,
      then: ({ x, securityOpen }) => {
        const j = x.job;
        return park(x, 'B2', 'rounds-exhausted', securityOpen ? `round ${j.round} exceeds twice maxRounds ${j.maxRounds} with the security review not PASS` : `round ${j.round} exceeds maxRounds ${j.maxRounds}`);
      },
    },
    needsInputRows<BuildCtx>((c) => (endedIn(c.b, c.x.job.round) ? 'builder' : null)),
    { id: 'B3', when: integrityTwice, then: ({ x }) => park(x, 'B3', 'escalation', 'integrity: verify failed twice on test integrity') },
    // Never resumed: a rework builder is expendable and its brief carries the findings, so it need not drag the last round's context along.
    {
      id: 'B4',
      when: ({ x, b, lv, rework }) => !startedIn(b, x.job.round) || Boolean(lv && !lv.ok && after(lv.at, b?.endedAt)) || after(rework?.ts, b?.startedAt),
      then: ({ x }) => spawn(x, 'B4', 'builder'),
    },
    { id: 'B5', when: ({ x, b }) => endedIn(b, x.job.round), then: ({ x }) => toStage(x, 'B5', 'verify', 'the builder committed this round') },
  ],
};
