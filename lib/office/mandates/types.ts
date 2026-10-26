// The mandate shapes, type-only: the file `forge mandate` writes, the contract terms, the summary and
// state the CLI prints, and a goal mandate's milestone draft. The rules over them are contract.ts and
// draft.ts, the file I/O store.ts and draft.ts.
import type { DraftBody, EventActor, GateClass, MandateOnUnfinishable, MandateOrder, MandateUntil } from '#core/types.ts';
import type { MANDATE_STATUSES } from '#core/job/schema.ts';

/** A mandate's written status: only `forge mandate pause|resume|close` moves it. */
export type MandateStatus = (typeof MANDATE_STATUSES)[number];

/** What `forge mandate list|show` derives: `waiting` while `after` names a mandate that isn't closed. */
export type MandateState = 'active' | 'paused' | 'waiting' | 'closed';

/** The work a mandate covers: at least one list is non-empty (all empty for a goal mandate), milestones in order. */
export interface MandateScope {
  milestones: string[];
  labels: string[];
  issues: string[];
}

/** The contract terms besides scope and after. */
export interface MandateContract {
  until: MandateUntil;
  maxJobs: number;
  order: MandateOrder;
  decides: GateClass[];
  budget: { usd: number; jobs: number };
  stall: { cadences: number; bounces: number };
  onUnfinishable: MandateOnUnfinishable;
}

/** One `.forge/runtime/mandates/<id>.md`: every frontmatter key, then the owner's guidance as `body`. */
export interface Mandate extends MandateContract {
  schemaVersion: number;
  id: string;
  title: string;
  status: MandateStatus;
  reason: string | null;
  scope: MandateScope;
  after: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** When a goal mandate's draft was filed (filing.ts), which makes it an ordinary scoped mandate; null before, and on every other mandate. */
  filedAt: string | null;
  /** A goal mandate's goal, set once by `forge mandate new --goal`: owner text, never shown unfenced (mandateGoal). */
  goal: string | null;
  /** Free text, possibly empty: never shown or briefed unfenced (mandateGuidance). */
  body: string;
}

/** A mandate file that can't be read safely: never acted on, and narrowing fails closed on it. */
export interface UnreadableMandate {
  id: string;
  problem: string;
}

/** What readMandate returns. */
export type ReadMandate = Mandate | UnreadableMandate;

/** `forge mandate new|edit|pause|resume|close|show`'s `mandate`. */
export interface MandateSummary {
  id: string;
  title: string;
  status: MandateStatus;
  state: MandateState;
  reason: string | null;
  after: string | null;
  /** A goal mandate: its scope stays empty while drafting runs plan its work. */
  intake: boolean;
  scope: MandateScope;
  contract: MandateContract;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Set once a goal mandate's draft is filed: its scope is then the filed milestone. */
  filedAt: string | null;
}

/** What `forge mandate edit` (and `new`) may set: any contract term, scope list, title, after or body. */
export interface MandateInput {
  title?: string;
  milestones?: string[];
  labels?: string[];
  issues?: string[];
  until?: string;
  maxJobs?: number;
  order?: string;
  decides?: string[];
  budgetUsd?: number;
  budgetJobs?: number;
  stallCadences?: number;
  stallBounces?: number;
  onUnfinishable?: string;
  /** null clears it (`--after none`). */
  after?: string | null;
  body?: string;
  /** Only `forge mandate new` sets it. */
  goal?: string;
}

// The draft body is an /api shape (the dashboard renders it), owned by lib/api/repo.ts.
export type { DraftBody, DraftExisting, DraftIssue, DraftMilestone } from '#api/types.ts';

/** `.forge/runtime/mandates/<id>/draft.json`: the checked draft as `forge mandate draft record` stored it. */
export interface Draft extends DraftBody {
  schemaVersion: number;
  mandate: string;
  request: string;
  recordedAt: string;
}

/** What readDraft returns: null for no file, the draft with the SHA-256 of the bytes it parsed, or why it can't be read. */
export type ReadDraft = (Draft & { digest: string }) | { problem: string } | null;

/**
 * `.forge/runtime/mandates/<id>/filing.json`: an approved draft's filing, written before the first
 * tracker call and after each, so a retry resumes without filing anything twice (filing.ts).
 */
export interface Filing {
  schemaVersion: number;
  mandate: string;
  request: string;
  /** The SHA-256 of the draft.json bytes approved: a retry refuses once draft.json differs. */
  digest: string;
  tracker: string;
  approvedAt: string;
  actor: EventActor;
  note: string | null;
  milestone: { title: string; ref: string | null; url: string | null; startedAt: string | null };
  issues: Record<string, { ref: string | null; url: string | null; action: 'created' | 'reused' | 'amended'; startedAt: string }>;
  error: string | null;
  completedAt: string | null;
}

/** `forge mandate draft show`'s status, the first that applies in this order. */
export type DraftStatus = 'queued' | 'drafting' | 'ready' | 'unreadable' | 'failed' | 'none';

/** The drafting runs' spend, summed over the mandate's ledger.jsonl. */
export interface DraftSpend {
  runs: number;
  withUsage: number;
  tokens: number;
  usd: number;
  metered: number;
}
