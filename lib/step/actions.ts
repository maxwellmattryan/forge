// The actions a rule returns. Every command is built from ids, numbers, config names and fixed
// templates, never from file contents or agent replies, and shellLine refuses an argument outside a
// strict class, so an unattended daemon can run the result as-is.
import path from 'node:path';
import { renderBrief, roleBrief } from '../brief.ts';
import type { RoleContext } from '../brief.ts';
import { resolveEffort, resolveModel } from '../config.ts';
import { reviewFileName } from '../lens.ts';
import { AGENT_ID } from '../transcripts.ts';
import type { StepDone, StepInput, StepProcedure, StepRun, StepSpawn, StepWait, StepWaitingOn, WaitingOn } from '../types.ts';
import { ForgeError } from '../util.ts';
import { after, agent, human, isPrRework, lastConflicts, lastEvent, lastVerify, p, pendingVerifiers, ref, runningRoles, splitMode } from './facts.ts';
import { reworkReviewFiles } from './panel.ts';
import type { RuleId } from './rules.ts';

export const SAFE_ELEMENT = /^[A-Za-z0-9 ._:/@=,+\-[\]"]*$/;
export const BARE_ELEMENT = /^[A-Za-z0-9._:/@=,+-]+$/;
export const SAFE_URL = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._/-]+$/;

export const safe = (v: string | null | undefined, re: RegExp, fallback: string) => (v && re.test(v) ? v : fallback);

/**
 * One ready-to-run command line. Every element is checked against the class the spec allows, so a
 * value that would need escaping is a bug in step, not something to quote around.
 */
export function shellLine(argv: string[]): string {
  for (const a of argv) {
    if (!SAFE_ELEMENT.test(a) || a.includes("'")) throw new ForgeError(`forge job step built an unsafe argument ${JSON.stringify(a)}; this is a bug in Forge`);
  }
  return 'forge ' + argv.map((a) => (BARE_ELEMENT.test(a) ? a : `'${a}'`)).join(' ');
}

export function run(x: StepInput, rule: RuleId, command: string[], why: string, tell?: string): StepRun {
  return { action: 'run', rule, id: x.job.id, command, shell: shellLine(command), why, ...(tell ? { tell } : {}) };
}

/** `job set` with only the flags given, in a fixed order. */
export function set(x: StepInput, rule: RuleId, c: { stage?: string; state?: string; waitingOn?: WaitingOn; reason?: string; note?: string; fields?: string[] }, why: string, tell?: string): StepRun {
  const argv = ['job', 'set', x.job.id];
  for (const f of c.fields ?? []) argv.push('--field', f);
  if (c.stage) argv.push('--stage', c.stage);
  if (c.state) argv.push('--state', c.state);
  if (c.waitingOn) argv.push('--waiting-on', c.waitingOn);
  if (c.reason) argv.push('--reason', c.reason);
  if (c.note) argv.push('--note', c.note);
  return run(x, rule, argv, why, tell);
}

export const toStage = (x: StepInput, rule: RuleId, stage: string, why: string, extra: { note?: string; tell?: string } = {}) =>
  set(x, rule, { stage, state: stage === 'done' ? 'done' : 'running', note: extra.note }, why, extra.tell);

export const park = (x: StepInput, rule: RuleId, waitingOn: WaitingOn, reason: string, note?: string) =>
  set(x, rule, { state: 'waiting', waitingOn, reason, note }, `wait on ${waitingOn}`);

export function wait(x: StepInput, rule: RuleId, waitingOn: StepWaitingOn, tell?: string): StepWait {
  return { action: 'wait', rule, id: x.job.id, waitingOn, running: runningRoles(x), ...(tell ? { tell } : {}) };
}

export function procedure(x: StepInput, rule: RuleId, name: string, why: string): StepProcedure {
  return { action: 'procedure', rule, id: x.job.id, reference: ref(x, name), why };
}

export function done(x: StepInput, rule: RuleId, tell?: string): StepDone {
  return { action: 'done', rule, id: x.job.id, state: x.job.state, ...(tell ? { tell } : {}) };
}

/** The single output step names for a role, absolute; builders and integrators have none. */
export function outputFor(x: StepInput, role: string): string | undefined {
  if (role.startsWith('reviewer:')) {
    const lens = role.slice('reviewer:'.length);
    return x.job.stage === 'integrate' ? p(x, 'integrationReview') : path.join(x.jobDir, 'review', `round-${x.job.round}`, reviewFileName(lens));
  }
  if (role === 'verifier') return path.join(x.jobDir, 'verify', `round-${x.job.round}-verifier-answers.md`);
  const fixed: Record<string, string> = { planner: 'plan.md', 'spec-writer': 'spec.md', designer: 'design.md', approver: 'decision.md', judge: x.job.kind === 'eval' ? 'eval-judge.md' : 'score.md' };
  return fixed[role] ? path.join(x.jobDir, fixed[role]) : undefined;
}

/** The builder's rework inputs this spawn, in the order its brief lists them. */
export function builderRework(x: StepInput): NonNullable<RoleContext['rework']> {
  const j = x.job;
  const b = agent(x, 'builder');
  const lv = lastVerify(x);
  const reworkEv = human(x, 'rework');
  const out: NonNullable<RoleContext['rework']> = [];
  const prev = j.verdicts[String(j.round - 1)];
  if (j.round > 1 && prev && Object.values(prev).some((v) => v !== 'PASS')) out.push('review');
  if (lv && !lv.ok && after(lv.at, b?.endedAt)) out.push(lv.failure === 'verifiers' ? 'verifiers' : 'verify');
  if (isPrRework(x) && x.files.prFeedback) out.push('pr-feedback');
  if (x.files.feedback && (j.round > 1 || reworkEv)) out.push('feedback');
  if (x.files.questions && human(x, 'answer')) out.push('answer');
  return out;
}

/** A spawn of `role` with the context its stage implies. */
export function spawn(x: StepInput, rule: RuleId, role: string, o: { resume?: boolean; retry?: boolean; retryLine?: string; answered?: boolean } = {}): StepSpawn {
  const j = x.job;
  const base = role.split(':')[0];
  const lens = base === 'reviewer' ? role.slice('reviewer:'.length) : undefined;
  const output = outputFor(x, role);
  const ctx: RoleContext = { lens, output: base === 'reviewer' ? output : undefined, answered: o.answered };
  if (o.retry) ctx.retry = o.retryLine ?? `Retry: ${output} was not written last time; write it before you reply.`;
  const conflicts = lastConflicts(x);
  const conflictFiles = Array.isArray(conflicts?.conflicts) ? (conflicts.conflicts as unknown[]).map(String) : [];
  const regenerated = Array.isArray(conflicts?.regenerated) ? (conflicts.regenerated as unknown[]).map(String) : [];
  if (base === 'planner') ctx.splitMode = splitMode(x);
  if (base === 'spec-writer') ctx.foldIn = j.stage === 'design';
  if (base === 'designer') ctx.mode = x.config.pipeline.design === 'mockup' && j.kind !== 'eval' ? 'mockup' : 'reference';
  if (base === 'builder') {
    ctx.rework = builderRework(x);
    if (ctx.rework.includes('review')) ctx.reworkReviews = reworkReviewFiles(j, (x.paths.previousReviewDir as string | null) ?? null);
  }
  if (base === 'reviewer' && j.stage === 'integrate') ctx.integration = { conflicts: conflictFiles };
  if (base === 'verifier') {
    const sel = pendingVerifiers(x)?.selected;
    ctx.verifiers = Array.isArray(sel) ? sel.length : 0;
  }
  if (base === 'integrator') {
    // The fix pass: an integration review of this episode's resolution asked for changes.
    const review = lastEvent(x, (e) => e.type === 'integration-review');
    ctx.integration = { conflicts: conflictFiles, regenerated, fix: Boolean(review && review.outcome === 'CHANGES' && after(review.ts, conflicts?.ts)) };
    ctx.strategy = x.config.pr.updateStrategy;
  }
  const model = resolveModel(x.config, x.job, role, ctx.rework ?? []);
  const a = agent(x, role);
  const resume = o.resume && a?.agentId && AGENT_ID.test(a.agentId) ? a.agentId : undefined;
  const parallel = base === 'reviewer' && j.stage === 'review';
  const start = ['job', 'agent', j.id, 'start', '--role', role, '--model', model, ...(output ? ['--output', output] : []), ...(o.retry ? ['--retry'] : [])];
  return {
    action: 'spawn',
    rule,
    id: j.id,
    role,
    agent: `forge:${base}`,
    ...(lens ? { lens } : {}),
    model,
    round: j.round,
    ...(output ? { output } : {}),
    ...(o.retry ? { retry: true as const } : {}),
    ...(resume ? { resume } : {}),
    ...(parallel ? { parallel: true as const } : {}),
    start,
    startShell: shellLine(start),
    brief: renderBrief(x, roleBrief(x, role, ctx)),
    // Always present, so the orchestrator can tell "pass none" from an older Forge that never said.
    effort: resolveEffort(x.config, x.job, role).level,
  };
}
