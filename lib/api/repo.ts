// What the repo holds outside any job: /api/project, /api/roster, /api/backlog with the tracker item, /api/github/preview,
// the mandates with their directives (GET and POST /api/mandates and /api/mandates/:id/*, the Foreman page), and a
// goal mandate's milestone draft (/api/state's drafts, GET and POST /api/mandates/:id/draft).
import type { ComponentKind, DependencyType, DirectiveAction, Effort, EffortSource, GateClass, MandateOnUnfinishable, MandateOrder, MandateScoring, MandateStatus, MandateUntil, WaitingOn } from './enums.ts';
import type { EventActor, GateOwner } from './job.ts';

/** A backlog item, as a tracker's list() and get() return it (lib/engine/trackers/load.ts). */
export interface TrackerItem {
  ref: string;
  title: string;
  url?: string | null;
  body?: string;
  labels?: string[];
  status?: string | null;
  priority?: string | null;
  assignees?: string[];
  claimedBy?: string | null;
  /** Marked needs-info by readiness triage (local `[?]`, GitHub `<prefix>needs-info`): ready lists leave it out. */
  needsInfo?: boolean;
}

/** A CI rollup on a GitHub preview: GitHub's statusCheckRollup, folded to three outcomes; null when nothing ran. */
export type GitHubChecks = 'success' | 'failure' | 'pending' | null;

/** A repository's hover preview. Strings are GitHub text: render them as text. */
export interface GitHubRepoPreview {
  kind: 'repo';
  repo: string;
  url: string;
  description: string | null;
  private: boolean;
  archived: boolean;
  fork: boolean;
  stars: number;
  forks: number;
  language: string | null;
  defaultBranch: string | null;
  openIssues: number;
  openPulls: number;
  license: string | null;
  pushedAt: string | null;
}

/** A pull request's hover preview. `excerpt` is the start of the body as plain text. */
export interface GitHubPullPreview {
  kind: 'pull';
  repo: string;
  number: number;
  url: string;
  title: string;
  state: 'open' | 'draft' | 'merged' | 'closed';
  author: string | null;
  createdAt: string;
  updatedAt: string;
  base: string;
  head: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  comments: number;
  review: 'approved' | 'changes_requested' | 'review_required' | null;
  checks: GitHubChecks;
  labels: string[];
  excerpt: string;
}

/** An issue's hover preview. A closed issue keeps why it closed: completed (`closed`), not planned or a duplicate. */
export interface GitHubIssuePreview {
  kind: 'issue';
  repo: string;
  number: number;
  url: string;
  title: string;
  state: 'open' | 'closed' | 'not_planned' | 'duplicate';
  author: string | null;
  createdAt: string;
  updatedAt: string;
  comments: number;
  labels: string[];
  assignees: string[];
  excerpt: string;
}

/** A commit's hover preview. */
export interface GitHubCommitPreview {
  kind: 'commit';
  repo: string;
  sha: string;
  url: string;
  headline: string;
  author: string | null;
  committedAt: string;
  additions: number;
  deletions: number;
  checks: GitHubChecks;
}

export type GitHubPreview = GitHubRepoPreview | GitHubPullPreview | GitHubIssuePreview | GitHubCommitPreview;

/** Why a preview could not be fetched: no `gh` on PATH, GitHub has no such page (or no access), or anything else. */
export type GitHubPreviewError = 'gh_missing' | 'not_found' | 'failed';

/** GET /api/github/preview?url=: previewGitHub in lib/integrations/github/preview.ts. A URL it can't preview is a 400 ApiError. */
export type GitHubPreviewResponse = { preview: GitHubPreview } | { error: GitHubPreviewError; message: string };

/** One component of GET /api/project: projectGraph in lib/engine/project/graph.ts. Never its commands, owners or notes. */
export interface ProjectComponent {
  name: string;
  /** null: the root repo. */
  repo: string | null;
  kind: ComponentKind;
  path: string;
}

/** One dependsOn edge of GET /api/project, from the dependent to its dependency. */
export interface ProjectEdge {
  from: string;
  to: string;
  target: 'component' | 'backing';
  type: DependencyType;
}

/** GET /api/project: projectGraph in lib/engine/project/graph.ts, the config-derived graph only. */
export interface ProjectResponse {
  components: ProjectComponent[];
  backing: string[];
  edges: ProjectEdge[];
  /** componentProblems(config).length: the graph keeps only the entries that are usable. */
  problems: number;
}

/** GET /api/roster: roster in lib/engine/pipeline/roster.ts. */
/** The builder's model overrides, as the roster reports them. */
export interface RosterModelBy {
  low: string | null;
  medium: string | null;
  high: string | null;
  rework: string | null;
}

export interface Roster {
  /** `modelBy`: the builder entry only, its runtime.modelByComplexity and runtime.reworkModel (null when unset or invalid). */
  agents: { role: string; description: string; model: string; promptHash: string; addendum: string | null; effort: Effort | null; effortSource: EffortSource; modelBy?: RosterModelBy }[];
  reviewers: { name: string; model: string; always: boolean; when: string | null; checklist: string | null; checklistHash: string | null; effort: Effort | null; effortSource: EffortSource }[];
  learnings: string | null;
  /** Entries in learnings.md; 0 when it is missing. */
  learningCount: number;
  /** The earliest valid review-by among all learnings, expired ones included. */
  oldestReviewBy: string | null;
  diversity: { enabled: boolean; builder: string; overlap: { role: string; model: string }[] };
  warnings: string[];
}

/** A readiness rubric key a triage verdict can name: TRIAGE_MISSING in lib/engine/trackers/triage.ts. `hidden-text` is Forge's own. */
export type TriageMissing = 'outcome' | 'acceptance' | 'scope' | 'duplicate' | 'hidden-text';

/** The last triage verdict for an item, from the triage cache (lib/engine/trackers/triage.ts). */
export interface TriageInfo {
  ready: boolean;
  missing: TriageMissing[];
  at: string;
}

/** A /api/backlog item: the tracker's item plus its last triage verdict, when there is one. */
export interface BacklogItem extends TrackerItem {
  triage?: TriageInfo;
}

/** GET /api/backlog: the handler in lib/server/routes/misc.ts over the tracker's list(). */
export interface BacklogResponse {
  tracker: string;
  items: BacklogItem[];
  error?: string;
}

// ---------- mandates: the owner's standing instructions to the Office ----------

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
  /** Whether its merged jobs get a post-merge score run: all, sample (scoring.sample decides) or off. */
  scoring: MandateScoring;
}

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

/** `forge mandate draft show`'s status, the first that applies in this order. */
export type DraftStatus = 'queued' | 'drafting' | 'ready' | 'unreadable' | 'failed' | 'none';

/** One directive as `forge mandate show`, `forge office survey` and GET /api/mandates give it. Strings are owner, session or tracker text: render them as text. */
export interface Directive {
  ts: string;
  mandate: string;
  action: DirectiveAction;
  issue: string | null;
  job: string | null;
  reason: string;
  actor: EventActor | null;
}

/**
 * A report card figure: its value; 'pending' while a job it counts still waits on a measurement (a score
 * run or an outcome window); null when there is nothing to measure.
 *
 * The pending rule: a count of what has happened (jobs, interventions, spend, rounds of settled jobs) is a
 * running total and is never pending. A figure over post-merge measurements (scores, outcomes) is
 * 'pending' while its section's `pending` (scores) or `open` (outcomes) count is above 0, null when it
 * counts nothing and awaits nothing, and otherwise its value. So an empty mandate reads null, never 0.
 */
export type CardFigure = number | 'pending' | null;

/**
 * A mandate's report card (lib/office/mandates/card.ts buildReportCard): what merged, how it scored, how
 * much review and human help it took, what it cost against its budget and what happened after the
 * merges. Numbers, 'pending', null, WAITING_ON keys and ISO times only: no free text.
 */
export interface MandateReportCard {
  /** The mandate id. */
  mandate: string;
  /** When it was computed. */
  at: string;
  jobs: { total: number; reached: number; merged: number; inFlight: number };
  /** Over the merged jobs, each in exactly one bucket; median and below3 over the scored values. */
  scores: { scored: number; held: number; failed: number; pending: number; unscored: number; median: CardFigure; below3: CardFigure };
  /** Over the settled jobs with verdicts. */
  review: { reviewed: number; avgRounds: number | null; firstPassRate: number | null };
  /** Every person's `human` event, keyed by the park the job was at. */
  interventions: { total: number; byGate: Partial<Record<WaitingOn | 'none', number>> };
  spend: { usd: number; budgetUsd: number; started: number; budgetJobs: number };
  /** Over the merged jobs, each in exactly one bucket; finalAt is the latest window close. */
  outcomes: { final: number; open: number; unmeasured: number; reverted: CardFigure; followedUp: CardFigure; finalAt: string | null };
}

/** One readable mandate on the Foreman page: its summary, the contract as it applies now, its chain, its progress and its live report card. Never its body or goal. */
export interface MandateRow extends MandateSummary {
  effective: MandateContract;
  /** One line per term the config changed. */
  capped: string[];
  chain: string[];
  activeLink: string | null;
  progress: {
    jobs: { reached: number; inFlight: number; handled: number; unfinishable: number };
    spend: { usd: number; budget: number };
    started: { jobs: number; budget: number };
    lastActivity: string;
  };
  /** A goal mandate's draft: its status and the milestone-approval gate's; null for any other mandate. */
  draft: { status: DraftStatus; gate: DraftGateStatus } | null;
  /** The report card, computed live, closed mandates too. */
  card: MandateReportCard;
}

/** A mandate file that can't be read safely: never acted on. */
export interface UnreadableMandateRow {
  id: string;
  problem: string;
}

/** GET /api/mandates: every mandate by creation time, the latest 50 directives (oldest first), the classes a mandate may be given and a new mandate's defaults. */
export interface MandatesResponse {
  mandates: (MandateRow | UnreadableMandateRow)[];
  directives: Directive[];
  grantable: GateClass[];
  defaults: MandateContract;
}

/** GET /api/mandates/:id (token): the row plus the owner's guidance and goal as written, and its latest 20 directives. */
export interface MandateDetailResponse extends MandateRow {
  body: string;
  goal: string | null;
  directives: Directive[];
}

/** The terms a mandate write may carry; the contract judges their values, as for `forge mandate new|edit`. */
export interface MandateTermsBody {
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
  scoring?: string;
  /** null clears it. */
  after?: string | null;
  body?: string;
}

/** POST /api/mandates: a new mandate; every term not sent comes from foreman.mandate. */
export interface PostMandateBody extends MandateTermsBody {
  id: string;
  title: string;
}

/** POST /api/mandates/:id/edit: only the terms sent change, and only while the mandate's updatedAt is still this one. */
export interface PostMandateEditBody extends MandateTermsBody {
  updatedAt: string;
}

/** POST /api/mandates/:id/pause and /close (resume takes `{}`). */
export interface PostMandateStatusBody {
  reason?: string | null;
}

/** Every mandate write's reply: changed false when nothing differed. */
export interface PostMandateResponse {
  ok: true;
  changed: boolean;
  mandate: MandateRow;
}

// ---------- a goal mandate's milestone draft and its approval gate ----------

/** A milestone draft's milestone: one line of title and its exit criteria. */
export interface DraftMilestone {
  title: string;
  exitCriteria: string[];
}

/** An open tracker issue a draft issue reuses as it is or amends, instead of filing a new one. */
export interface DraftExisting {
  ref: string;
  action: 'reuse' | 'amend';
}

/** One planned issue: Why / What to do / Done, the stat it moves, its wave and the paths it touches. */
export interface DraftIssue {
  key: string;
  title: string;
  why: string;
  whatToDo: string;
  done: string;
  stat: string;
  wave: number;
  dependsOn: string[];
  files: string[];
  existing: DraftExisting | null;
}

/** What the drafter writes to its staging file (lib/office/mandates/draft.ts checks it). */
export interface DraftBody {
  milestone: DraftMilestone;
  issues: DraftIssue[];
}

/** A stored draft as the dashboard reads it: the body plus the drafting request that recorded it and when. */
export type MilestoneDraft = DraftBody & { request: string; recordedAt: string };

/**
 * The milestone-approval gate's status, the first that applies: `filed` once the mandate's filedAt is set,
 * `filing` while an approved filing record is incomplete, `pending` for a ready draft of an open goal
 * mandate, else `none`.
 */
export type DraftGateStatus = 'none' | 'pending' | 'filing' | 'filed';

/** One goal mandate at the milestone-approval gate, as /api/state's drafts lists it. */
export interface DraftGate {
  mandate: string;
  title: string;
  status: 'pending' | 'filing';
  /** The draft's drafting request id: the key a decision pins. */
  request: string;
  /** The lowercase hex SHA-256 of draft.json's bytes: the digest a decision pins. */
  digest: string;
  recordedAt: string;
  milestone: string;
  issues: number;
  waves: number;
  existing: number;
  /** The stopped filing's error, or null. */
  error: string | null;
  owner: GateOwner;
  /** The latest gate request for this draft was rejected: an assistant foreman left it for a person. */
  leftForHuman: boolean;
}

/** One filed issue in a filing record's view, in draft order: ref and url null until it is filed. */
export interface FilingIssueView {
  key: string;
  ref: string | null;
  url: string | null;
  action: 'created' | 'reused' | 'amended';
}

/** An approved draft's filing record, as the CLI and the API show it. */
export interface FilingView {
  milestone: { title: string; ref: string | null; url: string | null };
  issues: FilingIssueView[];
  digest: string;
  error: string | null;
  approvedAt: string;
  completedAt: string | null;
}

/** GET /api/mandates/:id/draft. */
export interface MandateDraftResponse {
  mandate: string;
  title: string;
  /** The owner's goal as written: the page renders it as text. */
  goal: string;
  status: DraftGateStatus;
  request: string | null;
  digest: string | null;
  owner: GateOwner;
  leftForHuman: boolean;
  draft: MilestoneDraft | null;
  filing: FilingView | null;
}

/** POST /api/mandates/:id/draft's body: exactly these keys. */
export interface PostMandateDraftBody {
  decision: 'approve' | 'revise' | 'reject';
  request: string;
  digest: string;
  note?: string | null;
}

/** POST /api/mandates/:id/draft's reply: the CLI's result for the decision. */
export type PostMandateDraftResponse =
  | { ok: true; decision: 'approve'; mandate: string; request: string; digest: string; filing: FilingView; scope: { milestones: string[] } }
  | { ok: true; decision: 'revise'; mandate: string; request: string; queued: string }
  | { ok: true; decision: 'reject'; mandate: string; request: string; status: 'closed' };
