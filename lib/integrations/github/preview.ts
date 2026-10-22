// Hover previews of github.com pages for the dashboard: a strict URL parse, one `gh api graphql` call per page, and a
// small folded shape. Everything GitHub returns is untrusted text; the dashboard renders it as text, never as HTML.
import { ghAsync } from './gh.ts';
import type { GitHubChecks, GitHubPreview, GitHubPreviewResponse } from '../../core/types.ts';

/** A github.com page previewGitHub can describe. Owner and name are as GitHub spells them in the URL. */
export type GitHubTarget =
  | { kind: 'repo'; owner: string; name: string }
  | { kind: 'pull' | 'issue'; owner: string; name: string; number: number }
  | { kind: 'commit'; owner: string; name: string; sha: string };

/** What a gh call returns. `missing`: gh is not on PATH. */
export interface GhResult {
  code: number | null;
  stdout: string;
  stderr: string;
  missing?: boolean;
}
export type GhRunner = (args: string[]) => Promise<GhResult>;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const NUMBER = /^[1-9]\d{0,9}$/;
const SHA = /^[0-9a-f]{7,40}$/i;
// First path segments that are GitHub's own pages, not owners: a link to one gets no card rather than a "not found" one.
const RESERVED = new Set(['about', 'account', 'apps', 'codespaces', 'collections', 'contact', 'customer-stories', 'dashboard', 'enterprise', 'events', 'explore', 'features', 'issues', 'login', 'logout', 'marketplace', 'new', 'notifications', 'organizations', 'orgs', 'pricing', 'pulls', 'search', 'security', 'settings', 'site', 'sponsors', 'stars', 'team', 'topics', 'trending', 'users']);
const MAX_INT = 2 ** 31 - 1;
const EXCERPT = 280;

/**
 * The repository, pull request, issue or commit a github.com URL points at, or null. Only https on github.com, with no
 * credentials or port; anything after the number or sha (`/files`, `#issuecomment-1`) is ignored.
 */
export function parseGitHubUrl(raw: string): GitHubTarget | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') || u.port || u.username || u.password) return null;
  const [owner, rawName, section, id] = u.pathname.split('/').filter(Boolean);
  if (!owner || !rawName || !OWNER.test(owner) || RESERVED.has(owner.toLowerCase())) return null;
  const name = rawName.replace(/\.git$/i, '');
  if (!NAME.test(name) || name === '.' || name === '..') return null;
  if (section === undefined) return { kind: 'repo', owner, name };
  if ((section === 'pull' || section === 'issues') && id && NUMBER.test(id) && Number(id) <= MAX_INT) return { kind: section === 'pull' ? 'pull' : 'issue', owner, name, number: Number(id) };
  if (section === 'commit' && id && SHA.test(id)) return { kind: 'commit', owner, name, sha: id.toLowerCase() };
  return null;
}

/** One cache entry per page: owner and repo are case-insensitive on GitHub. */
export function targetKey(t: GitHubTarget): string {
  const base = `${t.kind}:${t.owner}/${t.name}`.toLowerCase();
  return t.kind === 'repo' ? base : t.kind === 'commit' ? `${base}@${t.sha}` : `${base}#${t.number}`;
}

const LABELS = 'labels(first:6){nodes{name}}';
const Q_ITEM = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner issueOrPullRequest(number:$number){__typename
... on Issue{number title url state stateReason createdAt updatedAt bodyText author{login} comments{totalCount} ${LABELS} assignees(first:4){nodes{login}}}
... on PullRequest{number title url state isDraft createdAt updatedAt bodyText author{login} baseRefName headRefName additions deletions changedFiles reviewDecision comments{totalCount} ${LABELS} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}`;
const Q_REPO = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){nameWithOwner url description isPrivate isArchived isFork stargazerCount forkCount pushedAt primaryLanguage{name} defaultBranchRef{name} issues(states:OPEN){totalCount} pullRequests(states:OPEN){totalCount} licenseInfo{spdxId}}}`;
const Q_COMMIT = `query($owner:String!,$name:String!,$rev:String!){repository(owner:$owner,name:$name){nameWithOwner object(expression:$rev){__typename
... on Commit{oid url messageHeadline committedDate additions deletions author{name user{login}} statusCheckRollup{state}}}}}`;

/** The gh argv for a target. Owner and name go as raw strings (-f): -F would turn a repo named `123` into a number. */
export function ghArgs(t: GitHubTarget): string[] {
  const base = ['api', 'graphql', '-f', `owner=${t.owner}`, '-f', `name=${t.name}`];
  if (t.kind === 'repo') return [...base, '-f', `query=${Q_REPO}`];
  if (t.kind === 'commit') return [...base, '-f', `rev=${t.sha}`, '-f', `query=${Q_COMMIT}`];
  return [...base, '-F', `number=${t.number}`, '-f', `query=${Q_ITEM}`];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const names = (conn: any, key: 'name' | 'login'): string[] => (Array.isArray(conn?.nodes) ? conn.nodes.map((n: any) => str(n?.[key])).filter(Boolean) : []);

function checks(rollup: any): GitHubChecks {
  switch (rollup?.state) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
      return 'failure';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return null;
  }
}

/** The body's opening as one line of plain text, cut on a code point. */
export function excerpt(body: unknown): string {
  const flat = str(body).replace(/\s+/g, ' ').trim();
  const cps = Array.from(flat);
  return cps.length > EXCERPT ? `${cps.slice(0, EXCERPT - 1).join('').trimEnd()}…` : flat;
}

/** Folds a GraphQL answer into a preview, or null when GitHub has no such page (or does not show it to this login). */
export function foldPreview(t: GitHubTarget, data: any): GitHubPreview | null {
  const repo = data?.repository;
  if (!repo || typeof repo !== 'object') return null;
  const nwo = str(repo.nameWithOwner) || `${t.owner}/${t.name}`;
  if (t.kind === 'repo') {
    return {
      kind: 'repo',
      repo: nwo,
      url: str(repo.url) || `https://github.com/${nwo}`,
      description: strOrNull(repo.description),
      private: repo.isPrivate === true,
      archived: repo.isArchived === true,
      fork: repo.isFork === true,
      stars: int(repo.stargazerCount),
      forks: int(repo.forkCount),
      language: strOrNull(repo.primaryLanguage?.name),
      defaultBranch: strOrNull(repo.defaultBranchRef?.name),
      openIssues: int(repo.issues?.totalCount),
      openPulls: int(repo.pullRequests?.totalCount),
      license: strOrNull(repo.licenseInfo?.spdxId),
      pushedAt: strOrNull(repo.pushedAt),
    };
  }
  if (t.kind === 'commit') {
    const c = repo.object;
    if (c?.__typename !== 'Commit') return null;
    return {
      kind: 'commit',
      repo: nwo,
      sha: str(c.oid) || t.sha,
      url: str(c.url) || `https://github.com/${nwo}/commit/${t.sha}`,
      headline: str(c.messageHeadline),
      author: strOrNull(c.author?.user?.login) ?? strOrNull(c.author?.name),
      committedAt: str(c.committedDate),
      additions: int(c.additions),
      deletions: int(c.deletions),
      checks: checks(c.statusCheckRollup),
    };
  }
  const it = repo.issueOrPullRequest;
  // The page decides the kind, not the URL: GitHub serves /issues/N for a pull request too.
  if (it?.__typename === 'PullRequest') {
    const review = it.reviewDecision === 'APPROVED' ? 'approved' : it.reviewDecision === 'CHANGES_REQUESTED' ? 'changes_requested' : it.reviewDecision === 'REVIEW_REQUIRED' ? 'review_required' : null;
    return {
      kind: 'pull',
      repo: nwo,
      number: int(it.number) || (t as { number: number }).number,
      url: str(it.url),
      title: str(it.title),
      state: it.state === 'MERGED' ? 'merged' : it.state === 'CLOSED' ? 'closed' : it.isDraft === true ? 'draft' : 'open',
      author: strOrNull(it.author?.login),
      createdAt: str(it.createdAt),
      updatedAt: str(it.updatedAt),
      base: str(it.baseRefName),
      head: str(it.headRefName),
      additions: int(it.additions),
      deletions: int(it.deletions),
      changedFiles: int(it.changedFiles),
      comments: int(it.comments?.totalCount),
      review,
      checks: checks(it.commits?.nodes?.[0]?.commit?.statusCheckRollup),
      labels: names(it.labels, 'name'),
      excerpt: excerpt(it.bodyText),
    };
  }
  if (it?.__typename === 'Issue') {
    return {
      kind: 'issue',
      repo: nwo,
      number: int(it.number) || (t as { number: number }).number,
      url: str(it.url),
      title: str(it.title),
      state: it.state !== 'CLOSED' ? 'open' : it.stateReason === 'NOT_PLANNED' ? 'not_planned' : it.stateReason === 'DUPLICATE' ? 'duplicate' : 'closed',
      author: strOrNull(it.author?.login),
      createdAt: str(it.createdAt),
      updatedAt: str(it.updatedAt),
      comments: int(it.comments?.totalCount),
      labels: names(it.labels, 'name'),
      assignees: names(it.assignees, 'login'),
      excerpt: excerpt(it.bodyText),
    };
  }
  return null;
}

/** gh's answer as a response. GitHub reports a missing page as a NOT_FOUND error with a nonzero exit, so stdout is read first. */
export function toResponse(t: GitHubTarget, r: GhResult): GitHubPreviewResponse {
  if (r.missing) return { error: 'gh_missing', message: 'the GitHub CLI (gh) is not installed' };
  let body: any = null;
  try {
    body = JSON.parse(r.stdout);
  } catch {
    // Not JSON: gh failed before asking GitHub (not logged in, offline). Its stderr says why.
  }
  const errors: any[] = Array.isArray(body?.errors) ? body.errors : [];
  const preview = body ? foldPreview(t, body.data) : null;
  if (preview) return { preview };
  if (body && (errors.some((e) => e?.type === 'NOT_FOUND') || (r.code === 0 && !errors.length))) return { error: 'not_found', message: str(errors[0]?.message) || 'not found' };
  const why = str(errors[0]?.message) || r.stderr.trim() || `gh exited ${r.code}`;
  return { error: 'failed', message: why.slice(0, 300) };
}

/** gh without a shell, in the repo, so it uses the same login and host config as Forge's PR features. */
export function ghRunner(cwd: string, timeoutMs = 15_000): GhRunner {
  return async (args) => {
    const r = await ghAsync(cwd, args, { timeoutMs });
    if (r.missing) return { code: null, stdout: '', stderr: '', missing: true };
    // A timed-out call has no exit code; it reads as a failure, with the timeout as its message.
    return { code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr };
  };
}

export interface PreviewerOptions {
  run: GhRunner;
  /** How long an answer is reused; errors are retried sooner. */
  ttlMs?: number;
  errorTtlMs?: number;
  /** Entries kept, least recently used dropped first. */
  max?: number;
  now?: () => number;
}

/**
 * previewGitHub with a cache: hovering the same link again, or two tabs hovering it at once, costs one gh call. The
 * in-flight promise is the cache entry, so concurrent asks share it.
 */
export function createPreviewer(opts: PreviewerOptions): (t: GitHubTarget) => Promise<GitHubPreviewResponse> {
  const { run, ttlMs = 60_000, errorTtlMs = 15_000, max = 200, now = Date.now } = opts;
  const cache = new Map<string, { until: number; value: Promise<GitHubPreviewResponse> }>();
  return (t) => {
    const key = targetKey(t);
    const hit = cache.get(key);
    cache.delete(key);
    if (hit && hit.until > now()) {
      cache.set(key, hit);
      return hit.value;
    }
    const entry = { until: Infinity, value: null as unknown as Promise<GitHubPreviewResponse> };
    // Never expires while in flight; the answer sets how long it lives.
    entry.value = run(ghArgs(t))
      .then((r) => toResponse(t, r))
      .catch((e: unknown): GitHubPreviewResponse => ({ error: 'failed', message: String((e as Error)?.message ?? e).slice(0, 300) }))
      .then((res) => {
        entry.until = now() + ('preview' in res ? ttlMs : errorTtlMs);
        return res;
      });
    cache.set(key, entry);
    while (cache.size > max) cache.delete(cache.keys().next().value as string);
    return entry.value;
  };
}
