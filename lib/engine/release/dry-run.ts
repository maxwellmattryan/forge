// `forge release run --dry-run`: the plan `forge release run` would run, recomputed and compared as a run
// does, with each step's command, whether it would ask, and its status from a state.json of this plan.
// It runs nothing (no step, no check, no script, no `git fetch`), takes no lock and writes nothing, so
// neither a daemon session nor native Windows is refused.

import type { Config } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { type PlanOptions, type ReleaseStep, freshPlan, strategyOf } from './plan.ts';
import { assertNoSymlinks, planSteps, readPlanFile, readState, releaseFiles } from './files.ts';
import { stepCommand } from './render.ts';

export interface DryRunStep {
  id: string;
  title: string;
  command: string;
  publish: boolean;
  manual: boolean;
  /** A publish step that `forge release run` asks about on a terminal (and stops at without one). */
  asks: boolean;
  check: ReleaseStep['check'];
  status: 'done' | 'started' | 'failed' | 'pending';
}

export function dryRunRelease(root: string, config: Config, opts: PlanOptions = {}) {
  const files = releaseFiles(root);
  assertNoSymlinks(files);
  const file = readPlanFile(files);
  if (!file) throw new ForgeError('no release plan; run forge release plan', 'failed', 'forge release plan');
  const state = readState(files);
  const plan = freshPlan(root, config, file, state, opts);
  const own = state && state.planHash === plan.hash ? state : null;
  const steps: DryRunStep[] = planSteps(plan).map((s) => ({
    id: s.id,
    title: s.title,
    command: stepCommand(s),
    publish: s.publish,
    manual: s.manual !== null,
    asks: s.publish && s.manual === null && strategyOf(config, s.repo)?.publish !== 'allow',
    check: s.check,
    status: own?.steps[s.id]?.status ?? 'pending',
  }));
  const bumps = plan.repos.flatMap((r) => (r.bump ? [{ repo: r.label, from: r.bump.from, to: r.bump.to, bump: r.bump.bump, inferred: r.bump.inferred, reasons: r.bump.reasons, notes: r.bump.notes }] : []));
  return {
    dryRun: true as const,
    plan: files.md,
    hash: plan.hash.slice(0, 12),
    selection: plan.selection,
    done: steps.filter((s) => s.status === 'done').length,
    total: steps.length,
    steps,
    bumps,
  };
}
