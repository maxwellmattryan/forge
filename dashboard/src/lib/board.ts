// The Pipeline page's board and table: filters, counts, columns, urgency order and each card's slots. No DOM access.
import type { Progress, Stage } from './types.ts';
import { STAGE_LABEL } from './labels.ts';
import { protectedSummary } from './protected.ts';
import type { ProtectedSummary } from './protected.ts';
import { isOpen, needsHuman, progressWidth } from './job-state.ts';
import type { JobLike } from './job-state.ts';

const s = (v: unknown): string => String(v ?? '');

export function filterJobs<T extends JobLike>(jobs: T[], filter: string): T[] {
  const list = jobs.filter((j) => j.kind !== 'eval' || filter === 'all');
  if (filter === 'active') return list.filter(isOpen);
  if (filter === 'waiting') return list.filter((j) => ['waiting', 'blocked', 'failed'].includes(j.state as string));
  if (filter === 'done') return list.filter((j) => ['done', 'cancelled'].includes(j.state as string));
  return list;
}

export function pipelineCounts(jobs: JobLike[]): { all: number; active: number; waiting: number; done: number } {
  const all = jobs.filter((j) => j.kind !== 'eval');
  return {
    all: jobs.length,
    active: all.filter(isOpen).length,
    waiting: all.filter((j) => ['waiting', 'blocked', 'failed'].includes(j.state as string)).length,
    done: all.filter((j) => ['done', 'cancelled'].includes(j.state as string)).length,
  };
}

export const BOARD_GROUPS = [
  { id: 'queued', stages: ['backlog'] },
  { id: 'plan', stages: ['plan', 'spec', 'design'] },
  { id: 'build', stages: ['build', 'verify', 'review'] },
  { id: 'ship', stages: ['integrate', 'decide', 'pr'] },
  { id: 'done', stages: ['done'] },
] as const;
export type BoardGroupId = (typeof BOARD_GROUPS)[number]['id'];
/** The stepper's 9 stages: plan…pr, i.e. the plan, build and ship groups. */
export const STEPPER_STAGES: Stage[] = BOARD_GROUPS.slice(1, 4).flatMap((g) => [...g.stages]);

/** The board column a job sits in. A finished job left in an earlier stage still lands in Done, and a stage no group
 *  knows (a hand-edited job.json) lands in Queued so the job is never invisible. */
function boardGroup(j: JobLike): BoardGroupId {
  if (j.state === 'cancelled' || j.state === 'done' || j.stage === 'done') return 'done';
  return BOARD_GROUPS.find((g) => (g.stages as readonly string[]).includes(s(j.stage)))?.id ?? 'queued';
}

/** Urgency: 0 needs you, failed or blocked; 1 running; 2 PR review; 3 queued and other waits (dependency parks); 4 finished. */
function boardRank(j: JobLike): 0 | 1 | 2 | 3 | 4 {
  if (needsHuman(j) || j.state === 'failed' || j.state === 'blocked') return 0;
  if (j.state === 'running') return 1;
  if (j.state === 'waiting' && j.waitingOn === 'pr-review') return 2;
  if (j.state === 'done' || j.state === 'cancelled') return 4;
  return 3;
}

/** A new array by urgency, then newest updatedAt (a missing or invalid date last), then id ascending. */
export function sortByRank<T extends JobLike>(jobs: T[]): T[] {
  const time = (j: T) => {
    const ms = Date.parse(s(j.updatedAt));
    return Number.isNaN(ms) ? -Infinity : ms;
  };
  return jobs
    .map((j) => ({ j, rank: boardRank(j), at: time(j), id: s(j.id) }))
    .sort((a, b) => a.rank - b.rank || (a.at === b.at ? 0 : b.at > a.at ? 1 : -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((x) => x.j);
}

/** Queued, Plan, Build and Ship always; Done only when it holds a job. Each column is sorted by urgency. */
export function boardColumns<T extends JobLike>(jobs: T[]): { id: BoardGroupId; jobs: T[] }[] {
  const sorted = sortByRank(jobs);
  return BOARD_GROUPS.map((g) => ({ id: g.id, jobs: sorted.filter((j) => boardGroup(j) === g.id) })).filter((c) => c.id !== 'done' || c.jobs.length > 0);
}

export interface StageStep {
  stage: Stage;
  status: 'past' | 'current' | 'future';
  tone: 'gleam' | 'ember';
}

/** The card's 9-dot stepper over STEPPER_STAGES. Only the current step can be red: when the job needs a human, failed or is blocked. */
function stageSteps(j: JobLike): StageStep[] {
  const at = j.stage === 'done' ? STEPPER_STAGES.length : STEPPER_STAGES.indexOf(j.stage as Stage);
  const red = needsHuman(j) || j.state === 'failed' || j.state === 'blocked';
  return STEPPER_STAGES.map((stage, i) => {
    const status = at < 0 || i > at ? 'future' : i < at ? 'past' : 'current';
    return { stage, status, tone: status === 'current' && red ? 'ember' : 'gleam' };
  });
}

/** The 1-based step a screen reader hears: the current step, else the count of past steps (0 before plan, 9 when done). */
export const stepPosition = (steps: StageStep[]): number => {
  const i = steps.findIndex((x) => x.status === 'current');
  return i >= 0 ? i + 1 : steps.filter((x) => x.status === 'past').length;
};

/**
 * An issue as a short label: `#12` for a bare number, `repo#12` for `owner/repo#12` (the dashboard
 * knows no repo slug, so a qualified ref keeps its last segment), any other ref as it is.
 */
function issueLabel(ref: unknown): string | null {
  const r = s(ref);
  if (!r) return null;
  if (/^\d+$/.test(r)) return `#${r}`;
  const q = /(?:^|\/)([^/#]+)#(\d+)$/.exec(r);
  return q && r.includes('/') ? `${q[1]}#${q[2]}` : r;
}

/**
 * The card's tracker ref: the primary issue's label, plus ` +N` when more issues have refs. The
 * label is hidden for a local slug ref the id starts with, which would only print a near-copy of
 * the id; the count stays, so a multi-issue job never looks like a single-issue one.
 */
export function cardRef(job: JobLike): string | null {
  const refs = (Array.isArray(job.issues) ? job.issues : []).map((i) => s(i?.ref)).filter(Boolean);
  const first = refs[0];
  if (!first) return null;
  const more = refs.length > 1 ? `+${refs.length - 1}` : '';
  const label = issueLabel(first);
  if (!label || (!/^\d+$/.test(first) && !first.includes('/') && s(job.id).startsWith(first))) return more || null;
  return more ? `${label} ${more}` : label;
}

export interface CardModel {
  ref: string;
  refTitle: string;
  steps: StageStep[];
  stage: string;
  round: { round: number; max: number | null } | null;
  progress: Progress | null;
  lenses: { name: string; verdict: string | null }[] | null;
  /** The job is running: its stepper's current step carries the draw-on ring. */
  running: boolean;
  /** Protected paths the branch changes: the state slot's Protected chip. */
  protected: ProtectedSummary | null;
}

/** Everything a card's slots show, so JobCard reads no raw job state. */
export function cardModel(j: JobLike): CardModel {
  const round = Number(j.round) || 0;
  const verdicts = j.verdicts?.[round];
  return {
    ref: cardRef(j) ?? s(j.id),
    refTitle: s(j.id),
    steps: stageSteps(j),
    stage: STAGE_LABEL[j.stage as Stage] ?? s(j.stage),
    round: round > 0 ? { round, max: j.maxRounds ?? null } : null,
    progress: j.progress && progressWidth(j.progress) !== null ? j.progress : null,
    lenses: j.reviewers?.length ? j.reviewers.map((name) => ({ name, verdict: verdicts?.[name] ?? null })) : null,
    running: j.state === 'running',
    protected: protectedSummary({ protectedPaths: j.protectedPaths ?? null }),
  };
}
