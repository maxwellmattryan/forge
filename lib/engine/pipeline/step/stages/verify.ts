// Verify: run the checks, then the repo's verifiers when it has some, then review or back to build.
import { downstreamMembers } from '../../../project/downstream.ts';
import type { JobEvent, VerifyRun } from '#core/types.ts';
import { run, spawn, toStage } from '../actions.ts';
import { after, agent, ended, isPrRework, lastVerify, latestVerifiers, outputMissing } from '../facts.ts';
import { inStage } from '../rules.ts';
import type { Ctx, Table } from '../rules.ts';

interface VerifyCtx extends Ctx {
  lv: VerifyRun | undefined;
  /** This round's latest `verifiers` event newer than its last verify run. */
  e: JobEvent | undefined;
  /** The verify passed, the main checkout has verifiers, and their run waits on the verifier agent's answers. */
  answering: boolean;
  /** A downstream consumer the failing verify names. */
  broke: NonNullable<VerifyRun['repos']>[number] | undefined;
}

function context(c: Ctx): VerifyCtx {
  const { x } = c;
  const lv = lastVerify(x);
  const e = latestVerifiers(x);
  const downstream = downstreamMembers(x.job, x.events);
  const broke = (Array.isArray(lv?.repos) ? lv.repos : []).find((r) => !r.ok && downstream.has(r.repo));
  return { ...c, lv, e, answering: Boolean(lv?.ok && x.verifiers && e?.phase === 'run'), broke };
}

export const VERIFY: Table<VerifyCtx> = {
  name: 'verify',
  applies: inStage('verify'),
  context,
  rules: [
    {
      id: 'V1',
      when: ({ x, lv }) => {
        const b = agent(x, 'builder');
        return !lv || Boolean(b?.endedAt && !after(lv.at, b.endedAt));
      },
      then: ({ x }) => run(x, 'V1', ['verify', x.job.id], `verify the builder's round-${x.job.round} commits`),
    },
    // VF1–VF3, after a passing verify when the main checkout has verifiers: run them, have the
    // verifier agent answer, then record the answers. A PASS record falls through to V2; a CHANGES
    // record appended a failing verify run, so it never gets here.
    { id: 'VF1', when: ({ x, lv, e }) => Boolean(lv?.ok && x.verifiers && !e), then: ({ x }) => run(x, 'VF1', ['verifiers', 'run', x.job.id], 'check the verified diff against the verifiers') },
    {
      id: 'VF2',
      when: ({ x, e, answering }) => {
        const a = agent(x, 'verifier');
        return answering && (!a || !after(a.startedAt, e?.ts));
      },
      then: ({ x }) => spawn(x, 'VF2', 'verifier'),
    },
    {
      id: 'VF2b',
      when: ({ x, answering }) => {
        const a = agent(x, 'verifier');
        return answering && ended(a) && outputMissing(x, 'verifier') && !a.retry;
      },
      then: ({ x }) => spawn(x, 'VF2b', 'verifier', { retry: true }),
    },
    { id: 'VF3', when: (c) => c.answering, then: ({ x }) => run(x, 'VF3', ['verifiers', 'record', x.job.id], 'record the verifier answers') },
    { id: 'V2', when: ({ x, lv }) => Boolean(lv?.ok) && isPrRework(x) && x.config.review.onPrFeedback === 'none', then: ({ x }) => toStage(x, 'V2', 'pr', 'verify passed; PR feedback skips review') },
    { id: 'V2b', when: ({ lv }) => Boolean(lv?.ok), then: ({ x }) => toStage(x, 'V2b', 'review', 'verify passed') },
    // A break only a downstream consumer saw is named against it: the builder fixes the library or proposes the consumer.
    {
      id: 'V3',
      when: (c) => c.broke !== undefined,
      then: ({ x, broke }) => {
        const failed = typeof broke!.failure === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(broke!.failure) ? broke!.failure : 'a step';
        return toStage(x, 'V3', 'build', `verify failed: downstream consumer ${broke!.repo} failed ${failed}`);
      },
    },
    { id: 'V3b', when: () => true, then: ({ x }) => toStage(x, 'V3b', 'build', 'verify failed: back to the builder') },
  ],
};
