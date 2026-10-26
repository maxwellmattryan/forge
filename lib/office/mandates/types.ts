// The mandate shapes, type-only: the file `forge mandate` and the Foreman page write, what a write may
// set, and a goal mandate's milestone draft and filing; the contract terms, summary and state the CLI and
// the dashboard show are /api shapes, re-exported here. The rules over them are contract.ts and draft.ts,
// the file I/O store.ts and draft.ts.
import type { DraftBody, EventActor, MandateContract, MandateScope, MandateStatus } from '#core/types.ts';

// The shapes the Foreman page reads too are /api shapes, owned by lib/api/repo.ts and lib/api/enums.ts.
export type { DraftStatus, MandateContract, MandateScope, MandateState, MandateStatus, MandateSummary } from '#api/types.ts';

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

/** The drafting runs' spend, summed over the mandate's ledger.jsonl. */
export interface DraftSpend {
  runs: number;
  withUsage: number;
  tokens: number;
  usd: number;
  metered: number;
}
