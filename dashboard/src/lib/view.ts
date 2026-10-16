// The dashboard's view logic, ported as-is from the pre-Svelte app.js so node:test can pin it: components hold only markup.
// Plain functions and constants, no DOM access.
import type { EvalCompare, Job, JobEvent, JobPr, OwnerStatus, Progress, RequestType, Stage, StateJob, WaitingOn } from './types.ts';
import { PARK_LABEL, STAGE_LABEL, WAIT_LABEL } from './labels.ts';

/** job.json can be hand-edited, so helpers read fields defensively despite the types. */
type JobLike = Partial<Job> & { progress?: Progress };
export type Tone = 'ok' | 'bad' | 'warn' | 'info' | 'muted' | 'live' | 'you';

const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
const s = (v: unknown): string => String(v ?? '');

// Labels come from messages/en.json (nav.<id>), through Nav.svelte.
export const VIEWS = [
  { id: 'pipeline', icon: 'pipeline' },
  { id: 'backlog', icon: 'backlog' },
  { id: 'agents', icon: 'agents' },
  { id: 'analytics', icon: 'analytics' },
  { id: 'evals', icon: 'evals' },
] as const;
export type ViewId = (typeof VIEWS)[number]['id'];

/** The view's 1-based position in the sidebar, for the status bar's SHEET fact; unknown ids read as the first view. */
export const viewIndex = (view: string): number => Math.max(0, VIEWS.findIndex((v) => v.id === view)) + 1;

// ---------- chips and cards ----------

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

export const stateText = (job: JobLike): string =>
  isDependencyPark(job) ? PARK_LABEL : s(job.state === 'waiting' ? (WAIT_LABEL[job.waitingOn as WaitingOn] ?? job.waitingOn) : job.state);

export const verdictTone = (v: string | null | undefined): Tone => (v === 'PASS' ? 'ok' : v === 'CHANGES' ? 'bad' : v === 'MALFORMED' ? 'warn' : 'muted');

export function prChipModel(pr: Partial<JobPr> | null | undefined): { tone: Tone; text: string } | null {
  if (!pr?.number) return null;
  const tone: Tone = pr.state === 'MERGED' ? 'ok' : pr.state === 'CLOSED' ? 'muted' : pr.conflicts ? 'warn' : pr.checks?.state === 'failing' ? 'bad' : pr.checks?.state === 'pending' ? 'warn' : 'info';
  const extra = pr.conflicts ? ' · conflicts' : pr.checks?.state && pr.checks.state !== 'none' ? ` · ${pr.checks.state}` : '';
  return { tone, text: `#${pr.number}${extra}` };
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

/**
 * The card's tracker ref: `#n` for a numeric ref, a non-numeric ref the id doesn't start with as-is (`ENG-4`), else
 * null. A local slug ref whose id is `<slug>-<suffix>` would only print a near-copy of the id.
 */
export function cardRef(job: JobLike): string | null {
  const ref = s(job.source?.ref);
  if (/^\d+$/.test(ref)) return `#${ref}`;
  if (ref && !s(job.id).startsWith(ref)) return ref;
  return null;
}

/** lib/deps.ts DEP_REASON; test/dashboard-view.test.ts pins the two equal. */
export const DEP_PARK_PREFIX = 'dependencies not done: ';

/** A job the engine parked until its dependencies finish: it resumes by itself, so no human is needed. */
export const isDependencyPark = (j: JobLike): boolean => j.state === 'waiting' && j.waitingOn === 'external' && s(j.reason).startsWith(DEP_PARK_PREFIX);

/** A waiting job a human must act on (pr-review waits are listed separately; dependency parks wait on other jobs). */
export const needsHuman = (j: JobLike): boolean => j.state === 'waiting' && j.waitingOn !== 'pr-review' && !isDependencyPark(j);

/** The drawer's Resume: shown, whether it can be clicked, and which owner note goes beside it. */
export interface ResumeModel {
  show: boolean;
  enabled: boolean;
  note: 'live' | 'agent' | 'stale' | 'gone' | null;
}

/**
 * Resume is for an open, non-eval job nobody is driving: queued or failed, or any non-waiting job
 * whose owner is stale or provably gone (waiting jobs keep their gate buttons). A live owner
 * disables it, since the job's session would refuse the claim; the server refuses it too (409).
 * The exception is a live owner that is the job's own daemon session, which takes the resume itself.
 */
export function resumeModel(j: Pick<JobLike, 'state' | 'kind'> & { ownerStatus?: OwnerStatus | null }): ResumeModel {
  const status = j.ownerStatus?.status ?? 'none';
  const hidden: ResumeModel = { show: false, enabled: false, note: null };
  if (j.kind === 'eval' || j.state === 'done' || j.state === 'cancelled' || j.state === 'waiting') return hidden;
  const idle = status === 'stale' || status === 'dead';
  if (!(j.state === 'queued' || j.state === 'failed' || idle)) return hidden;
  // The job's own daemon session takes the resume itself, so its live claim doesn't block it.
  if (status === 'live' && j.ownerStatus?.jobSession) return { show: true, enabled: true, note: null };
  const note = status === 'live' ? (j.ownerStatus?.agentRunning ? 'agent' : 'live') : status === 'stale' ? 'stale' : status === 'dead' ? 'gone' : null;
  return { show: true, enabled: status !== 'live', note };
}

// ---------- pipeline ----------

const isOpen = (j: JobLike) => !['done', 'cancelled'].includes(j.state as string);

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

// ---------- board ----------

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
export function boardGroup(j: JobLike): BoardGroupId {
  if (j.state === 'cancelled' || j.state === 'done' || j.stage === 'done') return 'done';
  return BOARD_GROUPS.find((g) => (g.stages as readonly string[]).includes(s(j.stage)))?.id ?? 'queued';
}

/** Urgency: 0 needs you, failed or blocked; 1 running; 2 PR review; 3 queued and other waits (dependency parks); 4 finished. */
export function boardRank(j: JobLike): 0 | 1 | 2 | 3 | 4 {
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
export function stageSteps(j: JobLike): StageStep[] {
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

export interface CardModel {
  ref: string;
  refTitle: string;
  steps: StageStep[];
  stage: string;
  round: { round: number; max: number | null } | null;
  progress: Progress | null;
  lenses: { name: string; verdict: string | null }[] | null;
  /** The job is running: its stepper's current step carries the live halo. */
  running: boolean;
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
  };
}

export function navCounts(jobs: JobLike[]): { active: number; needs: number } {
  return { active: jobs.filter(isOpen).length, needs: jobs.filter((j) => needsHuman(j) || j.state === 'failed').length };
}

const live = (o: { heartbeat?: string | null; since?: string | null }, now: number) => now - Date.parse(s(o.heartbeat ?? o.since)) < 30 * 60000;

// ---------- inbox ----------

export function inboxGroups<T extends JobLike>(jobs: T[]): { urgent: T[]; prs: T[]; parks: T[] } {
  return {
    urgent: jobs.filter((j) => needsHuman(j) || j.state === 'failed' || j.state === 'blocked'),
    prs: jobs.filter((j) => j.state === 'waiting' && j.waitingOn === 'pr-review'),
    parks: jobs.filter(isDependencyPark),
  };
}

export type InboxKind = WaitingOn | 'failed' | null | undefined;

export const inboxKind = (job: JobLike): InboxKind => (job.state === 'failed' ? 'failed' : job.waitingOn);

/** The file the card links to ("Read … →"), or null. */
export function inboxDoc(kind: InboxKind, job: JobLike): string | null {
  const docs: Record<string, string> = { 'spec-approval': 'spec.md', 'split-approval': 'plan.md', 'issue-link': 'issue-candidates.md', input: 'questions.md', escalation: 'decision.md', infra: 'runbook.md', 'rounds-exhausted': `review/round-${job.round}` };
  return docs[s(kind)] ?? null;
}

/** SP5's reason in lib/step.ts for a job with no issue yet: its spec gate also picks the issue. */
export const UNLINKED_SPEC_REASON = 'spec ready, issue unlinked';

/** A spec gate that still needs an issue: the chooser stands in for the plain Approve. Re-checks source and noIssue, so a job linked while it waits gets the plain card. */
export const specLinkPending = (j: Pick<JobLike, 'state' | 'waitingOn' | 'reason' | 'source' | 'noIssue'>): boolean =>
  j.state === 'waiting' && j.waitingOn === 'spec-approval' && j.reason === UNLINKED_SPEC_REASON && !j.source?.ref && !j.noIssue;

export function notePlaceholder(kind: InboxKind, opts: { linkPending?: boolean } = {}): string {
  // On an unlinked spec gate the note is also the "no issue needed" reason.
  if (kind === 'spec-approval' && opts.linkPending) return 'Optional note for the agents, or why no issue is needed…';
  return kind === 'input'
    ? 'Your answer…'
    : kind === 'budget'
      ? 'Optional: new limits, e.g. usd=20 tokens=2000000'
      : kind === 'issue-link'
        ? 'Optional: why this job needs no issue…'
        : 'Optional note for the agents…';
}

export const showsNote = (kind: InboxKind): boolean => ['spec-approval', 'split-approval', 'issue-link', 'input', 'escalation', 'rounds-exhausted', 'budget', 'human'].includes(s(kind));

export interface InboxAction {
  label: string;
  type: RequestType;
  primary: boolean;
  needsNote: boolean;
  text?: string;
}

const act = (label: string, type: RequestType, primary = false, needsNote = false, text?: string): InboxAction =>
  text === undefined ? { label, type, primary, needsNote } : { label, type, primary, needsNote, text };

export function inboxActions(kind: InboxKind, opts: { linkPending?: boolean } = {}): InboxAction[] {
  switch (kind) {
    case 'spec-approval':
      // Each IssueLinkActions button approves the spec too, so a plain Approve would skip the link.
      if (opts.linkPending) return [act('Request changes', 'revise-spec', false, true)];
      return [act('Approve spec', 'approve', true), act('Request changes', 'revise-spec', false, true)];
    case 'split-approval':
      return [act('Approve split', 'approve', true), act('Keep as one job', 'revise-spec')];
    // The link, create and no-issue buttons come from IssueLinkActions.svelte.
    case 'issue-link':
      return [act('Cancel job', 'cancel')];
    case 'input':
      return [act('Send answer', 'answer', true, true)];
    // A CLI check (the secret scan) stopped the job: Approve means "I cleared it, check again", never "ship it anyway".
    case 'escalation':
    case 'human':
      return [act('Approve', 'approve', true), act('Rework', 'rework', false, true), act('Cancel job', 'cancel')];
    case 'rounds-exhausted':
      return [act('Another round', 'rework', false, true), act('Accept as is', 'approve'), act('Cancel job', 'cancel')];
    case 'budget':
      return [act('Approve & continue', 'approve', true, true), act('Cancel job', 'cancel')];
    case 'infra':
      return [act('Steps done, resume', 'resume', true)];
    case 'conflicts':
      return [act('Fix conflicts now', 'rework', true, false, 'Resolve merge conflicts with the base branch'), act('Leave for later', 'resume')];
    case 'external':
      return [act('Unblocked, resume', 'resume')];
    case 'failed':
      return [act('Retry', 'resume'), act('Cancel job', 'cancel')];
    default:
      return [act('Resume', 'resume')];
  }
}

// ---------- requests ----------

export interface RequestBody {
  type: RequestType;
  job?: string | null;
  text?: string | null;
  args: Record<string, unknown>;
}

export interface RequestInput {
  type: RequestType;
  job?: string | null;
  /** The inbox card's note; null outside a card. */
  note?: string | null;
  needsNote?: boolean;
  /** A button's fixed text, which wins over the note. */
  fixedText?: string | null;
  ref?: string | null;
  /** Extra args (`n` for next, `link` for an issue-link approve), merged after `ref`. */
  args?: Record<string, unknown>;
}

/** The POST /api/requests body a request button sends, or the toast it shows instead. */
export function buildRequest({ type, job = null, note = null, needsNote = false, fixedText = null, ref = null, args }: RequestInput): { body: RequestBody } | { error: string } {
  const text = fixedText ?? note?.trim() ?? null;
  if (needsNote && !text && ['answer', 'revise-spec'].includes(type)) return { error: 'Write something first.' };
  return { body: { type, job: job ?? null, text: text || null, args: { ...(ref ? { ref } : {}), ...(args ?? {}) } } };
}

export function evalRunBody(form: { tags?: string | null; tasks?: string | null; label?: string | null }): RequestBody {
  const val = (v: string | null | undefined) => v?.trim() || null;
  return { type: 'eval-run', args: { tags: val(form.tags), tasks: val(form.tasks), label: val(form.label) } };
}

export const queuedMessage = (type: string, daemon: unknown): string =>
  daemon ? `Queued "${type}". The daemon picks it up.` : `Queued "${type}". Your orchestrator session picks it up (/forge requests).`;

// ---------- agents ----------

export interface RunningAgent {
  job: StateJob;
  role: string;
  model?: string | null;
  round?: number;
  startedAt?: string;
}

export const runningAgents = (jobs: StateJob[]): RunningAgent[] =>
  jobs.flatMap((j) =>
    Object.entries(j.agents ?? {})
      .filter(([, a]) => a.status === 'running')
      .map(([role, a]) => ({ job: j, role, ...a })),
  );

export interface SessionRow {
  session: string;
  host?: string;
  since?: string;
  heartbeat?: string;
  jobs: StateJob[];
  live: boolean;
}

export function agentSessions(jobs: StateJob[], now: number): SessionRow[] {
  const sessions: Record<string, Omit<SessionRow, 'live'>> = {};
  for (const j of jobs) if (j.owner) (sessions[j.owner.session] ??= { ...j.owner, jobs: [] }).jobs.push(j);
  return Object.values(sessions).map((x) => ({ ...x, live: live(x, now) }));
}

// ---------- analytics ----------

/** The query for /api/stats: `?since=<iso>` for a day window, '' for all time. */
export function statsQuery(window: string, now: number): string {
  const since = window === 'all' ? '' : new Date(now - Number(window) * 86400000).toISOString();
  return since ? `?since=${encodeURIComponent(since)}` : '';
}

export const STATS_WINDOWS = [
  ['7', 'Last 7 days'],
  ['30', 'Last 30 days'],
  ['90', 'Last 90 days'],
  ['all', 'All time'],
] as const;

/** Usage rows by descending tokens, with the bar width the table draws. */
export function usageBars<T extends { tokens: number }>(rows: Record<string, T>): { key: string; row: T; width: number }[] {
  const max = Math.max(1, ...Object.values(rows).map((v) => v.tokens));
  return Object.entries(rows)
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([key, row]) => ({ key, row, width: Math.max(2, (row.tokens / max) * 100) }));
}

export const topJobsByUsage = (jobs: StateJob[]): StateJob[] =>
  jobs
    .filter((j) => j.kind !== 'eval' && j.usage?.totalTokens)
    .sort((a, b) => b.usage.totalTokens - a.usage.totalTokens)
    .slice(0, 25);

export const jobMs = (j: JobLike): number | null => Date.parse(s(j.finishedAt ?? j.updatedAt)) - Date.parse(s(j.createdAt)) || null;

// ---------- evals ----------

const BETTER: Record<string, number> = { checkPassRate: 1, avgJudgeScore: 1, firstPassRate: 1, avgRounds: -1, escalationRate: -1, avgTokens: -1, avgCostUsd: -1, avgMinutes: -1 };

export interface CompareRow {
  key: string;
  a: string;
  b: string;
  change: string;
  tone: 'text-muted' | 'text-ok' | 'text-bad';
}

export function compareRows(c: EvalCompare): CompareRow[] {
  return Object.entries(c.delta)
    .filter(([k]) => k in BETTER)
    .map(([key, d]) => ({
      key,
      a: s(d.a ?? '—'),
      b: s(d.b ?? '—'),
      change: d.change == null ? '—' : (d.change > 0 ? '+' : '') + d.change,
      tone: d.change == null || d.change === 0 ? 'text-muted' : Math.sign(d.change) === BETTER[key] ? 'text-ok' : 'text-bad',
    }));
}

// ---------- drawer ----------

const DRAWER_PREF = ['spec.md', 'decision.md', 'build.md', 'request.md'];

/** The file the drawer shows: the current one, its renamed match, or the preferred default. */
export function pickDrawerFile(files: string[], current: string | null): string | null {
  if (!current) return DRAWER_PREF.find((f) => files.includes(f)) ?? files[0] ?? null;
  if (!files.includes(current)) return files.find((f) => f.startsWith(current)) ?? current;
  return current;
}

/** A timeline row's detail as text around an optional bold part. */
export interface EventDetail {
  pre: string;
  bold: string | null;
  post: string;
}

export function eventDetail(e: JobEvent, fmt: { tokens: (n: number | null | undefined) => string; dur: (ms: number | null | undefined) => string }): EventDetail {
  const plain = (pre: string): EventDetail => ({ pre, bold: null, post: '' });
  if (e.type === 'transition') {
    const from = obj(e.from);
    const to = obj(e.to);
    return { pre: `${s(from.stage)}/${s(from.state)} → `, bold: `${s(to.stage)}/${s(to.state)}`, post: `${to.waitingOn ? ` (${s(to.waitingOn)})` : ''}${e.reason ? ` · ${s(e.reason)}` : ''}` };
  }
  if (e.type?.startsWith('agent-'))
    return plain(`${s(e.role)} ${e.model ? `(${s(e.model)})` : ''}${e.usage ? ` · ${fmt.tokens(e.usage.totalTokens)} tok` : ''}${e.summary ? ` · ${s(e.summary)}` : ''}`);
  if (e.type === 'command') return plain(`${s(e.name)} ${e.ok ? '✓' : `✗ exit ${s(e.exit)}`} · ${fmt.dur(e.durationMs)}`);
  if (e.type === 'note') return plain(s(e.text));
  if (e.type === 'human') return { pre: '', bold: s(e.action), post: e.note ? ` · ${s(e.note)}` : '' };
  return plain(JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['v', 'ts', 'type'].includes(k)))).slice(0, 240));
}

/** A `human` event the foreman recorded: the timeline labels it so a reader can tell it from a person's decision. */
export const isForemanEvent = (e: Partial<JobEvent> | null | undefined): boolean => e?.type === 'human' && e.actor === 'foreman';

/** A waiting job's gate owner badge: the foreman deciding it, or a human owning it; null for no owner (or an older server). */
export function gateOwnerBadge(owner: unknown): { foreman: boolean; tone: 'live' | 'you' } | null {
  if (owner === 'foreman') return { foreman: true, tone: 'live' };
  if (owner === 'human') return { foreman: false, tone: 'you' };
  return null;
}

/** Rounds of the drawer's verify/verdict matrix and the reviewer columns, or null when there is nothing to show. */
export function verdictMatrix(j: Partial<Job>): { rounds: number[]; reviewers: string[] } | null {
  const verdicts = j.verdicts ?? {};
  const verify = j.verify ?? {};
  const rounds = Object.keys(verdicts).map(Number).sort((a, b) => a - b);
  if (!rounds.length && !Object.keys(verify).length) return null;
  const reviewers = [...new Set([...(j.reviewers ?? []), ...rounds.flatMap((r) => Object.keys(verdicts[r] ?? {}))])];
  return { rounds: [...new Set([...rounds, ...Object.keys(verify).map(Number)])].sort((a, b) => a - b), reviewers };
}
