// What the repo holds outside any job: /api/project, /api/roster, /api/backlog with the tracker item, /api/github/preview,
// and a goal mandate's milestone draft (/api/state's drafts, GET and POST /api/mandates/:id/draft).
import type { ComponentKind, DependencyType, Effort, EffortSource } from './enums.ts';
import type { GateOwner } from './job.ts';

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
