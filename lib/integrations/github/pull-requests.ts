// Pull requests through gh: the calls Forge makes on a PR and what it reads back (checks and review
// feedback), with no pipeline policy. When to adopt, open, rework, retarget or merge is lib/engine/pr/'s.
import { ForgeError } from '#core/errors.ts';
import { hasBinary } from '#core/os/process.ts';
import type { RunResult } from '#core/os/process.ts';
import type { Config, PrChecks } from '#core/types.ts';
import { gh, ghGraphql, ghJson } from './gh.ts';

export const MARKER = '<!-- forge -->';

const PR_FIELDS = 'number,url,state,isDraft,title,headRefName,baseRefName,mergedAt,closedAt,isCrossRepository,author';
export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export const PR_STATES = new Set(['OPEN', 'CLOSED', 'MERGED']);

export const SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export const safePrNumber = (n: unknown): number | null => (typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null);

export function requireGh(): void {
  if (!hasBinary('gh')) throw new ForgeError('the GitHub CLI (gh) is required for PR features; install it or set pr.enabled: false', 'external');
}

export function repoSlug(root: string, config: Config): string {
  if (config.tracker?.github?.repo) return config.tracker.github.repo;
  const r = gh(root, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { allowFail: true });
  if (r.ok && r.stdout.trim()) return r.stdout.trim();
  throw new ForgeError('cannot determine the GitHub repository; set tracker.github.repo or run `gh auth login`', 'external');
}

/**
 * Throws unless gh's `pr` is the job's own PR in that repo: head on the job's branch, base on the
 * repo's base. A PR number in job.json is agent-writable, so without this a rewritten number would
 * let a merged PR elsewhere satisfy the merge order, or send a merge or body edit to an unrelated PR.
 */
export function assertJobPr(pr: any, branch: string | null, base: string | null, label: string): void {
  if (!branch || pr?.headRefName !== branch) throw new ForgeError(`${label} is not on the job's branch ${branch}`);
  if (!base || pr?.baseRefName !== base) throw new ForgeError(`${label} does not target ${base}`);
}

/** `gh pr view` of PR `number` in `slug`, with `fields`. gh output: raw input. */
export function viewPr(cwd: string, slug: string, number: number, fields: string = PR_FIELDS): any {
  return ghJson(cwd, ['pr', 'view', String(number), '-R', slug, '--json', fields]);
}

/** Up to 5 PRs in `slug` whose head is `branch`, forks included. gh output: raw input. */
export function listPrs(cwd: string, slug: string, branch: string, state: 'open' | 'all'): any {
  return ghJson(cwd, ['pr', 'list', '-R', slug, '--head', branch, '--state', state, '--json', PR_FIELDS, '--limit', '5']);
}

/** The PRs that close issue `issue` in `slug`, closed ones and forks included, unfiltered. GitHub's GraphQL: raw input. */
export function closingPrs(cwd: string, slug: string, issue: number): any[] {
  const [owner, name] = slug.split('/');
  const data = ghGraphql(
    cwd,
    `query($owner:String!,$name:String!,$num:Int!){repository(owner:$owner,name:$name){issue(number:$num){closedByPullRequestsReferences(first:10,includeClosedPrs:true){nodes{number state headRefName isCrossRepository authorAssociation}}}}}`,
    { owner, name, num: issue },
  );
  return data?.repository?.issue?.closedByPullRequestsReferences?.nodes ?? [];
}

/** `gh pr create`, throwing when it fails. Returns the last line gh printed, the new PR's URL (raw input). */
export function createPr(
  cwd: string,
  pr: { slug: string; base: string; head: string; title: string; bodyFile: string; draft: boolean; labels: readonly string[]; reviewers: readonly string[] },
): string {
  const args = ['pr', 'create', '-R', pr.slug, '--base', pr.base, '--head', pr.head, '--title', pr.title, '--body-file', pr.bodyFile];
  if (pr.draft) args.push('--draft');
  for (const l of pr.labels) args.push('--label', l);
  for (const r of pr.reviewers) args.push('--reviewer', r);
  return gh(cwd, args).stdout.trim().split('\n').pop() ?? '';
}

/** Moves PR `number` onto `base`, throwing when gh fails. */
export function editPrBase(cwd: string, slug: string, number: number, base: string): void {
  gh(cwd, ['pr', 'edit', String(number), '-R', slug, '--base', base]);
}

/** Replaces PR `number`'s body with `bodyFile`'s text, throwing when gh fails. */
export function editPrBody(cwd: string, slug: string, number: number, bodyFile: string): void {
  gh(cwd, ['pr', 'edit', String(number), '-R', slug, '--body-file', bodyFile]);
}

/** Marks draft PR `number` ready for review, throwing when gh fails. */
export function markPrReady(cwd: string, slug: string, number: number): void {
  gh(cwd, ['pr', 'ready', String(number), '-R', slug]);
}

/**
 * One `gh pr merge` call: `--auto` when asked, pinned with `--match-head-commit` when `matchHead` is
 * set. It never throws on a failed merge: the result says so, and its output is raw input.
 */
export function submitMerge(cwd: string, slug: string, number: number, opts: { method: string; auto: boolean; matchHead: string | null }): RunResult {
  const args = ['pr', 'merge', String(number), '-R', slug, `--${opts.method}`];
  if (opts.auto) args.push('--auto');
  if (opts.matchHead) args.push('--match-head-commit', opts.matchHead);
  return gh(cwd, args, { allowFail: true });
}

/** Human feedback on a PR, as GitHub's GraphQL returns it (raw input): fetchFeedback. */
export interface PrFeedback {
  threads: any[];
  reviews: any[];
  comments: any[];
}

export function fetchFeedback(root: string, slug: string, num: number): PrFeedback {
  const [owner, name] = slug.split('/');
  const data = ghGraphql(
    root,
    `query($owner:String!,$name:String!,$num:Int!){repository(owner:$owner,name:$name){pullRequest(number:$num){
      reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:20){nodes{author{login} authorAssociation body createdAt url}}}}
      reviews(last:30){nodes{state body author{login} authorAssociation submittedAt url}}
      comments(last:50){nodes{author{login} authorAssociation body createdAt url}}}}}`,
    { owner, name, num },
  );
  const pr = data?.repository?.pullRequest ?? {};
  return {
    threads: (pr.reviewThreads?.nodes ?? []).filter((t: any) => !t.isResolved && t.comments.nodes.some(human)),
    reviews: (pr.reviews?.nodes ?? []).filter((r: any) => human(r) && (r.body?.trim() || r.state === 'CHANGES_REQUESTED')),
    comments: (pr.comments?.nodes ?? []).filter(human),
  };
}

/** A person's comment or review, not a bot's or Forge's own (which carries MARKER). */
const human = (c: any): boolean => !String(c.author?.login ?? '').endsWith('[bot]') && !String(c.body ?? '').includes(MARKER);
/** Written by someone with write access to the repo: only that may start an unattended foreman rework. */
const trusted = (c: any): boolean => human(c) && TRUSTED_ASSOCIATIONS.has(c?.authorAssociation);

/**
 * Unresolved threads with a trusted comment plus trusted CHANGES_REQUESTED reviews. The pr-feedback gate
 * counts only these (and failing checks): a stranger's comment on a public repo stays a human's call.
 */
export function trustedFeedback(fb: Pick<PrFeedback, 'threads' | 'reviews'>): number {
  const threads = fb.threads.filter((t: any) => (t?.comments?.nodes ?? []).some(trusted)).length;
  const reviews = fb.reviews.filter((r: any) => r?.state === 'CHANGES_REQUESTED' && trusted(r)).length;
  return threads + reviews;
}

const FAILING_STATES = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
const checkState = (c: any): string => String(c?.conclusion || c?.state || c?.status || '').toUpperCase();

// gh's statusCheckRollup: raw input.
export function summarizeChecks(rollup: any[]): PrChecks {
  let passing = 0, failing = 0, pending = 0;
  for (const c of rollup) {
    const s = checkState(c);
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(s)) passing++;
    else if (FAILING_STATES.includes(s)) failing++;
    else pending++;
  }
  const state = failing ? 'failing' : pending ? 'pending' : rollup.length ? 'passing' : 'none';
  return { state, passing, failing, pending };
}

/** Check names allowed into a reason, an event or a tell: the PR's own workflows choose them. */
const CHECK_NAME = /^[A-Za-z0-9 ._/-]{1,60}$/;
const MAX_CHECK_NAMES = 5;

/**
 * The failing checks' names (`name`, else `context`), trimmed, at most 5 that match CHECK_NAME;
 * `more` counts the ones dropped or beyond 5. Same failing set as summarizeChecks.
 */
export function failingCheckNames(rollup: unknown): { names: string[]; more: number } {
  const names: string[] = [];
  let more = 0;
  for (const c of Array.isArray(rollup) ? rollup : []) {
    if (!FAILING_STATES.includes(checkState(c))) continue;
    const raw = typeof c?.name === 'string' && c.name ? c.name : typeof c?.context === 'string' ? c.context : '';
    const name = raw.trim();
    if (names.length < MAX_CHECK_NAMES && CHECK_NAME.test(name)) names.push(name);
    else more++;
  }
  return { names, more };
}

/** `lint, test and 2 more`, or `3 checks` when no name survived. */
export function checksText(f: { names: string[]; more: number }): string {
  if (!f.names.length) return `${f.more} checks`;
  return f.names.join(', ') + (f.more ? ` and ${f.more} more` : '');
}
