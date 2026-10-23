// The typed GitHub seam for pull requests: the checked snapshots Forge reads and the edits it makes,
// behind one GitHub adapter that lib/engine/pr/ takes as a parameter.
import type { Config, PrChecks } from '#core/types.ts';

export type PrState = 'OPEN' | 'CLOSED' | 'MERGED';

/** A PR as Forge reads it: built and checked once by parsePr, every field a checked value or null. */
export interface PrSnapshot {
  number: number | null;
  /** https only. */
  url: string | null;
  state: PrState | null;
  isDraft: boolean;
  /** Fails closed: only gh's `false` reads as same-repo. */
  isCrossRepository: boolean;
  /** SAFE_REF or null. */
  headRefName: string | null;
  baseRefName: string | null;
  /** From gh's headRefOid: isSha or null. */
  headOid: string | null;
  mergeable: string | null;
  /** From gh's mergeStateStatus. */
  mergeState: string | null;
  reviewDecision: string | null;
  mergedAt: string | null;
  checks: PrChecks;
  /** failingCheckNames of the rollup: names that passed CHECK_NAME, the rest counted in `more`. */
  failingChecks: { names: string[]; more: number };
}

/** A PR's body and refs, for an edit that splices it: parsePrBody. */
export interface PrBody {
  number: number | null;
  headRefName: string | null;
  baseRefName: string | null;
  body: string | null;
}

/** A PR that closes an issue: parseClosing. `trusted` is an OWNER, MEMBER or COLLABORATOR author. */
export interface ClosingPr {
  number: number | null;
  state: PrState | null;
  isCrossRepository: boolean;
  trusted: boolean;
}

/** A person's comment (bots and Forge's own are dropped); `trusted` is someone with write access. */
export interface FeedbackComment {
  login: string;
  trusted: boolean;
  body: string;
  createdAt: string | null;
  url: string | null;
}

export interface FeedbackReview {
  state: string;
  login: string;
  trusted: boolean;
  body: string;
  submittedAt: string | null;
  url: string | null;
}

/** An unresolved review thread with at least one person's comment. */
export interface FeedbackThread {
  path: string;
  line: number | null;
  isOutdated: boolean;
  comments: FeedbackComment[];
}

/**
 * People's feedback on a PR: parseFeedback. `trusted` counts unresolved threads with a trusted comment
 * plus trusted CHANGES_REQUESTED reviews; the pr-feedback gate counts only these (and failing checks).
 */
export interface PrFeedback {
  threads: FeedbackThread[];
  reviews: FeedbackReview[];
  comments: FeedbackComment[];
  trusted: number;
}

export interface PrCreate {
  slug: string;
  base: string;
  head: string;
  title: string;
  bodyFile: string;
  draft: boolean;
  labels: readonly string[];
  reviewers: readonly string[];
}

/** A merge GitHub refused is an answer, not an exception: `error` is gh's output (raw text). */
export type MergeOutcome = { ok: true } | { ok: false; error: string };

/**
 * Every pull-request call lib/engine/pr/ makes. Reads return checked snapshots and throw ForgeError
 * `external` when GitHub can't answer; edits throw on failure; merge never throws on a refused merge.
 */
export interface GitHub {
  /** Throws when the adapter can't reach GitHub at all (gh missing). */
  require(): void;
  repoSlug(root: string, config: Config): string;
  view(cwd: string, slug: string, number: number): PrSnapshot;
  viewBody(cwd: string, slug: string, number: number): PrBody;
  /** Up to 5 PRs whose head is `branch`, forks included. */
  list(cwd: string, slug: string, branch: string, state: 'open' | 'all'): PrSnapshot[];
  /** The PRs that close issue `issue`, closed ones and forks included. */
  closing(cwd: string, slug: string, issue: number): ClosingPr[];
  feedback(cwd: string, slug: string, number: number): PrFeedback;
  create(cwd: string, pr: PrCreate): { number: number | null; url: string | null };
  editBase(cwd: string, slug: string, number: number, base: string): void;
  editBody(cwd: string, slug: string, number: number, bodyFile: string): void;
  ready(cwd: string, slug: string, number: number): void;
  merge(cwd: string, slug: string, number: number, opts: { method: string; auto: boolean; matchHead: string | null }): MergeOutcome;
}
