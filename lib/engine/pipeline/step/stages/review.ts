// Review: pick the panel, write the scope report, run the lenses, record their verdicts, move on.
import path from 'node:path';
import { lensNeedsApp } from '#core/config/load.ts';
import { reviewFileName } from '#core/job/lens.ts';
import type { StepInput, StepVerdicts } from '../../types.ts';
import { run, spawn, toStage } from '../actions.ts';
import { after, agent, endedIn, enteredFrom, isPrRework, outputMissing, startedIn } from '../facts.ts';
import { lateFailure, panelRun, restPending } from '../../../verify/record.ts';
import type { JobAgent } from '#core/types.ts';
import { missingOutputRows } from '../generic.ts';
import { currentRerun, roundLenses } from '../panel.ts';
import { inStage } from '../rules.ts';
import type { Ctx, RuleId, Table } from '../rules.ts';

/** A lens run a late verify failure cancelled (RV13): it counts as not started, so the next pass spawns it again. */
const cancelled = (a: JobAgent | undefined): boolean => a?.status === 'cancelled';
/** The lens's reviewer started this round, and its run was not cancelled. */
const reviewing = (x: StepInput, role: string): boolean => startedIn(agent(x, role), x.job.round) && !cancelled(agent(x, role));

/** RV4: every lens of this round whose reviewer has not started yet (or was cancelled), in panel order; none once the round's verdicts are recorded. */
export function nextLenses(x: StepInput): string[] {
  if (x.job.verdicts[String(x.job.round)]) return [];
  return roundLenses(x.job, x.config, currentRerun(x)).filter((l) => !reviewing(x, `reviewer:${l}`));
}

/** M1 in the review stage: the first lens of this round whose reviewer ended without its review and has not had its retry; none once the round's verdicts are recorded. A cancelled run is not retried. */
export function retryLens(x: StepInput): string | null {
  const j = x.job;
  if (j.verdicts[String(j.round)]) return null;
  return roundLenses(j, x.config, currentRerun(x)).find((l) => {
    const a = agent(x, `reviewer:${l}`);
    // outputMissing(), not a.outputMissing: a pre-v6 record falls back to the MISSING verdict.
    return endedIn(a, j.round) && !cancelled(a) && !a.retry && outputMissing(x, `reviewer:${l}`);
  }) ?? null;
}

/** RV13: the first reviewer of this round, by role name, whose run started and is not cancelled yet, running or ended. */
function toCancel(x: StepInput): string | undefined {
  return Object.keys(x.job.agents)
    .filter((k) => k.startsWith('reviewer:') && reviewing(x, k))
    .sort()[0];
}

interface ReviewCtx extends Ctx {
  /** This round's rework panel (currentRerun), or null for the full panel. */
  rerun: string[] | null;
  lenses: string[];
  /** The round's verdicts are recorded in job.json. */
  recorded: boolean;
  v: StepVerdicts | null;
  malformed: string[];
  /** `job verdicts` with `--reviewers` when this round's lenses differ from job.reviewers. */
  verdictsCmd: (extra: string[]) => string[];
}

function context(c: Ctx): ReviewCtx {
  const { x } = c;
  const j = x.job;
  const rerun = currentRerun(x);
  const lenses = roundLenses(j, x.config, rerun);
  const differs = lenses.join(',') !== j.reviewers.join(',');
  const v = x.verdicts.round;
  return {
    ...c,
    rerun,
    lenses,
    recorded: Boolean(j.verdicts[String(j.round)]),
    v,
    malformed: lenses.filter((l) => v?.reviewers[l]?.verdict === 'MALFORMED'),
    verdictsCmd: (extra) => ['job', 'verdicts', j.id, '--compact', ...extra, ...(differs ? ['--reviewers', lenses.join(',')] : [])],
  };
}

/** A malformed lens that has not had its retry. */
const freshMalformed = ({ x, malformed }: ReviewCtx) => malformed.find((l) => !agent(x, `reviewer:${l}`)?.retry);
const allPassed = ({ x }: ReviewCtx) => Object.values(x.job.verdicts[String(x.job.round)] ?? {}).every((r) => r === 'PASS');
const REWORK_WHY = 'rework round: re-review the lenses that asked for changes, the always lenses and the lenses whose paths the fix touched';

/**
 * The whole remaining panel in one action so the orchestrator launches it in one message. Each lens
 * is still recorded by its own `agent start`, so a re-step never lists a started lens.
 */
function panelSpawn(x: StepInput, rule: RuleId, why?: string) {
  const [first, ...rest] = nextLenses(x);
  const a = { ...spawn(x, rule, `reviewer:${first}`, { rework: true }), ...(why ? { why } : {}) };
  return rest.length ? { ...a, spawns: rest.map((l) => spawn(x, rule, `reviewer:${l}`, { rework: true })) } : a;
}

export const REVIEW: Table<ReviewCtx> = {
  name: 'review',
  applies: inStage('review'),
  context,
  rules: [
    // DC11 or PR12 sent a reviewed round back for a commit after review: only build opens a round and
    // applies the round limits, so the new head goes there first (B1, then B8 verifies it).
    {
      id: 'RV11',
      when: (c) => c.recorded && ['decide', 'pr'].includes(enteredFrom(c.x, c.f) ?? ''),
      then: ({ x }) => toStage(x, 'RV11', 'build', 'the reviewed round is closed: open a new round for the commit after review'),
    },
    // review.startAfter fast: the full verify alongside the panel failed (a late failure). Every lens run of the
    // round is void, so each is cancelled, one per step, then the round goes back to the builder (B4).
    {
      id: 'RV13',
      when: ({ x }) => lateFailure(x.job) && toCancel(x) !== undefined,
      then: ({ x }) => run(x, 'RV13', ['job', 'agent', x.job.id, 'cancel', '--role', toCancel(x)!], 'verify failed while the panel reviewed: cancel its lens runs'),
    },
    { id: 'RV13b', when: ({ x }) => lateFailure(x.job), then: ({ x }) => toStage(x, 'RV13b', 'build', 'verify failed while the panel reviewed: back to the builder') },
    // Once per round, after verify and before any reviewer starts, so the panel matches the diff the
    // reviewers read. A PR rework under `changed` or `none` keeps its always-only or skip rule. It counts
    // from the run the review started from (panelRun), so the full verify after a partial pass re-runs nothing.
    {
      id: 'RV9',
      when: ({ x, recorded }) => {
        const j = x.job;
        const lv = panelRun(j);
        const prSkip = isPrRework(x) && x.config.review.onPrFeedback !== 'full';
        const panelled = x.events.some((e) => e.type === 'panel' && e.round === j.round && after(e.ts, lv?.at));
        const started = Object.keys(j.agents).some((k) => k.startsWith('reviewer:') && reviewing(x, k));
        return !prSkip && !panelled && !started && !recorded;
      },
      then: ({ x }) => run(x, 'RV9', ['job', 'panel', x.job.id], "pick this round's lenses from the diff"),
    },
    // The partial pass let the panel start: once every lens is spawned, the full verify runs while they review.
    // Before RV1, so a round with no lens never takes a partial pass to the pr stage.
    { id: 'RV12', when: ({ x }) => restPending(x.job) && nextLenses(x).length === 0, then: ({ x }) => run(x, 'RV12', ['verify', x.job.id], 'finish verify while the panel reviews') },
    { id: 'RV1', when: (c) => !c.lenses.length, then: ({ x }) => toStage(x, 'RV1', 'pr', 'no lens reviews this round') },
    {
      id: 'RV2',
      when: ({ x }) => !x.events.some((e) => e.type === 'scope' && e.round === x.job.round && after(e.ts, panelRun(x.job)?.at)),
      then: ({ x }) => run(x, 'RV2', ['job', 'scope', x.job.id], 'reviewers read the scope report'),
    },
    // Only until the round's verdicts are recorded: after that RV7 stops the server, and starting it
    // again here would alternate with that stop forever. Retries before then still get the app.
    {
      id: 'RV3',
      when: ({ x, lenses, recorded }) => !recorded && lenses.some((l) => lensNeedsApp(x.config, l)) && Boolean(x.config.commands.dev) && !x.runtime.includes('dev'),
      then: ({ x }) => run(x, 'RV3', ['run', x.job.id, 'dev', '--background'], 'app-needing lenses review the running app'),
    },
    { id: 'RV10', when: (c) => c.rerun !== null && nextLenses(c.x).length > 0, then: ({ x }) => panelSpawn(x, 'RV10', REWORK_WHY) },
    { id: 'RV4', when: ({ x }) => nextLenses(x).length > 0, then: ({ x }) => panelSpawn(x, 'RV4') },
    // Retries go out back to back like first spawns, even while other reviewers run (G5 lets them through).
    missingOutputRows<ReviewCtx>((c) => {
      const l = retryLens(c.x);
      return l === null ? null : `reviewer:${l}`;
    }),
    missingOutputRows<ReviewCtx>((c) => {
      const l = c.lenses.find((lens) => outputMissing(c.x, `reviewer:${lens}`) && !cancelled(agent(c.x, `reviewer:${lens}`)));
      return l === undefined ? null : `reviewer:${l}`;
    }),
    {
      id: 'RV5',
      when: (c) => !c.recorded && freshMalformed(c) !== undefined,
      then: (c) => {
        const lens = freshMalformed(c)!;
        const file = path.join(c.x.jobDir, 'review', `round-${c.x.job.round}`, reviewFileName(lens));
        return spawn(c.x, 'RV5', `reviewer:${lens}`, { retry: true, retryLine: `Retry: ${file} has no VERDICT line; rewrite it in the required format.` });
      },
    },
    { id: 'RV5b', when: (c) => !c.recorded && c.malformed.length > 0, then: (c) => run(c.x, 'RV5b', c.verdictsCmd(['--malformed', 'changes']), 'a lens failed the review format twice: count it as CHANGES') },
    { id: 'RV6', when: (c) => !c.recorded && Boolean(c.v?.complete), then: (c) => run(c.x, 'RV6', c.verdictsCmd([]), "record this round's verdicts") },
    // Without recorded verdicts and none complete, nothing below applies: X1.
    { id: 'RV7', when: (c) => c.recorded && c.x.runtime.length > 0, then: ({ x }) => run(x, 'RV7', ['stop', x.job.id], 'the review is over: stop the dev server') },
    { id: 'RV8', when: (c) => c.recorded && allPassed(c) && isPrRework(c.x), then: ({ x }) => toStage(x, 'RV8', 'pr', 'the PR rework passed review') },
    // Evals never integrate: base drift would skew their scores.
    { id: 'RV8b', when: (c) => c.recorded && allPassed(c) && c.x.job.kind === 'eval', then: ({ x }) => toStage(x, 'RV8b', 'decide', 'every lens passed') },
    { id: 'RV8c', when: (c) => c.recorded && allPassed(c), then: ({ x }) => toStage(x, 'RV8c', 'integrate', 'every lens passed: bring the branch up to date') },
    { id: 'RV8d', when: (c) => c.recorded, then: ({ x }) => toStage(x, 'RV8d', 'build', 'a lens asked for changes: next round') },
  ],
};
