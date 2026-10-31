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
  /** failingRunsOf the rollup: the failing entries that are GitHub Actions jobs, at most 20. */
  failingRuns: FailingRun[];
}

/** A failing check that is a GitHub Actions job, from its detailsUrl: `slug` is the URL's repo, ids are RUN_ID digits. */
export interface FailingRun {
  slug: string;
  run: string;
  job: string;
}

/** A workflow run as `gh run view` reports it: parseRun. status and conclusion lower-case; headSha isSha or null. */
export interface RunSnapshot {
  headSha: string | null;
  status: string | null;
  conclusion: string | null;
}

/** A re-run GitHub refused is an answer, not an exception, like a merge: `error` is gh's output (raw text). */
export type RerunOutcome = { ok: true } | { ok: false; error: string };

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

/** A check a base branch's protection (a ruleset or classic protection) requires; appId null: any source. */
export interface RequiredCheck {
  name: string;
  appId: number | null;
}

/**
 * A base branch's required checks and approving-review count: readBranchRules. `unavailable`: the
 * reads could not tell (`error` is gh's first line); `reviews` null: the count could not be read.
 */
export interface BranchRules {
  status: 'read' | 'unavailable';
  checks: RequiredCheck[];
  reviews: number | null;
  error?: string;
}

/**
 * One check reported on a commit: a check run (its app and workflow file) or a commit status (who
 * posted it). `state` is the conclusion of a finished run, else its status, upper-case. `at` is when
 * it finished (else started) for a run, when it was posted for a status.
 */
export interface CheckObservation {
  name: string;
  kind: 'check-run' | 'status';
  appId: number | null;
  app: string | null;
  workflow: string | null;
  creator: string | null;
  state: string;
  at: string | null;
}

/** A commit's checks: parseHeadChecks. `complete` false: GitHub had more than one page, or the answer had no commit. */
export interface HeadChecks {
  checks: CheckObservation[];
  complete: boolean;
}

/**
 * An open PR as the overlap check reads it: parseOpenPr in activity.ts. `files` passed safePath and
 * `dropped` counts the rest; `filesComplete` is false when gh listed fewer than the PR changes.
 */
export interface OpenPr extends PrSnapshot {
  author: string | null;
  createdAt: string | null;
  files: string[];
  filesComplete: boolean;
  dropped: number;
  commits: { oid: string | null; committedAt: string | null; authors: string[] }[];
}

/** One commit of a branch's history: parseBranchHistory. `pr` is the first PR GitHub associates with it. */
export interface BranchCommit {
  oid: string | null;
  committedAt: string | null;
  author: string | null;
  pr: { number: number; headRefName: string | null; isCrossRepository: boolean } | null;
}

/** A branch's commits since a time, newest first; `complete` is false when GitHub had more than one page. */
export interface BranchHistory {
  commits: BranchCommit[];
  complete: boolean;
}

/** A merge GitHub refused is an answer, not an exception: `error` is gh's output (raw text). */
export type MergeOutcome = { ok: true } | { ok: false; error: string };

/**
 * Every pull-request call lib/engine/pr/ makes. Reads return checked snapshots and throw ForgeError
 * `external` when GitHub can't answer; edits throw on failure; merge and rerunFailed never throw on a refusal.
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
  /** Adds and removes labels on PR `number`; an unknown label fails (gh says `not found`). Names are validated config. */
  editLabels(cwd: string, slug: string, number: number, change: { add: readonly string[]; remove: readonly string[] }): void;
  createLabel(cwd: string, slug: string, name: string, description: string): void;
  merge(cwd: string, slug: string, number: number, opts: { method: string; auto: boolean; matchHead: string | null }): MergeOutcome;
  /** `base`'s required checks and review count in `slug`. Never throws: a read that fails is in the answer. */
  branchRules(cwd: string, slug: string, base: string): BranchRules;
  /** Commit `sha`'s check runs and statuses in `slug`, in one GraphQL read. */
  headChecks(cwd: string, slug: string, sha: string): HeadChecks;
  /** Workflow run `run` in `slug`. Throws `external` on a run id or slug that fails its check, before any call. */
  viewRun(cwd: string, slug: string, run: string): RunSnapshot;
  /** Re-runs run `run`'s failed jobs in `slug`. Never throws on a refusal, a refused id or slug included. */
  rerunFailed(cwd: string, slug: string, run: string): RerunOutcome;
  /** Up to `limit` (1–100) open PRs into `base`, forks included. Read-only; throws `external` on a bad slug, base or limit before any call. */
  openPrs(cwd: string, slug: string, base: string, limit: number): OpenPr[];
  /** PR `number`'s diff as raw text (untrusted). Throws `external` past MAX_DIFF_BYTES, and on a bad number or slug before any call. */
  prDiff(cwd: string, slug: string, number: number): string;
  /** `branch`'s commits since `since` (ISO), at most one page. The ref and since go as GraphQL variables; a bad slug, ref or date throws `external` before any call. */
  branchHistory(cwd: string, slug: string, branch: string, since: string): BranchHistory;
  /** Commit `oid`'s diff as raw text (untrusted). Throws `external` past MAX_DIFF_BYTES, and on a bad oid or slug before any call. */
  commitDiff(cwd: string, slug: string, oid: string): string;
}
