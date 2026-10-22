// A job's state as the dashboard reads it: tones, chip text, waits that need a human, the drawer's Resume. No DOM access.
import type { Job, JobPr, OwnerStatus, Progress, WaitingOn } from './types.ts';
import { PARK_LABEL, REPO_HOLD_LABEL, WAIT_LABEL } from './labels.ts';
import { isRepoHold } from './repo-budget.ts';

/** job.json can be hand-edited, so helpers read fields defensively despite the types. */
export type JobLike = Partial<Job> & { progress?: Progress };
export type Tone = 'ok' | 'bad' | 'warn' | 'info' | 'muted' | 'live' | 'you';

const s = (v: unknown): string => String(v ?? '');

export function stateTone(job: JobLike): Tone {
  if (job.state === 'done') return 'ok';
  if (job.state === 'failed') return 'bad';
  if (job.state === 'cancelled') return 'muted';
  if (isDependencyPark(job)) return 'muted';
  // Every other wait but pr-review needs a human (needsHuman), which Smithy marks in ember.
  if (job.state === 'waiting') return job.waitingOn === 'pr-review' ? 'info' : 'you';
  if (job.state === 'blocked') return 'bad';
  if (job.state === 'running') return 'live';
  return 'muted';
}

// A repo hold reads apart from a job's own budget stop, so the two are told apart at a glance.
export const stateText = (job: JobLike): string =>
  isDependencyPark(job) ? PARK_LABEL : isRepoHold(job) ? REPO_HOLD_LABEL : s(job.state === 'waiting' ? (WAIT_LABEL[job.waitingOn as WaitingOn] ?? job.waitingOn) : job.state);

export const verdictTone = (v: string | null | undefined): Tone => (v === 'PASS' ? 'ok' : v === 'CHANGES' ? 'bad' : v === 'MALFORMED' ? 'warn' : 'muted');

/** A PR chip's tone and text; with `repo` (a member repo's PR), the text is `<repo>#<n>`. */
export function prChipModel(pr: Partial<Omit<JobPr, 'url'>> | null | undefined, repo?: string): { tone: Tone; text: string } | null {
  if (!pr?.number) return null;
  const tone: Tone = pr.state === 'MERGED' ? 'ok' : pr.state === 'CLOSED' ? 'muted' : pr.conflicts ? 'warn' : pr.checks?.state === 'failing' ? 'bad' : pr.checks?.state === 'pending' ? 'warn' : 'info';
  const extra = pr.conflicts ? ' · conflicts' : pr.checks?.state && pr.checks.state !== 'none' ? ` · ${pr.checks.state}` : '';
  return { tone, text: `${repo ?? ''}#${pr.number}${extra}` };
}

/** Percent width of the progress bar, or null when there is no bar. */
export const progressWidth = (p: Progress | null | undefined): number | null => (p?.total ? Math.round((p.done / p.total) * 100) : null);

/** Roles with a running agent, for the card footer. */
export const runningRoles = (job: JobLike): string[] =>
  Object.entries(job.agents ?? {})
    .filter(([, a]) => a.status === 'running')
    .map(([role]) => role);

export type AgentsSummary = { kind: 'role'; role: string; title: string } | { kind: 'reviewers' | 'agents'; count: number; title: string };

/** The card footer's running-agents line: the role when one runs, else a count (all reviewers or mixed); the title lists every role. */
export function agentsSummary(roles: string[]): AgentsSummary | null {
  if (!roles.length) return null;
  const title = roles.join(', ');
  if (roles.length === 1) return { kind: 'role', role: roles[0] as string, title };
  const reviewers = roles.every((r) => r === 'reviewer' || r.startsWith('reviewer:'));
  return { kind: reviewers ? 'reviewers' : 'agents', count: roles.length, title };
}

/** Whether any of a job's issues names an item: a url-only entry never counts as linked. */
export const hasLinkedIssue = (issues: unknown): boolean => Array.isArray(issues) && issues.some((i) => Boolean(i && typeof i === 'object' && (i as { ref?: unknown }).ref));

/** lib/engine/pipeline/deps.ts DEP_REASON; test/dashboard-view.test.ts pins the two equal. */
export const DEP_PARK_PREFIX = 'dependencies not done: ';

/** A job the engine parked until its dependencies finish: it resumes by itself, so no human is needed. */
export const isDependencyPark = (j: JobLike): boolean => j.state === 'waiting' && j.waitingOn === 'external' && s(j.reason).startsWith(DEP_PARK_PREFIX);

/** A waiting job a human must act on (pr-review waits are listed separately; dependency parks wait on other jobs). */
export const needsHuman = (j: JobLike): boolean => j.state === 'waiting' && j.waitingOn !== 'pr-review' && !isDependencyPark(j);

/** Not done and not cancelled: the board's Active filter and the nav's count. */
export const isOpen = (j: JobLike): boolean => !['done', 'cancelled'].includes(j.state as string);

/** The drawer's Resume: shown, whether it can be clicked, and which owner note goes beside it. */
export interface ResumeModel {
  show: boolean;
  enabled: boolean;
  note: 'live' | 'expired' | null;
}

/**
 * Resume is for an open, non-eval job nobody is driving: queued or failed, or any non-waiting job
 * whose lease expired (waiting jobs keep their gate buttons). Another driver's live lease disables
 * it, since the job's session would refuse the claim; the server refuses it too (409). The
 * exception is a live lease held by the job's own pool session, which takes the resume itself.
 */
export function resumeModel(j: Pick<JobLike, 'state' | 'kind'> & { ownerStatus?: OwnerStatus | null }): ResumeModel {
  const status = j.ownerStatus?.status ?? 'none';
  const hidden: ResumeModel = { show: false, enabled: false, note: null };
  if (j.kind === 'eval' || j.state === 'done' || j.state === 'cancelled' || j.state === 'waiting') return hidden;
  if (!(j.state === 'queued' || j.state === 'failed' || status === 'expired')) return hidden;
  // The job's own pool session takes the resume itself, so its live lease doesn't block it.
  if (status === 'live' && j.ownerStatus?.jobSession) return { show: true, enabled: true, note: null };
  const note = status === 'live' ? 'live' : status === 'expired' ? 'expired' : null;
  return { show: true, enabled: status !== 'live', note };
}
