// The mandate shapes, type-only: the file `forge mandate` writes, the contract terms, and the summary and
// state the CLI prints. The rules over them are contract.ts, the file I/O store.ts.
import type { GateClass, MandateOnUnfinishable, MandateOrder, MandateUntil } from '#core/types.ts';
import type { MANDATE_STATUSES } from '#core/job/schema.ts';

/** A mandate's written status: only `forge mandate pause|resume|close` moves it. */
export type MandateStatus = (typeof MANDATE_STATUSES)[number];

/** What `forge mandate list|show` derives: `waiting` while `after` names a mandate that isn't closed. */
export type MandateState = 'active' | 'paused' | 'waiting' | 'closed';

/** The work a mandate covers: at least one list is non-empty, milestones in order. */
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
  scope: MandateScope;
  contract: MandateContract;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
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
}
