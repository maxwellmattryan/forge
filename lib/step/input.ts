// loadStepInput: the one place `forge job step` reads disk. Everything step decides from is read
// here once, so step itself stays a pure function of the StepInput.
import path from 'node:path';
import { acCoverage, specUiAcs } from '../acs.ts';
import { readJobRecord, readSharedRecord } from '../backing.ts';
import { effectiveLimits, exceededKeys, measureBudget } from '../budget.ts';
import { jobPathMap } from '../brief.ts';
import { environmentState } from '../environment-record.ts';
import { configForJob } from '../eval-overlay.ts';
import { loadTask } from '../evals.ts';
import { jobDir, loadJob, parseDecision, readEvents, requestBody, roundVerdicts } from '../jobs.ts';
import { jobEndpoints } from '../endpoints.ts';
import { memberRepos, trustedMemberWorktree } from '../job-repos.ts';
import { lensChecklists } from '../member-panel.ts';
import { PLUGIN_ROOT, exists } from '../paths.ts';
import { approachPaths, integrationTouched } from '../scope.ts';
import type { Config, Job, JobEvent, StepFile, StepInput, StepVerdicts } from '../types.ts';
import { readJson, readText } from '../util.ts';
import { verifierCount } from '../verifiers.ts';
import { currentRerun, reworkReviewFiles, roundLenses } from './panel.ts';

/** Request bodies above this, or with this many list or heading lines, get a planner under `pipeline.plan: auto`. */
export const PLAN_AUTO_CHARS = 600;
export const PLAN_AUTO_LINES = 3;

/** Events loadStepInput keeps; everything else in events.jsonl is noise to step. */
export const STEP_EVENTS = new Set([
  'human', 'round', 'worktree', 'worktree-setup-failed', 'pr-find', 'pr-adopted', 'scope', 'panel', 'integrated', 'integrate-conflicts',
  'integration-review', 'decision', 'fields', 'pr-opened', 'pr-updated', 'pr-merged', 'pr-auto-merge', 'pr-merge-deferred',
  'pr-merge-refused', 'pr-merge-failed', 'eval-graded', 'transition', 'agent-start', 'agent-end', 'secret-found', 'verifiers',
  'protected-path', 'repo-proposed', 'pr-deferred', 'canary-published', 'interim-released', 'interim-bumped', 'pr-ready', 'downstream-checked', 'job-repo-added',
  'job-repo-removed', 'pr-head-pulled',
]);

/**
 * List and heading lines in a request, for `pipeline.plan: auto`. Imported issue bodies are
 * blockquoted, so `> - item` and `> ## Heading` count as well.
 */
export function listLineCount(body: string): number {
  return body.split('\n').filter((l) => /^[\s>]*(?:[-*]|\d+\.)\s|^[\s>]*#/.test(l)).length;
}

/** Every read step needs, and nothing else: no directory is created and no file or event is written. */
export function loadStepInput(root: string, base: Config, id: string): StepInput {
  const job = loadJob(root, id);
  // An eval job's overlay applies to everything below: lenses, panel, models, effort and briefs.
  const config = configForJob(root, base, job);
  const dir = jobDir(root, job.id);
  const at = (name: string) => path.join(dir, name);
  const read = (name: string) => (exists(at(name)) ? readText(at(name)) : null);
  const paths = jobPathMap(root, config, job);
  const files: Record<StepFile, boolean> = {
    request: exists(at('request.md')),
    plan: exists(at('plan.md')),
    spec: exists(at('spec.md')),
    design: exists(at('design.md')),
    mockup: exists(at('mockup.html')),
    build: exists(at('build.md')),
    tasks: exists(at('tasks.md')),
    questions: exists(at('questions.md')),
    feedback: exists(at('feedback.md')),
    prFeedback: exists(at('pr-feedback.md')),
    runbook: exists(at('runbook.md')),
    decision: exists(at('decision.md')),
    scope: exists(at('scope.md')),
    issueCandidates: exists(at('issue-candidates.md')),
    evalJudge: exists(at('eval-judge.md')),
    score: exists(at('score.md')),
  };
  const present = Object.values(paths).filter((v): v is string => typeof v === 'string' && exists(v));
  // The only I/O for the rework brief's review inputs, so step itself stays pure.
  for (const f of reworkReviewFiles(job, (paths.previousReviewDir as string | null) ?? null)) if (exists(f)) present.push(f);
  const body = requestBody(root, job.id);
  const specText = read('spec.md') ?? '';
  const events = readEvents(root, job.id).filter((e) => STEP_EVENTS.has(e.type));
  // The same list review() reads, or a narrowed round's verdicts would never complete.
  const lenses = roundLenses(job, config, currentRerun({ job, config, events }));
  const compact =(v: ReturnType<typeof roundVerdicts>): StepVerdicts => ({
    complete: v.complete,
    outcome: v.outcome,
    reviewers: Object.fromEntries(Object.entries(v.reviewers).map(([k, r]) => [k, { verdict: String(r.verdict) }])),
  });
  let runtime: string[] = [];
  try {
    const rt = readJson(at('runtime.json'), {});
    runtime = rt && typeof rt === 'object' ? Object.keys(rt).filter((k) => rt[k] && typeof rt[k] === 'object') : [];
  } catch {}
  let evalTask: StepInput['evalTask'] = null;
  if (job.eval?.task) {
    try {
      const t = loadTask(root, job.eval.task);
      evalTask = { rubric: t.rubric, reference: t.reference };
    } catch {}
  }
  const names = [...new Set([...config.review.panel.map((p) => p.name), ...job.reviewers])];
  return {
    job,
    config,
    root,
    jobDir: dir,
    pluginRoot: PLUGIN_ROOT,
    paths,
    files,
    present,
    // Every job repo's worktree: a missing member worktree sends the job back to I3 (worktree create).
    worktreeExists: Boolean(job.worktree && exists(job.worktree)) && memberRepos(job).every((m) => Boolean(m.worktree && exists(m.worktree))),
    memberWorktreesMissing: memberRepos(job).some((m) => !(m.worktree && exists(m.worktree))),
    request: { length: body.length, listLines: listLineCount(body) },
    plan: parsePlan(read('plan.md') ?? ''),
    spec: { ...parseSpecHeader(specText), approachPaths: approachPaths(specText), uiAcs: specUiAcs(specText) },
    designDeltas: hasSpecDeltas(read('design.md') ?? ''),
    decision: { decision: parseDecision(root, job.id).decision, autoMerge: /^\s*(?:[-*]\s*)?Auto-merge eligible:\s*yes\b/im.test(read('decision.md') ?? '') },
    runbookBeforeMerge: /^\s*(?:[-*]\s*)?When:\s*before merge\b/im.test(read('runbook.md') ?? ''),
    verdicts: {
      round: job.round >= 1 && lenses.length ? compact(roundVerdicts(root, job.id, job.round, lenses, config.review.blockOn)) : null,
      integration: job.stage === 'integrate' ? compact(roundVerdicts(root, job.id, 'integration', ['code'], config.review.blockOn)) : null,
    },
    acs: acCoverage(read('spec.md'), read('build.md')),
    runtime,
    environment: environmentState(root, job.id),
    events,
    evalTask,
    checklists: lensChecklists(root, config, job, names),
    integrationTouched: loadIntegrationTouched(job, config, events),
    // The main checkout's, never the worktree's: a branch can't switch the gate on or off.
    verifiers: verifierCount(root),
    ...(config.backing?.length ? { backing: { job: readJobRecord(root, job.id, config), shared: readSharedRecord(root, config) } } : {}),
    now: new Date().toISOString(),
    endpoints: config.commands.dev ? jobEndpoints(root, config, job).components.map((e) => ({ name: e.name, url: e.url })) : [],
    // The computed path, never job.json's: the session can write job.json, and verdicts trusts the same value.
    memberWorktrees: Object.fromEntries(memberRepos(job).map((m) => [m.repo, trustedMemberWorktree(root, config, job, m.repo)])),
    // Only at a budget park: measuring runs git, and only GA7 reads it.
    budgetExceeded: job.state === 'waiting' && job.waitingOn === 'budget' ? exceededKeys(effectiveLimits(config, job), measureBudget(job), job.budget.ack, job.round).map((e) => e.key) : null,
  };
}

/** Only when a skip is possible: integrate, code-only, the last verify passed, and the last conflicts event names both sides. */
export function loadIntegrationTouched(job: Job, config: Config, events: JobEvent[]): StepInput['integrationTouched'] {
  if (job.stage !== 'integrate' || config.pr.integrationReview !== 'code-only' || !job.worktree || !exists(job.worktree)) return null;
  const last = job.verifyRuns.at(-1);
  const ev = events.findLast((e) => e.type === 'integrate-conflicts');
  if (!last?.ok || !last.sha || !ev || typeof ev.head !== 'string' || typeof ev.upstream !== 'string') return null;
  return { head: ev.head, upstream: ev.upstream, sha: last.sha, files: integrationTouched(job.worktree, ev.head, ev.upstream, last.sha) };
}

export function parsePlan(text: string): StepInput['plan'] {
  const first = text.split('\n').find((l) => l.trim()) ?? '';
  const m = /^\s*PLAN:\s*(SINGLE|SPLIT)\b/i.exec(first);
  let jobs = 0;
  let inJobs = false;
  for (const line of text.split('\n')) {
    if (/^#{1,6}\s/.test(line)) inJobs = /^##\s+Jobs\b/i.test(line);
    else if (inJobs && /^\s*\d+[.)]\s/.test(line)) jobs++;
  }
  return { verdict: m ? (m[1].toUpperCase() as 'SINGLE' | 'SPLIT') : null, jobs, recommendSplit: /^\s*- Recommend splitting:/m.test(text) };
}

/** The header lines above the first `## ` heading; list values are split and trimmed but not filtered. */
export function parseSpecHeader(text: string): Omit<StepInput['spec'], 'approachPaths' | 'uiAcs'> {
  const head = text.split(/^## /m)[0];
  const value = (key: string) => new RegExp(`^${key}:[ \\t]*(.*)$`, 'mi').exec(head)?.[1].trim() ?? null;
  const items = (v: string | null) => (!v || v === '-' ? [] : v.split(',').map((s) => s.trim()).filter((s) => s && s !== '-'));
  return {
    size: value('Size'),
    complexity: value('Complexity')?.toLowerCase() ?? null,
    needsDesign: /^yes\b/i.test(value('Needs design') ?? ''),
    services: items(value('Services')),
    suggested: items(value('Suggested reviewers')),
  };
}

export function hasSpecDeltas(text: string): boolean {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s+Spec deltas\b/i.test(l));
  if (start < 0) return false;
  const body: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(l)) break;
    const t = l.replace(/^\s*[-*]\s*/, '').trim().replace(/^["'`*_]+|["'`*_]+$/g, '');
    if (t) body.push(t);
  }
  return body.length > 0 && !(body.length === 1 && /^(none|n\/a|-)\.?$/i.test(body[0]));
}
