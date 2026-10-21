// Verify: run the checks, then the repo's verifiers when it has some, then review or back to build.
import { downstreamMembers } from '../../downstream.ts';
import type { StepAction, StepInput } from '../../types.ts';
import { run, spawn, toStage } from '../actions.ts';
import { after, agent, ended, isPrRework, lastVerify, latestVerifiers, outputMissing } from '../facts.ts';

/**
 * VF1–VF3, after a passing verify when the main checkout has verifiers: run them, have the
 * verifier agent answer, then record the answers. A PASS record falls through to V2; a CHANGES
 * record appended a failing verify run, so the caller never gets here for it.
 */
function verifierStep(x: StepInput): StepAction | null {
  if (!x.verifiers) return null;
  const j = x.job;
  const e = latestVerifiers(x);
  if (!e) return run(x, 'VF1', ['verifiers', 'run', j.id], 'check the verified diff against the verifiers');
  if (e.phase !== 'run') return null;
  const a = agent(x, 'verifier');
  if (!a || !after(a.startedAt, e.ts)) return spawn(x, 'VF2', 'verifier');
  if (ended(a) && outputMissing(x, 'verifier') && !a.retry) return spawn(x, 'VF2', 'verifier', { retry: true });
  return run(x, 'VF3', ['verifiers', 'record', j.id], 'record the verifier answers');
}

export function verify(x: StepInput): StepAction {
  const b = agent(x, 'builder');
  const lv = lastVerify(x);
  if (!lv || (b?.endedAt && !after(lv.at, b.endedAt))) return run(x, 'V1', ['verify', x.job.id], `verify the builder's round-${x.job.round} commits`);
  if (lv.ok) {
    const vf = verifierStep(x);
    if (vf) return vf;
  }
  if (lv.ok) return isPrRework(x) && x.config.review.onPrFeedback === 'none' ? toStage(x, 'V2', 'pr', 'verify passed; PR feedback skips review') : toStage(x, 'V2', 'review', 'verify passed');
  // A break only a downstream consumer saw is named against it: the builder fixes the library or proposes the consumer.
  const downstream = downstreamMembers(x.job, x.events);
  const broke = (Array.isArray(lv.repos) ? lv.repos : []).find((r) => !r.ok && downstream.has(r.repo));
  if (broke) {
    const step = typeof broke.failure === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(broke.failure) ? broke.failure : 'a step';
    return toStage(x, 'V3', 'build', `verify failed: downstream consumer ${broke.repo} failed ${step}`);
  }
  return toStage(x, 'V3', 'build', 'verify failed: back to the builder');
}
