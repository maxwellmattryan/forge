// Pull requests on GitHub, behind the typed seam lib/engine/pr/ takes as a parameter: the parsers that
// check every PR read once into a snapshot, and the gh adapter that makes the calls. No pipeline
// policy: when to adopt, open, rework, retarget or merge is lib/engine/pr/'s.
import { ForgeError } from '#core/errors.ts';
import { isSafeUrl } from '#core/job/issue-ref.ts';
import { hasBinary } from '#core/os/process.ts';
import type { RunResult } from '#core/os/process.ts';
import { SAFE_REF, isSha, safeText } from '#core/text.ts';
import type { Config, PrChecks } from '#core/types.ts';
import { SLUG_RE, gh, graphqlArgs, parseJsonOutput } from './gh.ts';
import { HEAD_CHECKS_QUERY, parseHeadChecks, readBranchRules } from './protection.ts';
import type { ClosingPr, FailingRun, FeedbackComment, FeedbackReview, FeedbackThread, GitHub, PrBody, PrFeedback, PrSnapshot, PrState, RunSnapshot } from './types.ts';

export type { BranchRules, CheckObservation, ClosingPr, FailingRun, FeedbackComment, FeedbackReview, FeedbackThread, GitHub, HeadChecks, MergeOutcome, PrBody, PrCreate, PrFeedback, PrSnapshot, PrState, RequiredCheck, RerunOutcome, RunSnapshot } from './types.ts';
export { SLUG_RE };

export const MARKER = '<!-- forge -->';

const TRUSTED_ASSOCIATIONS: ReadonlySet<unknown> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export const PR_STATES = new Set(['OPEN', 'CLOSED', 'MERGED']);

export const safePrNumber = (n: unknown): number | null => (typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null);

/** gh's arguments for a PR runner: `gh` itself in production, so every call keeps GH_TIMEOUT_MS. */
export type GhRun = typeof gh;

function slugVia(run: GhRun, root: string, config: Config): string {
  if (config.tracker?.github?.repo) return config.tracker.github.repo;
  const r = run(root, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { allowFail: true });
  if (r.ok && r.stdout.trim()) return r.stdout.trim();
  throw new ForgeError('cannot determine the GitHub repository; set tracker.github.repo or run `gh auth login`', 'external');
}

export function repoSlug(root: string, config: Config): string {
  return slugVia(gh, root, config);
}

/**
 * Throws unless gh's `pr` is the job's own PR in that repo: head on the job's branch, base on the
 * repo's base. A PR number in job.json is agent-writable, so without this a rewritten number would
 * let a merged PR elsewhere satisfy the merge order, or send a merge or body edit to an unrelated PR.
 */
export function assertJobPr(pr: Pick<PrSnapshot, 'headRefName' | 'baseRefName'>, branch: string | null, base: string | null, label: string): void {
  if (!branch || pr.headRefName !== branch) throw new ForgeError(`${label} is not on the job's branch ${branch}`);
  if (!base || pr.baseRefName !== base) throw new ForgeError(`${label} does not target ${base}`);
}

// ---- Parsers: gh's JSON and GitHub's GraphQL are raw input; only checked values leave them. ----

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `v[k1][k2]…`, undefined as soon as a step is not an object. */
function dig(v: unknown, ...keys: string[]): unknown {
  let cur = v;
  for (const k of keys) cur = isRecord(cur) ? cur[k] : undefined;
  return cur;
}

const httpsUrl = (u: unknown): string | null => (isSafeUrl(u) && u.startsWith('https://') ? u : null);
const prState = (s: unknown): PrState | null => (typeof s === 'string' && PR_STATES.has(s) ? (s as PrState) : null);
const safeRef = (v: unknown): string | null => (typeof v === 'string' && SAFE_REF.test(v) ? v : null);
const shortText = (v: unknown): string | null => (typeof v === 'string' && v ? safeText(v, 40) || null : null);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function record(raw: unknown, what: string): Record<string, unknown> {
  if (!isRecord(raw)) throw new ForgeError(`gh returned ${what} that is not an object`, 'external');
  return raw;
}

/** gh's PR JSON as a PrSnapshot. A field with a bad value becomes null; a PR not marked same-repo counts as a fork. */
export function parsePr(raw: unknown): PrSnapshot {
  const pr = record(raw, 'a PR');
  const rollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  return {
    number: safePrNumber(pr.number),
    url: httpsUrl(pr.url),
    state: prState(pr.state),
    isDraft: pr.isDraft === true,
    isCrossRepository: pr.isCrossRepository !== false,
    headRefName: safeRef(pr.headRefName),
    baseRefName: safeRef(pr.baseRefName),
    headOid: isSha(pr.headRefOid) ? pr.headRefOid : null,
    mergeable: shortText(pr.mergeable),
    mergeState: shortText(pr.mergeStateStatus),
    reviewDecision: shortText(pr.reviewDecision),
    mergedAt: shortText(pr.mergedAt),
    checks: summarizeChecks(rollup),
    failingChecks: failingCheckNames(rollup),
    failingRuns: failingRunsOf(rollup),
  };
}

/** gh's run JSON as a RunSnapshot: a head that is not a sha becomes null, status and conclusion lower-case. */
export function parseRun(raw: unknown): RunSnapshot {
  const r = record(raw, 'a run');
  return { headSha: isSha(r.headSha) ? r.headSha : null, status: shortText(r.status)?.toLowerCase() ?? null, conclusion: shortText(r.conclusion)?.toLowerCase() ?? null };
}

export function parsePrBody(raw: unknown): PrBody {
  const pr = record(raw, 'a PR');
  return { number: safePrNumber(pr.number), headRefName: safeRef(pr.headRefName), baseRefName: safeRef(pr.baseRefName), body: typeof pr.body === 'string' ? pr.body : null };
}

/** GitHub's closedByPullRequestsReferences nodes. A node not marked same-repo counts as a fork. */
export function parseClosing(nodes: unknown): ClosingPr[] {
  if (!Array.isArray(nodes)) return [];
  return nodes.filter(isRecord).map((n) => ({
    number: safePrNumber(n.number),
    state: prState(n.state),
    isCrossRepository: n.isCrossRepository !== false,
    trusted: TRUSTED_ASSOCIATIONS.has(n.authorAssociation),
  }));
}

const login = (c: Record<string, unknown>): string => text(dig(c, 'author', 'login'));
/** A person's comment or review, not a bot's or Forge's own (which carries MARKER). */
const human = (c: Record<string, unknown>): boolean => !login(c).endsWith('[bot]') && !text(c.body).includes(MARKER);
const nodesOf = (v: unknown, key: string): Record<string, unknown>[] => {
  const n = dig(v, key, 'nodes');
  return Array.isArray(n) ? n.filter(isRecord) : [];
};
const comment = (c: Record<string, unknown>): FeedbackComment => ({
  login: safeText(login(c), 100),
  // Written by someone with write access to the repo: only that may start an unattended foreman rework.
  trusted: TRUSTED_ASSOCIATIONS.has(c.authorAssociation),
  body: text(c.body),
  createdAt: shortText(c.createdAt),
  url: httpsUrl(c.url),
});

/**
 * People's feedback on a PR from GitHub's GraphQL `.data`: bots' and Forge's own comments dropped,
 * unresolved threads kept only with a person's comment, reviews kept with a body or a change request.
 * `trusted` counts only what someone with write access wrote: a stranger's comment on a public repo
 * stays a human's call.
 */
export function parseFeedback(data: unknown): PrFeedback {
  const pr = dig(data, 'repository', 'pullRequest');
  const threads: FeedbackThread[] = nodesOf(pr, 'reviewThreads')
    .filter((t) => t.isResolved !== true)
    .map((t) => ({
      path: safeText(text(t.path), 300),
      // A line number is a positive integer like a PR number.
      line: safePrNumber(t.line),
      isOutdated: t.isOutdated === true,
      comments: nodesOf(t, 'comments').filter(human).map(comment),
    }))
    .filter((t) => t.comments.length > 0);
  const reviews: FeedbackReview[] = nodesOf(pr, 'reviews')
    .filter((r) => human(r) && (text(r.body).trim() || r.state === 'CHANGES_REQUESTED'))
    .map((r) => {
      const c = comment(r);
      return { state: safeText(text(r.state), 40), login: c.login, trusted: c.trusted, body: c.body, submittedAt: shortText(r.submittedAt), url: c.url };
    });
  const comments = nodesOf(pr, 'comments').filter(human).map(comment);
  const trusted = threads.filter((t) => t.comments.some((c) => c.trusted)).length + reviews.filter((r) => r.state === 'CHANGES_REQUESTED' && r.trusted).length;
  return { threads, reviews, comments, trusted };
}

/** The check states that count as failing, in the rollup and for a required check. */
export const FAILING_STATES: readonly string[] = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
const checkState = (c: unknown): string => String(dig(c, 'conclusion') || dig(c, 'state') || dig(c, 'status') || '').toUpperCase();

/** gh's statusCheckRollup (raw input) counted as passing, failing and pending. */
export function summarizeChecks(rollup: readonly unknown[]): PrChecks {
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

/** Check names allowed into a reason, an event or a tell: the PR's own workflows choose them. `(),` keep matrix names. */
const CHECK_NAME = /^[A-Za-z0-9 ._/(),-]{1,60}$/;
const MAX_CHECK_NAMES = 5;

/** CHECK_NAME's test, for a stored name read back from job.json, which a session may have edited. */
export const isCheckName = (v: unknown): v is string => typeof v === 'string' && CHECK_NAME.test(v);

/**
 * The failing checks' names (`name`, else `context`), trimmed, at most 5 that match CHECK_NAME;
 * `more` counts the ones dropped or beyond 5. Same failing set as summarizeChecks.
 */
export function failingCheckNames(rollup: unknown): { names: string[]; more: number } {
  const names: string[] = [];
  let more = 0;
  for (const c of Array.isArray(rollup) ? rollup : []) {
    if (!FAILING_STATES.includes(checkState(c))) continue;
    const name = dig(c, 'name');
    const context = dig(c, 'context');
    const raw = typeof name === 'string' && name ? name : typeof context === 'string' ? context : '';
    const trimmed = raw.trim();
    if (names.length < MAX_CHECK_NAMES && CHECK_NAME.test(trimmed)) names.push(trimmed);
    else more++;
  }
  return { names, more };
}

/** A GitHub Actions run or job id: digits with no leading zero, kept as a string so 20 digits keep their precision. */
export const RUN_ID = /^[1-9][0-9]{0,19}$/;
// Anchored, with no query, fragment or trailing segment: the PR's own workflows choose detailsUrl.
const ACTIONS_JOB_URL = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/actions\/runs\/([0-9]+)\/job\/([0-9]+)$/;
const MAX_FAILING_RUNS = 20;

/**
 * The failing rollup entries that are GitHub Actions jobs, from `detailsUrl` only (a commit status's
 * targetUrl never counts), in rollup order and at most 20. Same failing set as summarizeChecks.
 */
export function failingRunsOf(rollup: unknown): FailingRun[] {
  const out: FailingRun[] = [];
  for (const c of Array.isArray(rollup) ? rollup : []) {
    if (out.length >= MAX_FAILING_RUNS) break;
    if (!FAILING_STATES.includes(checkState(c))) continue;
    const url = dig(c, 'detailsUrl');
    if (typeof url !== 'string' || url.length > 300) continue;
    const m = ACTIONS_JOB_URL.exec(url);
    if (!m || !RUN_ID.test(m[3]) || !RUN_ID.test(m[4])) continue;
    out.push({ slug: `${m[1]}/${m[2]}`, run: m[3], job: m[4] });
  }
  return out;
}

/** `lint, test and 2 more`, or `3 checks` when no name survived. */
export function checksText(f: { names: string[]; more: number }): string {
  if (!f.names.length) return `${f.more} checks`;
  return f.names.join(', ') + (f.more ? ` and ${f.more} more` : '');
}

// ---- The gh adapter ----

/** Every PR view reads these: one list, so one parser and one snapshot type serve every caller. */
const VIEW_FIELDS = 'number,url,state,isDraft,isCrossRepository,headRefName,baseRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,mergedAt';
const LIST_FIELDS = 'number,url,state,isDraft,isCrossRepository,headRefName,baseRefName';
const BODY_FIELDS = 'number,body,headRefName,baseRefName';
const CLOSING_QUERY = `query($owner:String!,$name:String!,$num:Int!){repository(owner:$owner,name:$name){issue(number:$num){closedByPullRequestsReferences(first:10,includeClosedPrs:true){nodes{number state headRefName isCrossRepository authorAssociation}}}}}`;
const FEEDBACK_QUERY = `query($owner:String!,$name:String!,$num:Int!){repository(owner:$owner,name:$name){pullRequest(number:$num){
      reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:20){nodes{author{login} authorAssociation body createdAt url}}}}
      reviews(last:30){nodes{state body author{login} authorAssociation submittedAt url}}
      comments(last:50){nodes{author{login} authorAssociation body createdAt url}}}}}`;

/** `gh pr create`'s last line as `{number, url}`: both null unless it is an https url with `/pull/<n>`. */
function parseCreated(stdout: string): { number: number | null; url: string | null } {
  const url = httpsUrl(stdout.trim().split('\n').pop()?.trim() ?? '');
  const number = url === null ? null : safePrNumber(Number(/\/pull\/(\d+)/.exec(url)?.[1]));
  return number === null ? { number: null, url: null } : { number, url };
}

/** The GitHub adapter over `run` (gh by default): one call per operation, every read checked by the parsers above. */
export function createGhGitHub(run: GhRun = gh): GitHub {
  // gh itself throws on a failed call without allowFail; a runner that returns one fails the same way.
  const call = (cwd: string, args: string[]): RunResult => {
    const r = run(cwd, args);
    if (!r.ok) throw new ForgeError(`gh ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`, 'external');
    return r;
  };
  const json = (cwd: string, args: string[]): unknown => parseJsonOutput(call(cwd, args), args);
  const graphql = (cwd: string, query: string, slug: string, num: number): unknown => {
    const [owner, name] = slug.split('/');
    return dig(json(cwd, graphqlArgs(query, { owner, name, num })), 'data');
  };
  return {
    require() {
      if (!hasBinary('gh')) throw new ForgeError('the GitHub CLI (gh) is required for PR features; install it or set pr.enabled: false', 'external');
    },
    repoSlug: (root, config) => slugVia(run, root, config),
    view: (cwd, slug, number) => parsePr(json(cwd, ['pr', 'view', String(number), '-R', slug, '--json', VIEW_FIELDS])),
    viewBody: (cwd, slug, number) => parsePrBody(json(cwd, ['pr', 'view', String(number), '-R', slug, '--json', BODY_FIELDS])),
    list(cwd, slug, branch, state) {
      const out = json(cwd, ['pr', 'list', '-R', slug, '--head', branch, '--state', state, '--json', LIST_FIELDS, '--limit', '5']);
      return Array.isArray(out) ? out.filter(isRecord).map(parsePr) : [];
    },
    closing: (cwd, slug, issue) => parseClosing(dig(graphql(cwd, CLOSING_QUERY, slug, issue), 'repository', 'issue', 'closedByPullRequestsReferences', 'nodes')),
    feedback: (cwd, slug, number) => parseFeedback(graphql(cwd, FEEDBACK_QUERY, slug, number)),
    create(cwd, pr) {
      const args = ['pr', 'create', '-R', pr.slug, '--base', pr.base, '--head', pr.head, '--title', pr.title, '--body-file', pr.bodyFile];
      if (pr.draft) args.push('--draft');
      for (const l of pr.labels) args.push('--label', l);
      for (const r of pr.reviewers) args.push('--reviewer', r);
      return parseCreated(call(cwd, args).stdout);
    },
    editBase(cwd, slug, number, base) {
      call(cwd, ['pr', 'edit', String(number), '-R', slug, '--base', base]);
    },
    editBody(cwd, slug, number, bodyFile) {
      call(cwd, ['pr', 'edit', String(number), '-R', slug, '--body-file', bodyFile]);
    },
    ready(cwd, slug, number) {
      call(cwd, ['pr', 'ready', String(number), '-R', slug]);
    },
    // A label is bound to its flag (`--add-label=<l>`) or follows `--`, so a name can never be read as an option.
    editLabels(cwd, slug, number, change) {
      call(cwd, ['pr', 'edit', String(number), '-R', slug, ...change.add.map((l) => `--add-label=${l}`), ...change.remove.map((l) => `--remove-label=${l}`)]);
    },
    createLabel(cwd, slug, name, description) {
      call(cwd, ['label', 'create', '-R', slug, `--description=${description}`, '--color=FBCA04', '--', name]);
    },
    // One `gh pr merge`: `--auto` when asked, pinned with `--match-head-commit` when matchHead is set.
    merge(cwd, slug, number, opts) {
      const args = ['pr', 'merge', String(number), '-R', slug, `--${opts.method}`];
      if (opts.auto) args.push('--auto');
      if (opts.matchHead) args.push('--match-head-commit', opts.matchHead);
      const r = run(cwd, args, { allowFail: true });
      return r.ok ? { ok: true } : { ok: false, error: (r.stderr || r.stdout).trim() };
    },
    branchRules: (cwd, slug, base) => readBranchRules(run, cwd, slug, base),
    headChecks(cwd, slug, sha) {
      if (!SLUG_RE.test(slug) || !isSha(sha)) throw new ForgeError(`gh api graphql: refusing to read checks for ${JSON.stringify(slug).slice(0, 80)} at ${JSON.stringify(sha).slice(0, 80)}`, 'external');
      const [owner, name] = slug.split('/');
      return parseHeadChecks(dig(json(cwd, graphqlArgs(HEAD_CHECKS_QUERY, { owner, name, oid: sha })), 'data'));
    },
    // The id and slug reach gh's argv: checked here again, whatever the caller checked.
    viewRun(cwd, slug, id) {
      if (!SLUG_RE.test(slug) || !RUN_ID.test(id)) throw new ForgeError(`gh run view: refusing run ${JSON.stringify(id).slice(0, 80)} in ${JSON.stringify(slug).slice(0, 80)}`, 'external');
      return parseRun(json(cwd, ['run', 'view', id, '-R', slug, '--json', 'headSha,status,conclusion']));
    },
    rerunFailed(cwd, slug, id) {
      if (!SLUG_RE.test(slug) || !RUN_ID.test(id)) return { ok: false, error: `refused: run ${JSON.stringify(id).slice(0, 80)} in ${JSON.stringify(slug).slice(0, 80)}` };
      const r = run(cwd, ['run', 'rerun', id, '--failed', '-R', slug], { allowFail: true });
      return r.ok ? { ok: true } : { ok: false, error: (r.stderr || r.stdout).trim() };
    },
  };
}

/** The production adapter. Only lib/cli/ passes it in; lib/engine/pr/ receives it as a parameter. */
export const ghGitHub: GitHub = createGhGitHub();
