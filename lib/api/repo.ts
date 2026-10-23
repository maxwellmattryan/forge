// What the repo holds outside any job: /api/project, /api/roster, /api/backlog with the tracker item, and /api/github/preview.
import type { ComponentKind, DependencyType, Effort, EffortSource } from './enums.ts';

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

/** A readiness rubric key a triage verdict can name: TRIAGE_MISSING in lib/engine/trackers/triage.ts. */
export type TriageMissing = 'outcome' | 'acceptance' | 'scope' | 'duplicate';

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
