// Builds StepInputs for test/step.test.ts (step and the briefs it renders) without touching disk: a job from
// normalizeJob({id:'j'}), the default config, and only the facts a row names.
import path from 'node:path';
import { acCoverage } from '#engine/pipeline/acs.ts';
import type { AcCoverage } from '#engine/pipeline/acs.ts';
import { jobPathMap } from '#engine/pipeline/brief.ts';
import { defaults } from '#core/config/load.ts';
import { jobEndpoints } from '#engine/environment/endpoints.ts';
import { normalizeJob } from '#core/job/schema.ts';
import { PLUGIN_ROOT } from '#core/paths.ts';
import { recallGate } from '#engine/pipeline/step/input.ts';
import type { Config, Job, JobAgent, JobEvent } from '#core/types.ts';
import type { StepFile, StepInput } from '#engine/pipeline/types.ts';

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
  /** loadStepInput's decisionCurrent: every job repo's HEAD follows the decided head; true by default. */
  decisionCurrent?: StepInput['decisionCurrent'];
  /** loadStepInput's reviewCurrent: every job repo's HEAD follows the head the round's review was given; true by default. */
  reviewCurrent?: StepInput['reviewCurrent'];
  /** loadStepInput's reviewedShas; {} by default. */
  reviewedShas?: StepInput['reviewedShas'];
  runbookBeforeMerge?: boolean;
  verdicts?: Partial<StepInput['verdicts']>;
  runtime?: string[];
  /** The job's environment record entry; none by default. */
  environment?: StepInput['environment'];
  evalTask?: StepInput['evalTask'];
  integrationTouched?: StepInput['integrationTouched'];
  /** `.forge/verifiers/*.md` entries in the main checkout; 0 by default. */
  verifiers?: number;
  /** A member repo has no worktree yet (RP2). */
  memberWorktreesMissing?: boolean;
  /** Extra existing paths (dirs such as review/round-1). */
  present?: string[];
  /** loadStepInput's clock; the real one by default, so the budget rows' tells name today. */
  now?: string;
  /** The job's endpoints; jobEndpoints' components by default when commands.dev is set. */
  endpoints?: StepInput['endpoints'];
  /** trustedMemberWorktree per member repo; none by default. */
  memberWorktrees?: StepInput['memberWorktrees'];
  /** Fields over acCoverage(null, null), as `forge job acs` would report them. */
  acs?: Partial<AcCoverage>;
  /** loadStepInput's folderMaps; null by default, as at any stage but build. */
  folderMaps?: StepInput['folderMaps'];
  /** Checklist path per lens; the plugin's checklist for each panel lens by default. */
  checklists?: StepInput['checklists'];
  /** loadStepInput's verifierQuestions; null by default, as at any stage but build. */
  verifierQuestions?: StepInput['verifierQuestions'];
  /** loadStepInput's instructionsChanged; [] (nothing changed) by default. */
  instructionsChanged?: StepInput['instructionsChanged'];
  /** The keys still over budget at a budget park (loadStepInput's budgetExceeded); null by default. */
  budgetExceeded?: StepInput['budgetExceeded'];
  /**
   * What loadRecall read for the decide gate: the committed files (null: git failed), whether the main
   * checkout has fixtures (yes by default), whether one of them fails to load (no by default) and the
   * worktree's pluginHash (RECALL_HASH by default). Without it, recall is null, as for a repo with no fixtures.
   */
  recall?: { changed: string[] | null; fixtures?: boolean; invalid?: boolean; pluginHash?: string };
}

/** The worktree's pluginHash in recall rows. */
export const RECALL_HASH = 'abcdef0123';

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
  score: 'score.md',
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
    spec: { size: null, complexity: null, needsDesign: false, components: [], suggested: [], approachPaths: [], uiAcs: [], ...o.spec },
    designDeltas: o.designDeltas ?? false,
    decision: { decision: null, ...o.decision },
    decisionCurrent: o.decisionCurrent ?? true,
    reviewCurrent: o.reviewCurrent === undefined ? true : o.reviewCurrent,
    reviewedShas: o.reviewedShas ?? {},
    runbookBeforeMerge: o.runbookBeforeMerge ?? false,
    verdicts: { round: null, integration: null, ...o.verdicts },
    acs: { ...acCoverage(null, null), ...o.acs },
    folderMaps: o.folderMaps ?? null,
    verifierQuestions: o.verifierQuestions ?? null,
    instructionsChanged: o.instructionsChanged ?? [],
    runtime: o.runtime ?? [],
    environment: o.environment ?? null,
    events: o.events ?? [],
    evalTask: o.evalTask ?? null,
    checklists: o.checklists ?? Object.fromEntries(config.review.panel.map((p) => [p.name, path.join(PLUGIN_ROOT, 'reviewers', `${p.name}.md`)])),
    integrationTouched: o.integrationTouched ?? null,
    recall: o.recall ? recallGate(job, config, { worktree: o.worktree !== false, fixtures: o.recall.fixtures ?? true, changed: o.recall.changed, pluginHash: o.recall.pluginHash ?? RECALL_HASH, invalid: o.recall.invalid }) : null,
    verifiers: o.verifiers ?? 0,
    now: o.now ?? new Date().toISOString(),
    endpoints: o.endpoints ?? (config.commands.dev ? jobEndpoints(ROOT, config, job).components.map((e) => ({ name: e.name, url: e.url })) : []),
    memberWorktrees: o.memberWorktrees ?? {},
    budgetExceeded: o.budgetExceeded ?? null,
  };
}
