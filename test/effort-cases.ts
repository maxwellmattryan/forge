// The effort precedence table both halves are tested against: resolveEffort in lib/config.ts and
// effectiveEffort in dashboard/src/lib/jobs/effort.ts, which mirrors it because the dashboard can't import lib/.
export const EFFORT_CASES: { job: unknown; config: unknown; level: string | null; source: 'job' | 'config' | 'none' }[] = [
  { job: 'high', config: 'medium', level: 'high', source: 'job' },
  { job: null, config: 'medium', level: 'medium', source: 'config' },
  { job: null, config: null, level: null, source: 'none' },
  { job: undefined, config: 'low', level: 'low', source: 'config' },
  { job: 'max', config: null, level: 'max', source: 'job' },
  { job: 'xhigh', config: 'xhigh', level: 'xhigh', source: 'job' },
  // A job value outside the five levels is ignored, whatever it holds.
  { job: 'ultra', config: 'medium', level: 'medium', source: 'config' },
  { job: '--add-dir=/', config: 'medium', level: 'medium', source: 'config' },
  { job: 'high --add-dir /', config: 'medium', level: 'medium', source: 'config' },
  { job: 3, config: 'medium', level: 'medium', source: 'config' },
  { job: 'High', config: null, level: null, source: 'none' },
  // An invalid config value counts as none.
  { job: null, config: 'ultra', level: null, source: 'none' },
  { job: 'low', config: '--dangerously-skip-permissions', level: 'low', source: 'job' },
  { job: null, config: 5, level: null, source: 'none' },
];

/**
 * Per-role resolution (resolveEffort(config, job, role)): `config` is merged into runtime, `panel`
 * sets review.panel's security entry's effort, `job` is the job's {effort, complexity, round}.
 */
export const ROLE_EFFORT_CASES: {
  name: string;
  role: string | null;
  job?: { effort?: unknown; complexity?: unknown; round?: unknown };
  runtime?: { effort?: unknown; efforts?: Record<string, unknown>; effortByComplexity?: Record<string, unknown> };
  panel?: unknown;
  level: string | null;
  source: 'job' | 'panel' | 'role' | 'complexity' | 'config' | 'none';
  rework?: true;
}[] = [
  { name: 'role beats config', role: 'reviewer:code', runtime: { effort: 'high', efforts: { reviewer: 'medium' } }, level: 'medium', source: 'role' },
  { name: 'job beats role', role: 'reviewer:code', job: { effort: 'xhigh' }, runtime: { effort: 'high', efforts: { reviewer: 'medium' } }, level: 'xhigh', source: 'job' },
  { name: 'panel beats role for its lens', role: 'reviewer:security', panel: 'max', runtime: { efforts: { reviewer: 'low' } }, level: 'max', source: 'panel' },
  { name: 'panel applies to its lens only', role: 'reviewer:code', panel: 'max', runtime: { efforts: { reviewer: 'low' } }, level: 'low', source: 'role' },
  { name: 'job beats panel', role: 'reviewer:security', panel: 'max', job: { effort: 'low' }, level: 'low', source: 'job' },
  { name: 'panel is for reviewers only', role: 'builder', panel: 'max', level: null, source: 'none' },
  { name: 'complexity under role', role: 'builder', job: { complexity: 'high' }, runtime: { effort: 'medium', effortByComplexity: { high: 'xhigh' } }, level: 'xhigh', source: 'complexity' },
  { name: 'role beats complexity', role: 'builder', job: { complexity: 'high' }, runtime: { effort: 'medium', efforts: { builder: 'low' }, effortByComplexity: { high: 'xhigh' } }, level: 'low', source: 'role' },
  { name: 'unmapped complexity falls to config', role: 'builder', job: { complexity: 'low' }, runtime: { effort: 'medium', effortByComplexity: { high: 'xhigh' } }, level: 'medium', source: 'config' },
  { name: 'no role skips role, panel and complexity', role: null, job: { complexity: 'high' }, runtime: { effort: 'medium', efforts: { builder: 'max' }, effortByComplexity: { high: 'xhigh' } }, level: 'medium', source: 'config' },
  { name: 'nothing set', role: 'planner', level: null, source: 'none' },
];

/** Values no layer may accept: each falls through to the next layer. */
export const INVALID_EFFORTS: unknown[] = ['ultra', 3, 'high --add-dir /'];
