// runtime.model* and runtime.effort*: their validation, and the one place each resolves for a
// spawn (resolveModel, resolveEffort). Imports no config.ts, which re-exports these.
import { COMPLEXITIES, EFFORT_ROLES, EFFORTS, MODEL_RE } from '../job/schema.ts';
import { isMap } from '../shape.ts';
import type { Config, Effort, EffortSource } from '../types.ts';

/**
 * runtime.modelByComplexity and runtime.reworkModel: a map with known keys, and each non-null value
 * a model MODEL_RE accepts. resolveModel treats anything else as unset, so these only report.
 */
export function modelProblems(c: unknown): string[] {
  const cfg: Record<string, any> = isMap(c) ? c : {};
  const problems: string[] = [];
  const bad = (key: string, v: unknown) => `${key} must be a model alias or id (letters, digits and . _ : - [ ]) or null (got ${JSON.stringify(v)})`;
  const m = cfg.runtime?.modelByComplexity;
  if (m !== undefined && m !== null) {
    if (typeof m !== 'object' || Array.isArray(m)) problems.push(`runtime.modelByComplexity must be a map (got ${JSON.stringify(m)})`);
    else
      for (const [k, v] of Object.entries(m)) {
        if (!(COMPLEXITIES as readonly string[]).includes(k)) problems.push(`runtime.modelByComplexity.${k} must be ${COMPLEXITIES.slice(0, -1).join(', ')} or ${COMPLEXITIES.at(-1)}`);
        else if (v !== null && !validModel(v)) problems.push(bad(`runtime.modelByComplexity.${k}`, v));
      }
  }
  const r = cfg.runtime?.reworkModel;
  if (r !== undefined && r !== null && !validModel(r)) problems.push(bad('runtime.reworkModel', r));
  return problems;
}

/**
 * runtime.efforts, runtime.effortByComplexity and a panel entry's `effort`. Not daemonProblems:
 * none of them reaches a session's argv (sessions resolve with no role), and resolveEffort treats
 * an invalid value as unset anyway.
 */
export function effortProblems(c: unknown): string[] {
  const cfg: Record<string, any> = isMap(c) ? c : {};
  const problems: string[] = [];
  const levels = `${EFFORTS.join(' | ')}, or null`;
  const map = (key: string, keys: readonly string[], unknownKey: (k: string) => string) => {
    const m = cfg.runtime?.[key];
    if (m === undefined || m === null) return;
    if (!isMap(m)) return problems.push(`runtime.${key} must be a map (got ${JSON.stringify(m)})`);
    for (const [k, v] of Object.entries(m)) {
      if (!keys.includes(k)) problems.push(unknownKey(k));
      else if (v !== null && !validEffort(v)) problems.push(`runtime.${key}.${k} must be one of ${levels} (got ${JSON.stringify(v)})`);
    }
  };
  map('efforts', EFFORT_ROLES, (k) => `runtime.efforts.${k} is not a role (${EFFORT_ROLES.join(' | ')})`);
  map('effortByComplexity', COMPLEXITIES, (k) => `runtime.effortByComplexity.${k} must be ${COMPLEXITIES.slice(0, -1).join(', ')} or ${COMPLEXITIES.at(-1)}`);
  for (const r of Array.isArray(cfg.review?.panel) ? cfg.review.panel : []) {
    if (!isMap(r) || r.effort === undefined || r.effort === null || validEffort(r.effort)) continue;
    problems.push(`review.panel entry ${JSON.stringify(String(r.name ?? ''))}: effort must be one of ${levels} (got ${JSON.stringify(r.effort)})`);
  }
  return problems;
}

export function modelFor(config: Config, role: string): string {
  return config.runtime.models[role] ?? config.runtime.models.reviewer ?? 'inherit';
}

/** `v` when it is a string MODEL_RE accepts (at most 200 characters), else null. */
export function validModel(v: unknown): string | null {
  return typeof v === 'string' && v.length <= 200 && MODEL_RE.test(v) ? v : null;
}

/**
 * The one place a spawn's model is picked: step's spawn action, its `start --model` and the
 * roster all read it. Reviewers take their lens's panel `model`, then runtime.models.reviewer.
 * The builder takes the first valid of: runtime.reworkModel on a rework round whose only inputs
 * are review findings, runtime.modelByComplexity[job.complexity], runtime.models.builder, inherit.
 * The judge on a real (non-eval) job is the post-merge scorer: scoring.model, then runtime.models.judge.
 * The Foreman's gate assistant takes foreman.assistants.model, its surveyors foreman.surveyors.model, and
 * an office run's director call (`director`) foreman.model. The senior pass (`senior`) takes foreman.senior.model, then the assistant's.
 */
export function resolveModel(config: Config, job: { complexity?: unknown; round?: unknown; kind?: unknown } | null, role: string, rework: readonly string[] = []): string {
  if (role === 'senior') return validModel(config.foreman?.senior?.model) ?? resolveModel(config, job, 'assistant');
  if (role === 'assistant') return validModel(config.foreman?.assistants?.model) ?? 'inherit';
  if (role === 'surveyor') return validModel(config.foreman?.surveyors?.model) ?? 'inherit';
  if (role === 'director') return validModel(config.foreman?.model) ?? 'inherit';
  if (role === 'judge' && job && job.kind !== 'eval') {
    return validModel(config.scoring?.model) ?? config.runtime.models.judge ?? 'inherit';
  }
  if (role.startsWith('reviewer:')) {
    const lens = role.slice('reviewer:'.length);
    return config.review.panel.find((p) => p.name === lens)?.model ?? config.runtime.models.reviewer ?? 'inherit';
  }
  if (role === 'builder') {
    const runtime: Partial<Config['runtime']> = config.runtime ?? {};
    const round = job?.round;
    // Only a pure review rework: a failed verify, feedback or an answer may need the stronger model.
    const reviewOnly = typeof round === 'number' && round >= 2 && rework.length === 1 && rework[0] === 'review';
    const fromRework = reviewOnly ? validModel(runtime.reworkModel) : null;
    if (fromRework) return fromRework;
    const complexity = (COMPLEXITIES as readonly unknown[]).includes(job?.complexity) ? (job!.complexity as string) : null;
    const byComplexity: Record<string, unknown> | null | undefined = runtime.modelByComplexity;
    const fromComplexity = complexity && byComplexity && typeof byComplexity === 'object' ? validModel(byComplexity[complexity]) : null;
    if (fromComplexity) return fromComplexity;
    return validModel(runtime.models?.builder) ?? 'inherit';
  }
  return config.runtime.models[role] ?? 'inherit';
}

/** `v` when it is one of EFFORTS, else null: anything else read from job.json or config counts as unset. */
export function validEffort(v: unknown): Effort | null {
  return (EFFORTS as readonly unknown[]).includes(v) ? (v as Effort) : null;
}

/** One level above `level` in EFFORTS order; max stays max. */
function bumpEffort(level: Effort): Effort {
  return EFFORTS[Math.min(EFFORTS.indexOf(level) + 1, EFFORTS.length - 1)];
}

/**
 * The one place effort levels combine: the daemon's argv, `forge job step`, the brief, the roster
 * and /api/state all call it, so they can never disagree. A null level passes nothing.
 * First valid of: job.effort, the lens's panel `effort` (reviewers), runtime.efforts.<base role>
 * (foreman.assistants.effort for the assistant, foreman.surveyors.effort for a surveyor, foreman.effort for the director), runtime.effortByComplexity[job.complexity],
 * runtime.effort. With no `role` (a daemon session runs
 * the orchestrator) only the job and runtime.effort layers apply. A builder on a rework round
 * (round >= 2) gets one level more unless the human set the job's own effort. The senior pass (`senior`) takes
 * foreman.senior.effort before the job layer, so a job marked low never weakens it; null falls through to the assistant.
 */
export function resolveEffort(
  config: Config,
  job?: { effort?: unknown; complexity?: unknown; round?: unknown } | null,
  role?: string | null,
): { level: Effort | null; source: EffortSource; rework?: true } {
  if (role === 'senior') {
    const senior = validEffort(config.foreman?.senior?.effort);
    return senior ? { level: senior, source: 'role' } : resolveEffort(config, job, 'assistant');
  }
  const own = validEffort(job?.effort);
  if (own) return { level: own, source: 'job' };
  let found: { level: Effort | null; source: EffortSource } | null = null;
  const base = role ? role.split(':')[0] : null;
  if (role && base) {
    const runtime: Partial<Config['runtime']> = config.runtime ?? {};
    const lens = base === 'reviewer' && role.startsWith('reviewer:') ? role.slice('reviewer:'.length) : null;
    const panel = lens && Array.isArray(config.review?.panel) ? config.review.panel.find((p) => p?.name === lens) : undefined;
    const fromPanel = validEffort(panel?.effort);
    const efforts: Record<string, unknown> | undefined = runtime.efforts;
    const fromRole =
      base === 'assistant'
        ? validEffort(config.foreman?.assistants?.effort)
        : base === 'surveyor'
          ? validEffort(config.foreman?.surveyors?.effort)
          : base === 'director'
          ? validEffort(config.foreman?.effort)
          : efforts && typeof efforts === 'object' && Object.hasOwn(efforts, base)
          ? validEffort(efforts[base])
          : null;
    const complexity = (COMPLEXITIES as readonly unknown[]).includes(job?.complexity) ? (job!.complexity as string) : null;
    const byComplexity: Record<string, unknown> | undefined = runtime.effortByComplexity;
    const fromComplexity = complexity && byComplexity && typeof byComplexity === 'object' ? validEffort(byComplexity[complexity]) : null;
    if (fromPanel) found = { level: fromPanel, source: 'panel' };
    else if (fromRole) found = { level: fromRole, source: 'role' };
    else if (fromComplexity) found = { level: fromComplexity, source: 'complexity' };
  }
  if (!found) {
    const fallback = validEffort(config.runtime?.effort);
    found = fallback ? { level: fallback, source: 'config' } : { level: null, source: 'none' };
  }
  const round = job?.round;
  if (base === 'builder' && found.level && typeof round === 'number' && round >= 2) return { level: bumpEffort(found.level), source: found.source, rework: true };
  return found;
}
