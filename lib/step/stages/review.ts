// Review: pick the panel, write the scope report, run the lenses, record their verdicts, move on.
import path from 'node:path';
import { lensNeedsApp } from '../../config.ts';
import { reviewFileName } from '../../lens.ts';
import type { StepAction, StepInput } from '../../types.ts';
import { run, spawn, toStage } from '../actions.ts';
import { after, agent, endedIn, isPrRework, lastVerify, outputMissing, startedIn } from '../facts.ts';
import { missingOutput, stuck } from '../generic.ts';
import { currentRerun, roundLenses } from '../panel.ts';

/** RV4: every lens of this round whose reviewer has not started yet, in panel order; none once the round's verdicts are recorded. */
export function nextLenses(x: StepInput): string[] {
  if (x.job.verdicts[String(x.job.round)]) return [];
  return roundLenses(x.job, x.config, currentRerun(x)).filter((l) => !startedIn(agent(x, `reviewer:${l}`), x.job.round));
}

/** M1 in the review stage: the first lens of this round whose reviewer ended without its review and has not had its retry; none once the round's verdicts are recorded. */
export function retryLens(x: StepInput): string | null {
  const j = x.job;
  if (j.verdicts[String(j.round)]) return null;
  return roundLenses(j, x.config, currentRerun(x)).find((l) => {
    const a = agent(x, `reviewer:${l}`);
    // outputMissing(), not a.outputMissing: a pre-v6 record falls back to the MISSING verdict.
    return endedIn(a, j.round) && !a.retry && outputMissing(x, `reviewer:${l}`);
  }) ?? null;
}

export function review(x: StepInput): StepAction {
  const j = x.job;
  const lv = lastVerify(x);
  // Once per round, after verify and before any reviewer starts, so the panel matches the diff the
  // reviewers read. A PR rework under `changed` or `none` keeps its always-only or skip rule.
  const prSkip = isPrRework(x) && x.config.review.onPrFeedback !== 'full';
  const panelled = x.events.some((e) => e.type === 'panel' && e.round === j.round && after(e.ts, lv?.at));
  const reviewing = Object.keys(j.agents).some((k) => k.startsWith('reviewer:') && startedIn(j.agents[k], j.round));
  if (!prSkip && !panelled && !reviewing && !j.verdicts[String(j.round)]) return run(x, 'RV9', ['job', 'panel', j.id], "pick this round's lenses from the diff");
  const rerun = currentRerun(x);
  const lenses = roundLenses(j, x.config, rerun);
  if (!lenses.length) return toStage(x, 'RV1', 'pr', 'no lens reviews this round');
  if (!x.events.some((e) => e.type === 'scope' && e.round === j.round && after(e.ts, lv?.at))) return run(x, 'RV2', ['job', 'scope', j.id], 'reviewers read the scope report');
  // Only until the round's verdicts are recorded: after that RV7 stops the server, and starting it
  // again here would alternate with that stop forever. Retries before then still get the app.
  const recordedVerdicts = Boolean(j.verdicts[String(j.round)]);
  if (!recordedVerdicts && lenses.some((l) => lensNeedsApp(x.config, l)) && x.config.commands.dev && !x.runtime.includes('dev')) return run(x, 'RV3', ['run', j.id, 'dev', '--background'], 'app-needing lenses review the running app');
  // The whole remaining panel in one action so the orchestrator launches it in one message. Each
  // lens is still recorded by its own `agent start`, so a re-step never lists a started lens.
  const [first, ...rest] = nextLenses(x);
  if (first) {
    const rule = rerun ? 'RV10' : 'RV4';
    const a = spawn(x, rule, `reviewer:${first}`);
    const why = rerun ? { why: 'rework round: re-review the lenses that asked for changes, the always lenses and the lenses whose paths the fix touched' } : {};
    return rest.length ? { ...a, ...why, spawns: rest.map((l) => spawn(x, rule, `reviewer:${l}`)) } : { ...a, ...why };
  }
  // Retries go out back to back like first spawns, even while other reviewers run (G5 lets them through).
  const retry = retryLens(x);
  if (retry) return missingOutput(x, `reviewer:${retry}`)!;
  for (const l of lenses) {
    const m = missingOutput(x, `reviewer:${l}`);
    if (m) return m;
  }
  const differs = lenses.join(',') !== j.reviewers.join(',');
  const verdictsCmd = (extra: string[]) => ['job', 'verdicts', j.id, '--compact', ...extra, ...(differs ? ['--reviewers', lenses.join(',')] : [])];
  const v = x.verdicts.round;
  const malformed = lenses.filter((l) => v?.reviewers[l]?.verdict === 'MALFORMED');
  if (malformed.length && !j.verdicts[String(j.round)]) {
    const fresh = malformed.find((l) => !agent(x, `reviewer:${l}`)?.retry);
    if (fresh) {
      const file = path.join(x.jobDir, 'review', `round-${j.round}`, reviewFileName(fresh));
      return spawn(x, 'RV5', `reviewer:${fresh}`, { retry: true, retryLine: `Retry: ${file} has no VERDICT line; rewrite it in the required format.` });
    }
    return run(x, 'RV5', verdictsCmd(['--malformed', 'changes']), 'a lens failed the review format twice: count it as CHANGES');
  }
  if (!j.verdicts[String(j.round)]) {
    if (v?.complete) return run(x, 'RV6', verdictsCmd([]), 'record this round\'s verdicts');
    return stuck(x);
  }
  if (x.runtime.length) return run(x, 'RV7', ['stop', j.id], 'the review is over: stop the dev server');
  const recorded = j.verdicts[String(j.round)];
  if (Object.values(recorded).every((r) => r === 'PASS')) {
    if (isPrRework(x)) return toStage(x, 'RV8', 'pr', 'the PR rework passed review');
    // Evals never integrate: base drift would skew their scores.
    if (j.kind === 'eval') return toStage(x, 'RV8', 'decide', 'every lens passed');
    return toStage(x, 'RV8', 'integrate', 'every lens passed: bring the branch up to date');
  }
  return toStage(x, 'RV8', 'build', 'a lens asked for changes: next round');
}
