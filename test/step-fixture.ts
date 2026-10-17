// Builds StepInputs for test/step.test.ts and test/brief.test.ts without touching disk: a job from
// normalizeJob({id:'j'}), the default config, and only the facts a row names.
import path from 'node:path';
import { acCoverage } from '../lib/acs.ts';
import { jobPathMap } from '../lib/brief.ts';
import { defaults } from '../lib/config.ts';
import { normalizeJob } from '../lib/schema.ts';
import { PLUGIN_ROOT } from '../lib/paths.ts';
import type { Config, Job, JobAgent, JobEvent, StepFile, StepInput } from '../lib/types.ts';

export const ROOT = '/repo';
export const JOB_DIR = path.join(ROOT, '.forge', 'jobs', 'j');
export const WT = '/repo.worktrees/j';

/** Minute n on a fixed day, so rows order events by number. */
export const t = (n: number) => `2026-10-01T${String(10 + Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}:00.000Z`;

/** An agent record that started at minute `start` and ended at `end` (omit end: still running). */
export function ag(round: number, start: number, end?: number, extra: Partial<JobAgent> = {}): JobAgent {
  return { runs: 1, status: end === undefined ? 'running' : 'done', model: 'opus', agentId: `a${start}`, startedAt: t(start), endedAt: end === undefined ? null : t(end), round, ...extra };
}

export const ev = (type: string, n: number, data: Record<string, unknown> = {}): JobEvent => ({ v: 1, ts: t(n), type, ...data });

export interface FixtureOpts {
  job?: Partial<Job>;
  config?: (c: Config) => void;
  files?: StepFile[];
  events?: JobEvent[];
  worktree?: boolean;
  request?: Partial<StepInput['request']>;
  plan?: Partial<StepInput['plan']>;
  spec?: Partial<StepInput['spec']>;
  designDeltas?: boolean;
  decision?: Partial<StepInput['decision']>;
  runbookBeforeMerge?: boolean;
  verdicts?: Partial<StepInput['verdicts']>;
  runtime?: string[];
  evalTask?: StepInput['evalTask'];
  integrationTouched?: StepInput['integrationTouched'];
  /** `.forge/verifiers/*.md` entries in the main checkout; 0 by default. */
  verifiers?: number;
  /** A member repo has no worktree yet (RP2). */
  memberWorktreesMissing?: boolean;
  /** Extra existing paths (dirs such as review/round-1). */
  present?: string[];
}

const FILE_NAMES: Record<StepFile, string> = {
  request: 'request.md',
  plan: 'plan.md',
  spec: 'spec.md',
  design: 'design.md',
  mockup: 'mockup.html',
  build: 'build.md',
  tasks: 'tasks.md',
  questions: 'questions.md',
  feedback: 'feedback.md',
  prFeedback: 'pr-feedback.md',
  runbook: 'runbook.md',
  decision: 'decision.md',
  scope: 'scope.md',
  issueCandidates: 'issue-candidates.md',
  evalJudge: 'eval-judge.md',
};

/** Verdicts for each lens as roundVerdicts would report them. */
export function verdicts(map: Record<string, string>): NonNullable<StepInput['verdicts']['round']> {
  const values = Object.values(map);
  const complete = !values.includes('PENDING') && !values.includes('MISSING');
  const outcome = values.includes('PENDING') ? 'PENDING' : values.includes('MISSING') ? 'MISSING' : values.includes('MALFORMED') ? 'MALFORMED' : values.includes('CHANGES') ? 'CHANGES' : 'PASS';
  return { complete, outcome, reviewers: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, { verdict: v }])) };
}

export function fixture(o: FixtureOpts = {}): StepInput {
  const config = defaults();
  // No tracker by default, so rows that aren't about the issue rule skip it.
  config.tracker.kind = 'none';
  o.config?.(config);
  const job = { ...normalizeJob({ id: 'j', branch: 'forge/j', base: 'main', worktree: o.worktree === false ? null : WT, port: 4100 }), ...o.job } as Job;
  const files = Object.fromEntries(Object.keys(FILE_NAMES).map((k) => [k, (o.files ?? []).includes(k as StepFile)])) as Record<StepFile, boolean>;
  const present = [...(o.files ?? []).map((f) => path.join(JOB_DIR, FILE_NAMES[f])), ...(o.present ?? [])];
  return {
    job,
    config,
    root: ROOT,
    jobDir: JOB_DIR,
    pluginRoot: PLUGIN_ROOT,
    paths: jobPathMap(ROOT, config, job),
    files,
    present,
    worktreeExists: o.worktree !== false,
    memberWorktreesMissing: o.memberWorktreesMissing ?? false,
    request: { length: 40, listLines: 0, ...o.request },
    plan: { verdict: null, jobs: 0, recommendSplit: false, ...o.plan },
    spec: { size: null, complexity: null, needsDesign: false, services: [], suggested: [], approachPaths: [], ...o.spec },
    designDeltas: o.designDeltas ?? false,
    decision: { decision: null, autoMerge: false, ...o.decision },
    runbookBeforeMerge: o.runbookBeforeMerge ?? false,
    verdicts: { round: null, integration: null, ...o.verdicts },
    acs: acCoverage(null, null),
    runtime: o.runtime ?? [],
    events: o.events ?? [],
    evalTask: o.evalTask ?? null,
    checklists: Object.fromEntries(config.review.panel.map((p) => [p.name, path.join(PLUGIN_ROOT, 'reviewers', `${p.name}.md`)])),
    integrationTouched: o.integrationTouched ?? null,
    verifiers: o.verifiers ?? 0,
  };
}
