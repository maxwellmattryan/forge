// Integrate: bring the branch up to date with its base, resolve conflicts per pr.conflicts, and
// review the resolution before the approver or the PR.
import { generatedConfig } from '../../regenerate.ts';
import { inSpec } from '../../scope.ts';
import type { JobEvent, StepAction, StepInput } from '../../types.ts';
import { park, run, set, spawn, toStage } from '../actions.ts';
import { after, agent, approvedSinceReview, human, isPrRework, lastEvent, p, stageSince } from '../facts.ts';
import { missingOutput, needsInput } from '../generic.ts';

/** Where an up-to-date branch goes: the approver judges it first, unless it was approved already or its PR is open. */
const afterIntegration = (x: StepInput) => (isPrRework(x) || approvedSinceReview(x) ? 'pr' : 'decide');

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
  // A review already ran this episode: its outcome governs.
  if (x.events.some((e) => e.type === 'agent-start' && e.role === 'reviewer:code' && after(e.ts, first.ts))) return 0;
  const events = x.events.filter((e) => e.type === 'integrate-conflicts' && (e === first || after(e.ts, first.ts)));
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

export function integrate(x: StepInput): StepAction {
  const j = x.job;
  // A job set to integrate before transitions were logged has no entry event; anchor on the later of
  // the decision that sent it here and the round's first passing verify, so an earlier episode's
  // events don't count while this episode's integration (and the verify after it) still do.
  const decided = lastEvent(x, (e) => e.type === 'decision')?.ts ?? null;
  const verified = j.verifyRuns.find((r) => r.round === j.round && r.ok)?.at ?? null;
  const since = stageSince(x) ?? (after(decided, verified) ? decided : verified);
  // The first integrate event since the job entered this stage is step's own `forge integrate`;
  // later ones are the integrator's `--keep-conflicts` and `--continue`.
  const first = x.events.find((e) => (e.type === 'integrated' || e.type === 'integrate-conflicts') && after(e.ts, since));
  if (!first) return run(x, 'IG1', ['integrate', j.id], 'bring the branch up to date with its base');
  const verifiesAfter = (ts: string | null | undefined) => j.verifyRuns.filter((r) => after(r.at, ts));
  if (first.type === 'integrated') {
    if (Number(first.behind) > 0) {
      const runs = verifiesAfter(first.ts);
      if (!runs.length) return run(x, 'IG2', ['verify', j.id], 'the integration brought in new commits');
      if (!runs.at(-1)!.ok) return toStage(x, 'IG2', 'build', 'verify failed after integrating the base');
    }
    const next = afterIntegration(x);
    return toStage(x, 'IG3', next, next === 'pr' ? 'the branch is up to date: open the PR' : 'the branch is up to date: the approver decides');
  }
  const policy = x.config.pr.conflicts;
  const files = Array.isArray(first.conflicts) ? first.conflicts.length : 0;
  const approved = after(human(x, 'approve')?.ts, first.ts);
  if (policy === 'ask' && !approved) return set(x, 'IG4', { state: 'waiting', waitingOn: 'conflicts', reason: `conflicts with base: ${files} files` }, 'a human decides how to resolve conflicts');
  if (policy === 'defer') {
    const next = afterIntegration(x);
    return toStage(x, 'IG5', next, next === 'pr' ? 'conflicts deferred by pr.conflicts: open the PR' : 'conflicts deferred by pr.conflicts: the approver decides', { note: 'conflicts with base deferred' });
  }
  const integrator = agent(x, 'integrator');
  const runs = x.events.filter((e) => e.type === 'agent-start' && e.role === 'integrator' && after(e.ts, first.ts)).length;
  if (!integrator || !after(integrator.startedAt, first.ts)) return spawn(x, 'IG6', 'integrator');
  const n = needsInput(x, 'integrator');
  if (n) return n;
  const checks = verifiesAfter(integrator.endedAt);
  if (!checks.length) return run(x, 'IG7', ['verify', j.id], 'verify the conflict resolution');
  if (!checks.at(-1)!.ok) return park(x, 'IG7', 'escalation', 'integration: verify failed after conflict resolution');
  const reviewer = agent(x, 'reviewer:code');
  if (!after(reviewer?.startedAt, integrator.endedAt)) {
    const skipped = integrationReviewSkippable(x, first);
    if (skipped > 0) {
      const next = afterIntegration(x);
      // The note carries only a count: conflicted names are untrusted and never reach the command.
      return toStage(x, 'IG11', next, next === 'pr' ? 'only docs or generated files conflicted: open the PR' : 'only docs or generated files conflicted: the approver decides', {
        note: `integration review skipped: only docs or generated files conflicted, ${skipped} files`,
      });
    }
    return spawn(x, 'IG8', 'reviewer:code');
  }
  const m = missingOutput(x, 'reviewer:code');
  if (m) return m;
  const reviewEv = lastEvent(x, (e) => e.type === 'integration-review');
  const fresh = reviewEv && after(reviewEv.ts, reviewer?.endedAt) ? reviewEv : null;
  if (!fresh) {
    if (x.verdicts.integration?.reviewers.code?.verdict === 'MALFORMED') {
      if (!reviewer?.retry) return spawn(x, 'RV5', 'reviewer:code', { retry: true, retryLine: `Retry: ${p(x, 'integrationReview')} has no VERDICT line; rewrite it in the required format.` });
      return run(x, 'RV5', ['job', 'verdicts', j.id, '--round', 'integration', '--compact', '--malformed', 'changes'], 'the integration review failed the format twice: count it as CHANGES');
    }
    return run(x, 'IG9', ['job', 'verdicts', j.id, '--round', 'integration', '--compact'], 'record the integration review');
  }
  if (fresh.outcome === 'PASS') {
    const next = afterIntegration(x);
    return toStage(x, 'IG10', next, next === 'pr' ? 'the integration review passed: open the PR' : 'the integration review passed: the approver decides');
  }
  if (runs === 1) return spawn(x, 'IG10', 'integrator', { resume: true });
  return park(x, 'IG10', 'escalation', 'integration review: CHANGES');
}
