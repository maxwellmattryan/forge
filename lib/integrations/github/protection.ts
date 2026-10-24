// Branch protection and a commit's checks on GitHub: the reads and their parsers, no merge policy.
// Which checks a merge needs, and whether a head satisfies them, is lib/engine/pr/required.ts's.
import { isMap } from '#core/shape.ts';
import { SAFE_REF, safeText } from '#core/text.ts';
import type { RunResult } from '#core/os/process.ts';
import { SLUG_RE, parseJsonOutput } from './gh.ts';
import type { gh } from './gh.ts';
import type { BranchRules, CheckObservation, HeadChecks, RequiredCheck } from './types.ts';

/** A commit's check suites (app, workflow file, latest runs) and statuses (who posted each), in one read. Shape checked against GitHub on 2026-10-24. */
export const HEAD_CHECKS_QUERY = `query($owner:String!,$name:String!,$oid:GitObjectID!){repository(owner:$owner,name:$name){object(oid:$oid){... on Commit{
      checkSuites(first:50){pageInfo{hasNextPage} nodes{app{databaseId slug} workflowRun{file{path}} checkRuns(first:100,filterBy:{checkType:LATEST}){pageInfo{hasNextPage} nodes{name status conclusion startedAt completedAt}}}}
      status{contexts{context state createdAt creator{login}}}}}}}`;

/** `v[k1][k2]…`, undefined as soon as a step is not an object. */
function dig(v: unknown, ...keys: string[]): unknown {
  let cur = v;
  for (const k of keys) cur = isMap(cur) ? cur[k] : undefined;
  return cur;
}

const listOf = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isMap) : []);
const MAX_NAME = 200;
/** A check or context name as GitHub reports it: a non-empty string of at most 200 characters. */
const checkName = (v: unknown): string | null => (typeof v === 'string' && v.trim() && v.length <= MAX_NAME ? v : null);
/** An app id: a positive integer; anything else (missing, null, -1) means any source. */
const appId = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);
const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;
const matching = (re: RegExp) => (v: unknown): string | null => (typeof v === 'string' && re.test(v) ? v : null);
/** A workflow file path: printable, at most 300 characters (dynamic workflows are not under .github/workflows/). */
const workflowPath = (v: unknown): string | null => (typeof v === 'string' && v && v.length <= 300 && safeText(v, 300) === v ? v : null);
const time = (v: unknown): string | null => (typeof v === 'string' && v.length <= 40 ? v : null);
const upper = (v: unknown): string | null => (typeof v === 'string' && v ? v.toUpperCase().slice(0, 40) : null);

/**
 * A commit's checks from HEAD_CHECKS_QUERY's `.data`: each check run with its suite's app and
 * workflow file, each status with its creator. A node with a non-string name or an unknown shape is
 * dropped; a page GitHub cut short, or an answer with no commit, makes it incomplete.
 */
export function parseHeadChecks(data: unknown): HeadChecks {
  const commit = dig(data, 'repository', 'object');
  if (!isMap(commit)) return { checks: [], complete: false };
  let complete = dig(commit, 'checkSuites', 'pageInfo', 'hasNextPage') !== true;
  const checks: CheckObservation[] = [];
  for (const suite of listOf(dig(commit, 'checkSuites', 'nodes'))) {
    if (dig(suite, 'checkRuns', 'pageInfo', 'hasNextPage') === true) complete = false;
    const source = { appId: appId(dig(suite, 'app', 'databaseId')), app: matching(APP_SLUG)(dig(suite, 'app', 'slug')), workflow: workflowPath(dig(suite, 'workflowRun', 'file', 'path')) };
    for (const run of listOf(dig(suite, 'checkRuns', 'nodes'))) {
      const name = checkName(run.name);
      const status = upper(run.status);
      if (name === null || status === null) continue;
      // A finished run with no conclusion is not a pass: UNKNOWN reads as pending.
      const state = status === 'COMPLETED' ? (upper(run.conclusion) ?? 'UNKNOWN') : status;
      checks.push({ name, kind: 'check-run', ...source, creator: null, state, at: time(run.completedAt) ?? time(run.startedAt) });
    }
  }
  for (const s of listOf(dig(commit, 'status', 'contexts'))) {
    const name = checkName(s.context);
    const state = upper(s.state);
    if (name === null || state === null) continue;
    checks.push({ name, kind: 'status', appId: null, app: null, workflow: null, creator: matching(LOGIN)(dig(s, 'creator', 'login')), state, at: time(s.createdAt) });
  }
  return { checks, complete };
}

/** A base branch that is safe in a `gh api` path once encoded: SAFE_REF, and no `..` or empty segment. */
const safeBase = (base: unknown): base is string => typeof base === 'string' && SAFE_REF.test(base) && !base.includes('..') && !base.includes('//') && !base.endsWith('/');
/** A slug that is safe in a `gh api` path: SLUG_RE, and neither part only dots. */
const safeSlug = (slug: unknown): slug is string => typeof slug === 'string' && SLUG_RE.test(slug) && slug.split('/').every((p) => !/^\.+$/.test(p));

/** gh's first line of output for a failed (or unparseable) read, made safe for one line. */
function firstLine(r: RunResult, parsed: unknown): string {
  const raw = r.ok && parsed === null ? 'gh printed output that is not JSON' : (r.stderr || r.stdout).trim().split('\n')[0] || 'gh failed';
  return safeText(raw.trim(), 200);
}

/** One `gh api` read: the parsed JSON, or the error when it failed or printed something that is not JSON. */
function read(run: typeof gh, cwd: string, path: string): { json: unknown; error: string | null } {
  const args = ['api', path];
  const r = run(cwd, args, { allowFail: true });
  const json = parseJsonOutput(r, args, { allowFail: true });
  return json === null ? { json: null, error: firstLine(r, json) } : { json, error: null };
}

/**
 * `base`'s required checks and approving-review count in `slug`, from the rulesets, the branch's
 * own protection summary and, only when that says the branch is protected, the admin-only
 * `/protection` read (whose failure leaves the review count unknown and nothing else). A check from
 * any read counts; with none, the answer is `read` only when both non-admin reads answered.
 * A base or slug unsafe in an API path makes no call.
 */
export function readBranchRules(run: typeof gh, cwd: string, slug: string, base: string): BranchRules {
  if (!safeSlug(slug) || !safeBase(base)) return { status: 'unavailable', checks: [], reviews: null, error: 'the repository or base branch is not safe in an API path' };
  const at = `repos/${slug}`;
  const enc = encodeURIComponent(base);
  const checks: RequiredCheck[] = [];
  const add = (name: unknown, id: unknown) => {
    const n = checkName(name);
    if (n === null) return;
    const a = appId(id);
    if (!checks.some((c) => c.name === n && c.appId === a)) checks.push({ name: n, appId: a });
  };
  // Review counts known so far; `unknown` once a read that could hold one failed.
  const counts: number[] = [];
  let unknown = false;
  const count = (v: unknown) => counts.push(typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 0);

  const rulesets = read(run, cwd, `${at}/rules/branches/${enc}?per_page=100`);
  const rulesetsOk = Array.isArray(rulesets.json);
  if (rulesetsOk) {
    for (const rule of listOf(rulesets.json)) {
      if (rule.type === 'required_status_checks') for (const c of listOf(dig(rule, 'parameters', 'required_status_checks'))) add(c.context, c.integration_id);
      else if (rule.type === 'pull_request') count(dig(rule, 'parameters', 'required_approving_review_count'));
    }
  } else unknown = true;

  const branch = read(run, cwd, `${at}/branches/${enc}`);
  const branchOk = isMap(branch.json);
  if (branchOk) {
    const summary = dig(branch.json, 'protection', 'required_status_checks');
    const listed = listOf(dig(summary, 'checks'));
    for (const c of listed) add(c.context, c.app_id);
    // `contexts` mirrors `checks` by name; only a name `checks` lacks adds an unbound one.
    for (const name of Array.isArray(dig(summary, 'contexts')) ? (dig(summary, 'contexts') as unknown[]) : []) if (!listed.some((c) => c.context === name)) add(name, null);
    if (dig(branch.json, 'protected') === true) {
      const admin = read(run, cwd, `${at}/branches/${enc}/protection`);
      if (isMap(admin.json)) {
        for (const c of listOf(dig(admin.json, 'required_status_checks', 'checks'))) add(c.context, c.app_id);
        count(dig(admin.json, 'required_pull_request_reviews', 'required_approving_review_count'));
      } else unknown = true;
    } else counts.push(0);
  } else unknown = true;

  const most = Math.max(0, ...counts);
  const reviews = most > 0 ? most : unknown ? null : 0;
  if (checks.length || (rulesetsOk && branchOk)) return { status: 'read', checks, reviews };
  return { status: 'unavailable', checks: [], reviews: null, error: rulesets.error ?? branch.error ?? 'gh failed' };
}
