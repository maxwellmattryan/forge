// The Needs-you inbox: its groups and each gate card's kind, doc, note, buttons and badges. No DOM access.
import { MANDATE_ID_SOURCE } from '../core/types.ts';
import type { DraftGate, ForgeRequest, HandoffClass, JobPr, LastHuman, RequestType, StateJob, WaitingOn } from '../core/types.ts';
import { isRepoHold } from '../metrics/repo-budget.ts';
import { isRepoProposal } from './repo-proposals.ts';
import { hasLinkedIssue, isDependencyPark, isShelved, needsHuman } from '../jobs/state.ts';
import type { JobLike } from '../jobs/state.ts';

const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
const s = (v: unknown): string => String(v ?? '');

/** The Needs-you popover's groups; only `urgent` counts towards Needs you, and `shelved` is the Shelved list. */
export function inboxGroups<T extends JobLike>(jobs: T[]): { urgent: T[]; prs: T[]; parks: T[]; shelved: T[] } {
  return {
    urgent: jobs.filter((j) => needsHuman(j) || j.state === 'failed' || j.state === 'blocked'),
    prs: jobs.filter((j) => j.state === 'waiting' && j.waitingOn === 'pr-review'),
    parks: jobs.filter(isDependencyPark),
    shelved: jobs.filter(isShelved),
  };
}

/** The Needs-you count: the decisions only a person makes (urgent jobs) plus each milestone draft waiting at its gate. */
export const needsCount = <T extends JobLike>(jobs: T[], drafts: readonly DraftGate[] | null | undefined): number => inboxGroups(jobs).urgent.length + (drafts?.length ?? 0);

const MANDATE_ID = new RegExp(MANDATE_ID_SOURCE);

/**
 * What a queued request is about, for its row: `{job}` for a job request, `{mandate}` for a goal mandate's
 * drafting run or its milestone-approval gate request, or for an `until: released` mandate's job-less
 * release gate request (only a valid mandate id, never `none`), else null.
 */
export function requestSubject(r: Pick<ForgeRequest, 'type' | 'job' | 'args'>): { job: string } | { mandate: string } | null {
  if (typeof r.job === 'string' && r.job) return { job: r.job };
  const args = obj(r.args);
  const mandateRequest = r.type === 'draft' || (r.type === 'gate' && (args.gate === 'milestone-approval' || args.gate === 'release'));
  const id = args.mandate;
  return mandateRequest && typeof id === 'string' && MANDATE_ID.test(id) && id !== 'none' ? { mandate: id } : null;
}

/**
 * `repo-budget`: a budget wait the repo cap set. Approving it lifts nothing, so its card offers only Cancel and points at the Repo budget section.
 * `repo-proposal`: step RP1's `human` wait on an agent's repo proposal, decided by RepoProposalActions (a plain Approve would only re-park it).
 */
export type InboxKind = WaitingOn | 'failed' | 'repo-budget' | 'repo-proposal' | null | undefined;

export const inboxKind = (job: JobLike): InboxKind => (job.state === 'failed' ? 'failed' : isRepoHold(job) ? 'repo-budget' : isRepoProposal(job) ? 'repo-proposal' : job.waitingOn);

/** The file the card links to ("Read … →"), or null. */
export function inboxDoc(kind: InboxKind, job: JobLike): string | null {
  const docs: Record<string, string> = { 'spec-approval': 'spec.md', 'split-approval': 'plan.md', 'issue-link': 'issue-candidates.md', input: 'questions.md', escalation: 'decision.md', infra: 'runbook.md', 'rounds-exhausted': `review/round-${job.round}`, 'repo-proposal': 'repo-proposals.md' };
  return docs[s(kind)] ?? null;
}

/** SP5's reason in lib/engine/pipeline/step/stages/spec.ts for a job with no issue yet: its spec gate also picks the issue. */
export const UNLINKED_SPEC_REASON = 'spec ready, issue unlinked';

/** A spec gate that still needs an issue: the chooser stands in for the plain Approve. Re-checks issues and noIssue, so a job linked while it waits gets the plain card. */
export const specLinkPending = (j: Pick<JobLike, 'state' | 'waitingOn' | 'reason' | 'issues' | 'noIssue'>): boolean =>
  j.state === 'waiting' && j.waitingOn === 'spec-approval' && j.reason === UNLINKED_SPEC_REASON && !hasLinkedIssue(j.issues) && !j.noIssue;

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

export const showsNote = (kind: InboxKind): boolean => ['spec-approval', 'split-approval', 'issue-link', 'input', 'escalation', 'rounds-exhausted', 'budget', 'human', 'repo-proposal'].includes(s(kind));

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
    case 'repo-budget':
      return [act('Cancel job', 'cancel')];
    // Approve repos and Reject repos come from RepoProposalActions.svelte, which POSTs the decision.
    case 'repo-proposal':
      return [act('Cancel job', 'cancel')];
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

/** The Needs-you card's "Last acted" line, from /api/state's lastHuman; null when nobody has acted. */
export function lastActed(job: { lastHuman?: LastHuman | null } | null | undefined): { who: string; foreman: boolean; ts: string } | null {
  const h = job?.lastHuman;
  if (!h || !h.actor || typeof h.ts !== 'string') return null;
  const foreman = h.actor.source === 'foreman';
  return { who: foreman ? 'foreman' : h.actor.login || 'unknown', foreman, ts: h.ts };
}

/** The reason `forge job step` (SC1, SC3) gives a job the secret scanner parked on `human`. */
export const SECRET_PARK_PREFIX = 'secret scan blocked ';

/**
 * A secret park, and whether the last approve already ran the scan again and parked once more: a
 * `waiting`/`human` transition after it. An approve nothing has acted on yet counts as not blocked,
 * so the signal errs towards no chip. Null for any other job.
 */
export function secretPark(j: Pick<StateJob, 'state' | 'waitingOn' | 'reason' | 'lastHuman' | 'lastEvent'>): { stillBlocked: boolean } | null {
  if (j.state !== 'waiting' || j.waitingOn !== 'human' || typeof j.reason !== 'string' || !j.reason.startsWith(SECRET_PARK_PREFIX)) return null;
  const h = j.lastHuman;
  const e = j.lastEvent;
  const to = obj(e?.to);
  const stillBlocked =
    h?.type === 'human' && h.action === 'approve' && e?.type === 'transition' && to.state === 'waiting' && to.waitingOn === 'human' && Date.parse(s(e.ts)) > Date.parse(s(h.ts));
  return { stillBlocked };
}

/** The reason `forge job step` (PR13, PP1) gives a park on a push `forge pr open` holds: lib/engine/guard/push-hold.ts. */
export const PUSH_HELD_PREFIX = 'push held: ';

/** The gates a merge gate on an open PR waits on: the escalation park (PR15) and the recall eval (PR17), and PR16's `infra` for a job parked before they collapsed. */
const MERGE_GATE_WAITS: readonly (WaitingOn | null | undefined)[] = ['escalation', 'infra', 'human'];

/**
 * What a gate card says about the PR beside its buttons: `open` for a merge gate on an open PR (in
 * stage pr, the PR waits on this decision before it can merge), `held` for a push `forge pr open`
 * holds (PR13's `human` park, or PP1's escalation park: nothing has left the machine), else null. A
 * secret park and a repo proposal stop something else, so they get neither.
 */
export function gatePrNote(j: Pick<JobLike, 'stage' | 'state' | 'waitingOn' | 'reason' | 'pr'>): { kind: 'open'; pr: JobPr } | { kind: 'held' } | null {
  if (j.state !== 'waiting') return null;
  const reason = s(j.reason);
  if ((j.waitingOn === 'human' || j.waitingOn === 'escalation') && reason.startsWith(PUSH_HELD_PREFIX)) return { kind: 'held' };
  if (j.stage !== 'pr' || !MERGE_GATE_WAITS.includes(j.waitingOn) || inboxKind(j) !== j.waitingOn) return null;
  if (reason.startsWith(SECRET_PARK_PREFIX) || isRepoProposal(j)) return null;
  return j.pr && j.pr.state === 'OPEN' ? { kind: 'open', pr: j.pr } : null;
}

/** One row of the Needs-you card's `Why it waits` list: an escalation park's rule, its detail and the paths it names. */
export interface GateReasonRow {
  rule: string;
  detail: string;
  paths: string[];
}

/**
 * The rows of /api/state's `gateReasons`, or null when the job has none (no escalation park listing
 * rules, an older server, or a malformed value). Components render each field as escaped text.
 */
export function gateReasonRows(j: { gateReasons?: unknown }): GateReasonRow[] | null {
  const list = j.gateReasons;
  if (!Array.isArray(list)) return null;
  const rows = list
    .map(obj)
    .filter((r) => typeof r.rule === 'string' && typeof r.detail === 'string')
    .map((r) => ({ rule: s(r.rule), detail: s(r.detail), paths: Array.isArray(r.paths) ? r.paths.filter((p: unknown): p is string => typeof p === 'string') : [] }));
  return rows.length ? rows : null;
}

/** A waiting job's gate owner badge: the foreman deciding it, or a human owning it; null for no owner (or an older server). */
export function gateOwnerBadge(owner: unknown): { foreman: boolean; tone: 'live' | 'you' } | null {
  if (owner === 'foreman') return { foreman: true, tone: 'live' };
  if (owner === 'human') return { foreman: false, tone: 'you' };
  return null;
}

const HANDOFF_CLASSES: readonly HandoffClass[] = ['reserved', 'escalated', 'refused'];

/** A job's Foreman hand-off as the card shows it; null for none, an older server or a malformed value. */
export function handoffNote(h: unknown): { cls: HandoffClass; reason: string } | null {
  if (!h || typeof h !== 'object') return null;
  const { class: cls, reason } = h as { class?: unknown; reason?: unknown };
  if (!HANDOFF_CLASSES.includes(cls as HandoffClass) || typeof reason !== 'string') return null;
  return { cls: cls as HandoffClass, reason };
}
