// The rules that run before any stage: finished jobs, parks, running agents, lost runs, and the
// retro kind's own start.
import type { StepAction, StepInput, WaitingOn } from '../types.ts';
import { SAFE_REF } from '../util.ts';
import { SAFE_URL, done, procedure, run, safe, spawn, toStage, wait } from './actions.ts';
import { after, agent, ended, parkedRunning, pendingVerifiers, runningRoles, stageSince } from './facts.ts';
import { gateTell, prReviewTell } from './gates.ts';
import { nextLenses, retryLens } from './stages/review.ts';

/** The role whose lost or failed run blocks the current stage (L1); reviewers go through M1/M2 instead. */
export function blockedRole(x: StepInput): string | null {
  const j = x.job;
  const a = (r: string) => agent(x, r);
  const latest = (roles: string[]) => roles.filter((r) => a(r)?.startedAt).sort((m, n) => String(a(n)!.startedAt).localeCompare(String(a(m)!.startedAt)))[0] ?? null;
  let role: string | null = null;
  switch (j.stage) {
    case 'plan':
      role = 'planner';
      break;
    case 'spec':
      role = a('spec-writer') ? 'spec-writer' : null;
      break;
    case 'design':
      role = latest(['designer', 'spec-writer']);
      break;
    case 'build':
      role = a('builder')?.round === j.round ? 'builder' : null;
      break;
    case 'verify':
      role = pendingVerifiers(x) && after(a('verifier')?.startedAt, pendingVerifiers(x)!.ts) ? 'verifier' : null;
      break;
    case 'decide':
      role = latest(['approver', 'judge']);
      if (role === 'approver' && a('approver')?.round !== j.round) role = null;
      break;
    case 'integrate':
      role = after(a('integrator')?.startedAt, stageSince(x)) ? 'integrator' : null;
      break;
  }
  return role && ['lost', 'failed'].includes(String(a(role)?.status)) ? role : null;
}

/**
 * JS1-JS3: a done job's queued post-merge score run. Only a judge started after the queue counts,
 * so an older judge record never stands in for it; record then makes the score terminal.
 */
function scoreRun(x: StepInput): StepAction {
  const j = x.job;
  const judge = agent(x, 'judge');
  if (!after(judge?.startedAt, j.score!.queuedAt)) return spawn(x, 'JS2', 'judge');
  if (judge!.status === 'running') return wait(x, 'JS1', 'agents');
  return run(x, 'JS3', ['job', 'score', 'record', j.id], "record the judge's post-merge score");
}

export function globalStep(x: StepInput): StepAction | null {
  const j = x.job;
  if (j.state === 'done' && j.kind !== 'eval' && j.score?.status === 'queued') return scoreRun(x);
  if (j.state === 'done' || j.state === 'cancelled' || j.stage === 'done') {
    const tell = j.state === 'cancelled' ? `${j.id} is cancelled` : j.pr?.url ? `${j.id} is done: ${safe(j.pr.url, SAFE_URL, `PR #${Number(j.pr.number) || '?'}`)}` : `${j.id} finished on branch ${safe(j.branch, SAFE_REF, 'its branch')}`;
    return done(x, 'G1', tell);
  }
  if (j.state === 'failed') return done(x, 'G2', `${j.id} failed: ${j.reason ?? 'no reason recorded'}`);
  if (j.state === 'waiting' && j.waitingOn === 'pr-review') {
    if (j.lease.driver) return run(x, 'G3', ['job', 'release', j.id], 'the PR waits on human review; let the claim go');
    if (parkedRunning(x)) return run(x, 'G3', ['environment', 'stop', j.id], 'stop the environment while the PR waits');
    return wait(x, 'G3', 'pr-review', prReviewTell(x));
  }
  if (j.state === 'waiting' || j.state === 'blocked') {
    if (parkedRunning(x)) return run(x, 'G4', ['environment', 'stop', j.id], 'the job is parked: stop its environment');
    const on: WaitingOn = j.state === 'blocked' ? 'external' : (j.waitingOn ?? 'external');
    return wait(x, 'G4', on, gateTell(x, on));
  }
  // Only a job whose environment Forge stopped: one never started has no entry and starts on demand.
  if (j.state === 'running' && x.environment === 'stopped' && ['build', 'verify', 'review'].includes(j.stage))
    return run(x, 'E1', ['environment', 'up', j.id], 'a park stopped the environment', 'the job resumed: start its environment');
  if (runningRoles(x).length && !(j.stage === 'review' && (nextLenses(x).length || retryLens(x)))) return wait(x, 'G5', 'agents');
  const blocked = blockedRole(x);
  if (blocked) return spawn(x, 'L1', blocked);
  return null;
}

export function kindStep(x: StepInput): StepAction | null {
  const j = x.job;
  if (j.kind === 'retro') {
    const retro = agent(x, 'retro');
    if (!ended(retro) || !x.files.spec) return procedure(x, 'K1', 'retro.md', 'a retro job starts with the retro agent');
    if (j.stage === 'backlog') return toStage(x, 'K2', 'spec', 'the retro wrote spec.md');
  }
  return null;
}
