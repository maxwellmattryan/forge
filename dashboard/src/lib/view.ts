// The dashboard's view logic, ported as-is from the pre-Svelte app.js so node:test can pin it: components hold only markup.
// Plain functions and constants, no DOM access.
import { STAGES } from './types.ts';
import type { EvalCompare, Job, JobEvent, JobPr, OwnerStatus, Progress, RequestType, StateJob, WaitingOn } from './types.ts';
import { WAIT_LABEL } from './labels.ts';

/** job.json can be hand-edited, so helpers read fields defensively despite the types. */
type JobLike = Partial<Job> & { progress?: Progress };
type Tone = 'ok' | 'bad' | 'warn' | 'info' | 'muted' | 'live' | 'rev';

const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
const s = (v: unknown): string => String(v ?? '');

export const CORE_STAGES = new Set(['backlog', 'spec', 'build', 'review', 'pr', 'done']);

// Labels come from messages/en.json (nav.<id>), through Nav.svelte.
export const VIEWS = [
  { id: 'pipeline', icon: 'pipeline' },
  { id: 'inbox', icon: 'inbox' },
  { id: 'backlog', icon: 'backlog' },
  { id: 'agents', icon: 'agents' },
  { id: 'analytics', icon: 'analytics' },
  { id: 'evals', icon: 'evals' },
] as const;
export type ViewId = (typeof VIEWS)[number]['id'];

/** The view's 1-based position in the sidebar, for the title block's SHEET cell; unknown ids read as the first view. */
export const viewIndex = (view: string): number => Math.max(0, VIEWS.findIndex((v) => v.id === view)) + 1;

// ---------- chips and cards ----------

export function stateTone(job: JobLike): Tone {
  if (job.state === 'done') return 'ok';
  if (job.state === 'failed') return 'bad';
  if (job.state === 'cancelled') return 'muted';
  // Every wait but pr-review needs a human (needsHuman), which the Drafting system marks in redline.
  if (job.state === 'waiting') return job.waitingOn === 'pr-review' ? 'info' : 'rev';
  if (job.state === 'blocked') return 'bad';
  if (job.state === 'running') return 'live';
  return 'muted';
}

export const stateText = (job: JobLike): string =>
  s(job.state === 'waiting' ? (WAIT_LABEL[job.waitingOn as WaitingOn] ?? job.waitingOn) : job.state);

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

/** The card's tracker ref: `ref` when the id doesn't start with it, `#ref` for numeric refs, else null. */
export function cardRef(job: JobLike): string | null {
  const ref = job.source?.ref;
  if (ref && !s(job.id).startsWith(String(ref))) return String(ref);
  if (/^\d+$/.test(String(ref ?? ''))) return `#${ref}`;
  return null;
}

/** A waiting job a human must act on (pr-review waits are listed separately). */
export const needsHuman = (j: JobLike): boolean => j.state === 'waiting' && j.waitingOn !== 'pr-review';

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

export const boardStages = (jobs: JobLike[]): string[] => STAGES.filter((st) => CORE_STAGES.has(st) || jobs.some((j) => j.stage === st));

export function navCounts(jobs: JobLike[]): { active: number; needs: number } {
  return { active: jobs.filter(isOpen).length, needs: jobs.filter((j) => needsHuman(j) || j.state === 'failed').length };
}

const live = (o: { heartbeat?: string | null; since?: string | null }, now: number) => now - Date.parse(s(o.heartbeat ?? o.since)) < 30 * 60000;

/** Distinct orchestrator sessions that heartbeated in the last 30 minutes. */
export const activeSessions = (jobs: JobLike[], now: number): number =>
  new Set(jobs.filter((j) => j.owner && live(j.owner, now)).map((j) => j.owner?.session)).size;

// ---------- inbox ----------

export function inboxGroups<T extends JobLike>(jobs: T[]): { urgent: T[]; prs: T[] } {
  return {
    urgent: jobs.filter((j) => needsHuman(j) || j.state === 'failed' || j.state === 'blocked'),
    prs: jobs.filter((j) => j.state === 'waiting' && j.waitingOn === 'pr-review'),
  };
}

export type InboxKind = WaitingOn | 'failed' | null | undefined;

export const inboxKind = (job: JobLike): InboxKind => (job.state === 'failed' ? 'failed' : job.waitingOn);

/** The file the card links to ("Read … →"), or null. */
export function inboxDoc(kind: InboxKind, job: JobLike): string | null {
  const docs: Record<string, string> = { 'spec-approval': 'spec.md', 'split-approval': 'plan.md', 'issue-link': 'issue-candidates.md', input: 'questions.md', escalation: 'decision.md', infra: 'runbook.md', 'rounds-exhausted': `review/round-${job.round}` };
  return docs[s(kind)] ?? null;
}

export const notePlaceholder = (kind: InboxKind): string =>
  kind === 'input'
    ? 'Your answer…'
    : kind === 'budget'
      ? 'Optional: new limits, e.g. usd=20 tokens=2000000'
      : kind === 'issue-link'
        ? 'Optional: why this job needs no issue…'
        : 'Optional note for the agents…';

export const showsNote = (kind: InboxKind): boolean => ['spec-approval', 'split-approval', 'issue-link', 'input', 'escalation', 'rounds-exhausted', 'budget'].includes(s(kind));

export interface InboxAction {
  label: string;
  type: RequestType;
  primary: boolean;
  needsNote: boolean;
  text?: string;
}

const act = (label: string, type: RequestType, primary = false, needsNote = false, text?: string): InboxAction =>
  text === undefined ? { label, type, primary, needsNote } : { label, type, primary, needsNote, text };

export function inboxActions(kind: InboxKind): InboxAction[] {
  switch (kind) {
    case 'spec-approval':
      return [act('Approve spec', 'approve', true), act('Request changes', 'revise-spec', false, true)];
    case 'split-approval':
      return [act('Approve split', 'approve', true), act('Keep as one job', 'revise-spec')];
    // The link, create and no-issue buttons come from IssueLinkActions.svelte.
    case 'issue-link':
      return [act('Cancel job', 'cancel')];
    case 'input':
      return [act('Send answer', 'answer', true, true)];
    case 'escalation':
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

/** Rounds of the drawer's verify/verdict matrix and the reviewer columns, or null when there is nothing to show. */
export function verdictMatrix(j: Partial<Job>): { rounds: number[]; reviewers: string[] } | null {
  const verdicts = j.verdicts ?? {};
  const verify = j.verify ?? {};
  const rounds = Object.keys(verdicts).map(Number).sort((a, b) => a - b);
  if (!rounds.length && !Object.keys(verify).length) return null;
  const reviewers = [...new Set([...(j.reviewers ?? []), ...rounds.flatMap((r) => Object.keys(verdicts[r] ?? {}))])];
  return { rounds: [...new Set([...rounds, ...Object.keys(verify).map(Number)])].sort((a, b) => a - b), reviewers };
}
