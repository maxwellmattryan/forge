// The effort precedence table both halves are tested against: resolveEffort in lib/config.ts and
// effectiveEffort in dashboard/src/lib/effort.ts, which mirrors it because the dashboard can't import lib/.
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
