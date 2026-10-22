// Integrate: bring the branch up to date with its base, resolve conflicts per pr.conflicts, and
// review the resolution before the approver or the PR.
import { generatedConfig } from '../../../workspace/regenerate.ts';
import { inSpec } from '../../../../core/glob.ts';
import type { JobAgent, JobEvent, StepInput, VerifyRun } from '../../../../core/types.ts';
import { park, run, set, spawn, toStage } from '../actions.ts';
import { after, afterIdx, agent, approvedSinceReview, isPrRework, lastEvent, lastIdx, p } from '../facts.ts';
import type { Facts } from '../facts.ts';
import { missingOutputRows, needsInputRows } from '../generic.ts';
import { inStage } from '../rules.ts';
import type { Ctx, Table } from '../rules.ts';

/** Where an up-to-date branch goes: the approver judges it first, unless it was approved already or its PR is open. */
const afterIntegration = (x: StepInput, f: Facts) => (isPrRework(x) || approvedSinceReview(x, f) ? 'pr' : 'decide');

// The builder, integrator or base branch names the conflicted files, so anything odd counts as code.
const SAFE_CONFLICT = (p: unknown): p is string =>
  typeof p === 'string' && p !== '' && !p.startsWith('/') && !p.includes('\\') && !/[\x00-\x1f\x7f]/.test(p) && !p.split('/').includes('..');
const isDocs = (p: string) => p.toLowerCase().endsWith('.md') || p.startsWith('docs/');

/**
 * How many files this episode's conflicts and resolution touched when every one is docs or generated and
 * `pr.integrationReview: code-only` lets the integration review be skipped; 0 keeps the review.
 */
export function integrationReviewSkippable(x: StepInput, first: JobEvent): number {
  if (x.config.pr.integrationReview !== 'code-only') return 0;
  const at = x.events.indexOf(first);
  // A review already ran this episode: its outcome governs.
  if (x.events.some((e, i) => i > at && e.type === 'agent-start' && e.role === 'reviewer:code')) return 0;
  const events = x.events.filter((e, i) => i >= at && e.type === 'integrate-conflicts');
  const conflicted = new Set<string>();
  const regenerated = new Set<string>();
  for (const e of events) {
    for (const [key, into] of [['conflicts', conflicted], ['regenerated', regenerated]] as const) {
      const list: unknown = e[key];
      if (list === undefined) continue;
      if (!Array.isArray(list) || !list.every(SAFE_CONFLICT)) return 0;
      for (const p of list) into.add(p);
    }
  }
  if (!conflicted.size && !regenerated.size) return 0;
  // Conflict names are only where git stopped; the integrator may change any file while resolving or
  // after. What it actually changed must be known, for the sides this episode merged and the sha the
  // passing verify checked, or the review stays.
  const touched = x.integrationTouched;
  const verified = x.job.verifyRuns.at(-1);
  if (!touched || !Array.isArray(touched.files) || touched.head !== first.head || touched.upstream !== first.upstream || !verified?.ok || touched.sha !== verified.sha) return 0;
  if (!touched.files.every(SAFE_CONFLICT)) return 0;
  const all = new Set([...conflicted, ...regenerated, ...touched.files]);
  const globs = generatedConfig(x.config)?.globs ?? [];
  const skippable = (p: string) => regenerated.has(p) || isDocs(p) || (globs.length > 0 && inSpec(p, globs));
  return [...all].every(skippable) ? all.size : 0;
}

/**
 * The first integrate event of this episode: step's own `forge integrate`; later ones are the
 * integrator's `--keep-conflicts` and `--continue`. The episode starts at the transition into
 * integrate. A job set to integrate before transitions were logged has none; it anchors on the
 * later of the decision that sent it here and the round's first passing verify, by timestamp, so an
 * earlier episode's events don't count while this episode's integration (and the verify after it) still do.
 */
function firstIntegration(x: StepInput, f: Facts): number {
  const integrating = (e: JobEvent) => e.type === 'integrated' || e.type === 'integrate-conflicts';
  const entry = f.stageEntry;
  if (entry) return x.events.findIndex((e, i) => i > entry.i && integrating(e));
  const decided = lastEvent(x, (e) => e.type === 'decision')?.ts ?? null;
  const verified = x.job.verifyRuns.find((r) => r.round === x.job.round && r.ok)?.at ?? null;
  const since = after(decided, verified) ? decided : verified;
  return x.events.findIndex((e) => integrating(e) && after(e.ts, since));
}

interface IntegrateCtx extends Ctx {
  /** The position of this episode's first integrate event, and the event; -1 and undefined before IG1 runs. */
  at: number;
  first: JobEvent | undefined;
  /** The verify runs after the first integrate event. */
  merged: VerifyRun[];
  integrator: JobAgent | undefined;
  /** The verify runs after the integrator ended. */
  checks: VerifyRun[];
  reviewer: JobAgent | undefined;
  /** The integration review recorded since the reviewer ended. */
  fresh: JobEvent | null;
  /** Where an up-to-date branch goes (afterIntegration). */
  next: 'pr' | 'decide';
}

function context(c: Ctx): IntegrateCtx {
  const { x, f } = c;
  const at = firstIntegration(x, f);
  const first = x.events[at] as JobEvent | undefined;
  const integrator = agent(x, 'integrator');
  const reviewer = agent(x, 'reviewer:code');
  const reviewEv = lastEvent(x, (e) => e.type === 'integration-review');
  return {
    ...c,
    at,
    first,
    merged: x.job.verifyRuns.filter((r) => after(r.at, first?.ts)),
    integrator,
    checks: x.job.verifyRuns.filter((r) => after(r.at, integrator?.endedAt)),
    reviewer,
    fresh: reviewEv && after(reviewEv.ts, reviewer?.endedAt) ? reviewEv : null,
    next: afterIntegration(x, f),
  };
}

/** The first integrate event brought the branch up to date without conflicts. */
const integrated = (c: IntegrateCtx) => c.first?.type === 'integrated';
const behind = (c: IntegrateCtx) => integrated(c) && Number(c.first!.behind) > 0;
/** No integration reviewer started since the integrator ended. */
const unreviewed = (c: IntegrateCtx) => !after(c.reviewer?.startedAt, c.integrator?.endedAt);
const malformed = (c: IntegrateCtx) => !c.fresh && c.x.verdicts.integration?.reviewers.code?.verdict === 'MALFORMED';
const skipped = (c: IntegrateCtx) => (c.first ? integrationReviewSkippable(c.x, c.first) : 0);
/** The why for a move on to `next`. */
const onward = (c: IntegrateCtx, what: string) => `${what}: ${c.next === 'pr' ? 'open the PR' : 'the approver decides'}`;

export const INTEGRATE: Table<IntegrateCtx> = {
  name: 'integrate',
  applies: inStage('integrate'),
  context,
  rules: [
    { id: 'IG1', when: (c) => !c.first, then: ({ x }) => run(x, 'IG1', ['integrate', x.job.id], 'bring the branch up to date with its base') },
    { id: 'IG2', when: (c) => behind(c) && !c.merged.length, then: ({ x }) => run(x, 'IG2', ['verify', x.job.id], 'the integration brought in new commits') },
    { id: 'IG2b', when: (c) => behind(c) && !c.merged.at(-1)!.ok, then: ({ x }) => toStage(x, 'IG2b', 'build', 'verify failed after integrating the base') },
    { id: 'IG3', when: integrated, then: (c) => toStage(c.x, 'IG3', c.next, onward(c, 'the branch is up to date')) },
    {
      id: 'IG4',
      when: ({ x, at }) => x.config.pr.conflicts === 'ask' && !afterIdx(lastIdx(x, (e) => e.type === 'human' && e.action === 'approve'), at),
      then: ({ x, first }) => set(x, 'IG4', { state: 'waiting', waitingOn: 'conflicts', reason: `conflicts with base: ${Array.isArray(first!.conflicts) ? first!.conflicts.length : 0} files` }, 'a human decides how to resolve conflicts'),
    },
    { id: 'IG5', when: ({ x }) => x.config.pr.conflicts === 'defer', then: (c) => toStage(c.x, 'IG5', c.next, onward(c, 'conflicts deferred by pr.conflicts'), { note: 'conflicts with base deferred' }) },
    { id: 'IG6', when: ({ integrator, first }) => !integrator || !after(integrator.startedAt, first!.ts), then: ({ x }) => spawn(x, 'IG6', 'integrator') },
    needsInputRows('integrator'),
    { id: 'IG7', when: (c) => !c.checks.length, then: ({ x }) => run(x, 'IG7', ['verify', x.job.id], 'verify the conflict resolution') },
    { id: 'IG7b', when: (c) => !c.checks.at(-1)!.ok, then: ({ x }) => park(x, 'IG7b', 'escalation', 'integration: verify failed after conflict resolution') },
    // The note carries only a count: conflicted names are untrusted and never reach the command.
    {
      id: 'IG11',
      when: (c) => unreviewed(c) && skipped(c) > 0,
      then: (c) => toStage(c.x, 'IG11', c.next, onward(c, 'only docs or generated files conflicted'), { note: `integration review skipped: only docs or generated files conflicted, ${skipped(c)} files` }),
    },
    { id: 'IG8', when: unreviewed, then: ({ x }) => spawn(x, 'IG8', 'reviewer:code') },
    missingOutputRows('reviewer:code'),
    {
      id: 'IG12',
      when: (c) => malformed(c) && !c.reviewer?.retry,
      then: ({ x }) => spawn(x, 'IG12', 'reviewer:code', { retry: true, retryLine: `Retry: ${p(x, 'integrationReview')} has no VERDICT line; rewrite it in the required format.` }),
    },
    { id: 'IG13', when: malformed, then: ({ x }) => run(x, 'IG13', ['job', 'verdicts', x.job.id, '--round', 'integration', '--compact', '--malformed', 'changes'], 'the integration review failed the format twice: count it as CHANGES') },
    { id: 'IG9', when: (c) => !c.fresh, then: ({ x }) => run(x, 'IG9', ['job', 'verdicts', x.job.id, '--round', 'integration', '--compact'], 'record the integration review') },
    { id: 'IG10', when: (c) => c.fresh?.outcome === 'PASS', then: (c) => toStage(c.x, 'IG10', c.next, onward(c, 'the integration review passed')) },
    // One fix pass: the integrator ran once this episode.
    {
      id: 'IG10b',
      when: ({ x, at }) => x.events.filter((e, i) => i > at && e.type === 'agent-start' && e.role === 'integrator').length === 1,
      then: ({ x }) => spawn(x, 'IG10b', 'integrator', { resume: true }),
    },
    { id: 'IG10c', when: () => true, then: ({ x }) => park(x, 'IG10c', 'escalation', 'integration review: CHANGES') },
  ],
};
