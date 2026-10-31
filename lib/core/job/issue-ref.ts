// A job's issues are tracker-neutral, repo-qualified refs (`owner/repo#12`, `KEY-123`, a backlog
// slug). This is the pure half: the grammar, which issues this repo's tracker owns, and the job-id
// rule. It has no runtime imports, like lib/core/job/issue-link.ts, because lib/engine/pr/, lib/server/routes/jobs.ts and the
// trackers all import it. lib/integrations/git/repo-slug.ts reads the slug every function here takes.
import type { Job, JobIssue } from '../types.ts';

/** A tracker ref as `forge job link` and the dashboard accept it (after a leading `#` is stripped). */
export const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const SEG = '[A-Za-z0-9][A-Za-z0-9._-]{0,99}';
/**
 * `owner/repo#12`, `group/sub/project#12`: two to five path segments and an issue number. Segments
 * are split by `/`, which no segment may contain, so matching stays linear.
 */
const QUALIFIED = new RegExp(`^${SEG}(?:/${SEG}){1,4}#[1-9][0-9]{0,9}$`);

const MAX_REF = 200;
const NUMBER = /^[1-9][0-9]{0,9}$/;
const CONTROL = /[\x00-\x1f\x7f\u2028\u2029]/;

export interface IssueRefOpts {
  /** The tracker kind the ref is for: `github`, `local`, `none` or a custom adapter's name. */
  tracker: string;
  /** This repo's `owner/repo` (lib/integrations/git/repo-slug.ts), or null when none is known. */
  slug: string | null;
}

const SAFE_URL = /^https?:\/\/[^\s\x00-\x1f\x7f]+$/;

/** An issue url that is safe to write into a PR body: http(s), one token, no whitespace or controls. */
export const isSafeUrl = (url: unknown): url is string => typeof url === 'string' && url.length <= 2000 && SAFE_URL.test(url);

/** A qualified `owner/repo#12` or `group/sub/project#12`, with no `..` segment. */
export const isQualifiedRef = (ref: string): boolean => QUALIFIED.test(ref) && !ref.includes('..');

/** parseIssueRef with the reason a ref is refused, for the CLI's error. */
export function checkIssueRef(raw: unknown, opts: IssueRefOpts): { ref: string } | { error: string } {
  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  const invalid = { error: `invalid ref ${JSON.stringify(text.slice(0, 100))}` };
  if (typeof raw !== 'string' || CONTROL.test(raw)) return invalid;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_REF) return invalid;
  if (opts.tracker === 'github') {
    const digits = trimmed.replace(/^#/, '');
    if (/^\d+$/.test(digits)) {
      if (!NUMBER.test(digits)) return invalid;
      return { ref: opts.slug ? `${opts.slug}#${digits}` : digits };
    }
  }
  if (isQualifiedRef(trimmed)) {
    if (opts.tracker === 'local') return { error: 'local tracker refs are backlog slugs' };
    return { ref: trimmed };
  }
  const bare = trimmed.replace(/^#/, '');
  if (REF.test(bare) && !bare.includes('..')) return { ref: bare };
  return invalid;
}

/**
 * The stored form of a typed ref, or null when the grammar refuses it. `#12` and `12` under the
 * github tracker are qualified against `slug`; with no slug known they stay bare (the legacy form).
 */
export function parseIssueRef(raw: unknown, opts: IssueRefOpts): string | null {
  const r = checkIssueRef(raw, opts);
  return 'ref' in r ? r.ref : null;
}

/** The normaliser's grammar for a stored ref: qualified (not under `local`), or anything REF accepts. */
export function isStoredRef(ref: unknown, tracker: string): ref is string {
  if (typeof ref !== 'string' || ref.length > MAX_REF) return false;
  if (isQualifiedRef(ref)) return tracker !== 'local';
  return REF.test(ref);
}

/** `owner/repo#12` as its parts, or null for any other shape. */
export function splitQualified(ref: string): { path: string; n: string } | null {
  if (!isQualifiedRef(ref)) return null;
  const at = ref.lastIndexOf('#');
  return { path: ref.slice(0, at), n: ref.slice(at + 1) };
}

/**
 * The adapter-side ref of an issue this repo's tracker owns, or null for a foreign one. Tracker
 * calls only ever get this, so another repo's issue is never claimed, mirrored or commented on.
 */
export function nativeRef(issue: Pick<JobIssue, 'tracker' | 'ref'>, trackerKind: string, slug: string | null): string | null {
  const ref = issue.ref;
  if (!ref || issue.tracker !== trackerKind) return null;
  if (trackerKind !== 'github') return ref;
  // A bare number is the legacy form a migration could not qualify: the only place it means "this repo".
  if (/^\d+$/.test(ref)) return ref;
  const q = splitQualified(ref);
  return q && slug && q.path.toLowerCase() === slug.toLowerCase() ? q.n : null;
}

/** What two issues are compared by: tracker plus ref, qualified GitHub refs case-insensitively. */
function issueKey(issue: Pick<JobIssue, 'tracker' | 'ref'>, slug: string | null): string | null {
  const ref = issue.ref;
  if (!ref) return null;
  if (issue.tracker !== 'github') return `${issue.tracker}\0${ref}`;
  const full = /^\d+$/.test(ref) && slug ? `${slug}#${ref}` : ref;
  return `github\0${full.toLowerCase()}`;
}

export function sameIssue(a: Pick<JobIssue, 'tracker' | 'ref'>, b: Pick<JobIssue, 'tracker' | 'ref'>, slug: string | null = null): boolean {
  const ka = issueKey(a, slug);
  return ka !== null && ka === issueKey(b, slug);
}

/** A foreign GitHub issue's url, built from its ref: only `owner/repo#N` has one. */
export function issueUrl(ref: string, host = 'github.com'): string | null {
  const q = splitQualified(ref);
  if (!q || q.path.split('/').length !== 2 || !/^[A-Za-z0-9.-]{1,253}$/.test(host)) return null;
  return `https://${host}/${q.path}/issues/${q.n}`;
}

/** Issues that name an item: a url-only entry never counts as linked. */
export const linkedIssues = (job: Pick<Job, 'issues'>): JobIssue[] => (Array.isArray(job.issues) ? job.issues : []).filter((i) => Boolean(i?.ref));

/** The job's primary issue: the first one with a ref. It names the job and is what `forge pr find` looks up. */
export const primaryIssue = (job: Pick<Job, 'issues'>): JobIssue | null => linkedIssues(job)[0] ?? null;

/**
 * A new job's id before its collision suffix, or null with no ref (the caller then uses
 * `<slug>-<shortId>`): `N-<slug>` for this repo's GitHub number or a bare number,
 * `<last segment>-N-<slug>` for any other qualified ref, else the ref slugified. slugify is passed
 * in so this module keeps no runtime imports; its output is what keeps the id a safe path.
 */
export function idPrefix(
  issue: Pick<JobIssue, 'tracker' | 'ref'> | null,
  trackerKind: string,
  slug: string | null,
  titleSlug: string,
  slugify: (text: string, maxWords?: number) => string,
): string | null {
  const ref = issue?.ref;
  if (!issue || !ref) return null;
  if (/^\d+$/.test(ref)) return `${ref}-${titleSlug}`;
  const native = issue.tracker === 'github' ? nativeRef(issue, trackerKind, slug) : null;
  if (native) return `${native}-${titleSlug}`;
  const q = splitQualified(ref);
  if (q) return slugify(`${q.path.split('/').pop()} ${q.n} ${titleSlug}`, 20);
  return slugify(ref, 8);
}

/** The adapter-side refs of the job's issues this repo's tracker owns, in order. */
export function nativeRefs(job: Pick<Job, 'issues'>, trackerKind: string, slug: string | null): string[] {
  return linkedIssues(job)
    .map((i) => nativeRef(i, trackerKind, slug))
    .filter((r): r is string => r !== null);
}
