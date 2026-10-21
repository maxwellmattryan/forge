// The per-role rules every stage shares (N1, N2, M1, M2) and the X1 fallback.
import path from 'node:path';
import type { StepAction, StepInput, StepRun } from '../types.ts';
import { outputFor, park, set, spawn } from './actions.ts';
import { after, agent, ended, human, outputMissing } from './facts.ts';

const NEEDS_INPUT = /\bNEEDS-INPUT\b/i;

/** N1/N2: an agent that replied NEEDS-INPUT parks the job until a human answers, then resumes. */
export function needsInput(x: StepInput, role: string): StepAction | null {
  const a = agent(x, role);
  if (!ended(a) || !a.summary || !NEEDS_INPUT.test(a.summary)) return null;
  if (!after(human(x, 'answer')?.ts, a.endedAt)) {
    if (x.job.kind === 'eval') return set(x, 'N1', { state: 'failed', reason: 'eval: NEEDS-INPUT fails the task' }, 'an eval agent asked a question');
    return park(x, 'N1', 'input', `${role} has questions`);
  }
  return spawn(x, 'N2', role, { resume: true, answered: true });
}

/** M1/M2: a role that ended without its output gets one retry, then the job escalates. */
export function missingOutput(x: StepInput, role: string, retryLine?: string): StepAction | null {
  if (!outputMissing(x, role)) return null;
  const a = agent(x, role)!;
  if (!a.retry) return spawn(x, 'M1', role, { retry: true, retryLine });
  const file = path.basename(outputFor(x, role) ?? 'output');
  const reason = role.startsWith('reviewer:') ? `reviewer ${role.slice('reviewer:'.length)} wrote no review` : `${role} wrote no ${file}`;
  return park(x, 'M2', 'escalation', reason, `${role} ended twice without writing ${file}`);
}

export const generic = (x: StepInput, role: string) => needsInput(x, role) ?? missingOutput(x, role);

export function stuck(x: StepInput): StepRun {
  return park(x, 'X1', 'escalation', `step found no rule for stage ${x.job.stage}`);
}
