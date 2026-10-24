// Required checks: which checks a PR's merge needs, from merge.requiredChecks or its base's
// protection, and whether its head satisfies them, each bound to its source.
import { normalizeRequiredChecks } from '#core/config/validators/required-checks.ts';
import { SAFE_REF, safeText } from '#core/text.ts';
import type { Config } from '#core/types.ts';
import { FAILING_STATES } from '#integrations/github/pull-requests.ts';
import type { BranchRules, CheckObservation, GitHub, HeadChecks } from '#integrations/github/types.ts';
import { FULL_SHA } from './eligible.ts';

/** One check a merge needs and the source it must come from (every binding null: any check run). */
export interface Requirement {
  name: string;
  /** A protection rule's app id. */
  appId: number | null;
  /** merge.requiredChecks' `app`, `workflow` and `creator`. */
  app: string | null;
  workflow: string | null;
  creator: string | null;
}

/** Why a required check is not passing. */
export type RequiredWhy = 'missing' | 'pending' | 'failing' | 'skipped' | 'neutral' | 'foreign' | 'status' | 'ambiguous' | 'incomplete';

export type RequiredState = 'passing' | 'pending' | 'failing';

/**
 * What a merge decided its required checks from, and their verdict. `state` null: no required
 * checks (`none`) or protection that could not be read (`unavailable`), so the CI rollup alone decides.
 */
export interface RequiredSummary {
  source: 'config' | 'protection' | 'none' | 'unavailable';
  state: RequiredState | null;
  /** At most MAX_BLOCKING of the requirements that are not passing. */
  blocking: { name: string; why: RequiredWhy }[];
  note?: string;
}

const MAX_BLOCKING = 10;
const FAILING = new Set(FAILING_STATES);
const FINISHED = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);

const unbound = (r: Requirement): boolean => r.appId === null && r.app === null && r.workflow === null && r.creator === null;

/** Who reported an observation: a check run's app and workflow file, or a status's creator. */
const sourceOf = (o: CheckObservation): string => (o.kind === 'status' ? `status\0${(o.creator ?? '').toLowerCase()}` : `run\0${o.appId ?? ''}\0${o.app ?? ''}\0${o.workflow ?? ''}`);

/**
 * Whether `o` comes from the source `r` is bound to. A commit status matches only a creator
 * binding: anyone with push access can post one under any name.
 */
function matches(r: Requirement, o: CheckObservation): boolean {
  if (r.creator !== null) return o.kind === 'status' && o.creator !== null && o.creator.toLowerCase() === r.creator.toLowerCase();
  if (o.kind !== 'check-run') return false;
  return (r.appId === null || o.appId === r.appId) && (r.app === null || o.app === r.app) && (r.workflow === null || o.workflow === r.workflow);
}

/** A missing time counts as newest, so an observation GitHub has not dated never hides behind an older one. */
const newer = (a: CheckObservation, b: CheckObservation): boolean => a.at === null || (b.at !== null && a.at >= b.at);

/** The latest observation per name and source: a re-run replaces the run it repeats. */
function latest(checks: CheckObservation[]): CheckObservation[] {
  const by = new Map<string, CheckObservation>();
  for (const o of checks) {
    const k = `${o.name}\0${sourceOf(o)}`;
    const prev = by.get(k);
    if (!prev || newer(o, prev)) by.set(k, o);
  }
  return [...by.values()];
}

/** One requirement's verdict from the observations with exactly its name: the first rule that applies decides. */
function judge(r: Requirement, named: CheckObservation[], complete: boolean): { state: RequiredState; why?: RequiredWhy } {
  // A failing or unfinished duplicate blocks whatever its source: it may be the real one.
  if (named.some((o) => FAILING.has(o.state))) return { state: 'failing', why: 'failing' };
  if (named.some((o) => !FINISHED.has(o.state))) return { state: 'pending', why: 'pending' };
  const own = named.filter((o) => matches(r, o));
  if (new Set(own.map(sourceOf)).size > 1) return { state: 'failing', why: 'ambiguous' };
  if (!own.length) {
    const why: RequiredWhy = !named.length ? 'missing' : unbound(r) && named.every((o) => o.kind === 'status') ? 'status' : 'foreign';
    return { state: 'pending', why };
  }
  // Both are final, so waiting would never see a pass: refuse.
  if (own[0].state === 'SKIPPED') return { state: 'failing', why: 'skipped' };
  if (own[0].state === 'NEUTRAL') return { state: 'failing', why: 'neutral' };
  return complete ? { state: 'passing' } : { state: 'pending', why: 'incomplete' };
}

/** Whether `head` satisfies every requirement: failing if any fails, else pending if any waits, else passing. */
export function evaluateRequired(reqs: Requirement[], head: HeadChecks): { state: RequiredState; blocking: RequiredSummary['blocking'] } {
  const checks = latest(head.checks);
  const blocking: RequiredSummary['blocking'] = [];
  let failing = false;
  let pending = false;
  for (const r of reqs) {
    const v = judge(r, checks.filter((o) => o.name === r.name), head.complete);
    if (v.state === 'failing') failing = true;
    if (v.state === 'pending') pending = true;
    if (v.why && blocking.length < MAX_BLOCKING) blocking.push({ name: safeText(r.name, 100), why: v.why });
  }
  return { state: failing ? 'failing' : pending ? 'pending' : 'passing', blocking };
}

/**
 * Where a PR's required checks come from: the root PR's merge.requiredChecks when set, else its
 * base's protection (`rules`, read only then). A member PR always takes its own repo's protection:
 * the root's key names root checks only.
 */
export function requirementsFor(config: Config, repo: string | null, base: string, rules: () => BranchRules): { source: RequiredSummary['source']; reqs: Requirement[]; note?: string } {
  const configured = repo === null ? normalizeRequiredChecks(config.merge.requiredChecks) : [];
  if (configured.length) return { source: 'config', reqs: configured.map((c) => ({ ...c, appId: null })) };
  const r = rules();
  if (r.status === 'unavailable')
    return { source: 'unavailable', reqs: [], note: `branch protection of ${safeText(base, 100)} could not be read (${safeText(r.error ?? 'gh failed', 200)}); deciding on the CI rollup alone` };
  if (!r.checks.length) return { source: 'none', reqs: [] };
  return { source: 'protection', reqs: r.checks.map((c) => ({ name: c.name, appId: c.appId, app: null, workflow: null, creator: null })) };
}

/** branchRules through `cache`, keyed by slug and base: one read per base per merge call, never stored. */
function cachedRules(github: GitHub, cwd: string, slug: string, base: string, cache: Map<string, BranchRules>): BranchRules {
  const k = `${slug}\0${base}`;
  let r = cache.get(k);
  if (!r) {
    r = github.branchRules(cwd, slug, base);
    cache.set(k, r);
  }
  return r;
}

/** The required-check verdict for one PR at `headOid`: its requirements, and its head's checks read only when there are some. */
export function requiredFor(
  github: GitHub,
  cwd: string,
  pr: { repo: string | null; slug: string; base: string | null; headOid: string | null },
  config: Config,
  cache: Map<string, BranchRules>,
): RequiredSummary {
  const base = pr.base ?? '';
  const { source, reqs, note } = requirementsFor(config, pr.repo, base, () => cachedRules(github, cwd, pr.slug, base, cache));
  if (!reqs.length) return { source, state: null, blocking: [], ...(note ? { note } : {}) };
  if (pr.headOid === null || !FULL_SHA.test(pr.headOid)) return { source, state: 'pending', blocking: [], note: "the PR's head commit is unknown, so its checks could not be read" };
  let head: HeadChecks;
  try {
    head = github.headChecks(cwd, pr.slug, pr.headOid);
  } catch (e) {
    return { source, state: 'pending', blocking: [], note: `the head's checks could not be read (${safeText(String((e as Error).message).split('\n')[0], 200)})` };
  }
  return { source, ...evaluateRequired(reqs, head) };
}

/** The refusal when a required check fails: each blocking check and why. */
export function requiredError(r: RequiredSummary): string {
  const shown = r.blocking.map((b) => `${b.name} (${b.why})`).join(', ') || 'unknown';
  return `required checks are not passing: ${shown}; fix CI, or a human merges anyway with forge pr merge --now in their own terminal`;
}

/**
 * The command that turns on protection for `base`. `{owner}`/`{repo}` are gh's own placeholders, so
 * no slug reaches a support bundle; `<check name>` is the maintainer's to fill in.
 */
const protectCommand = (base: string): string =>
  `gh api -X PUT 'repos/{owner}/{repo}/branches/${SAFE_REF.test(base) ? encodeURIComponent(base) : '<base>'}/protection' -F 'required_status_checks[strict]=false' -f 'required_status_checks[contexts][]=<check name>' -F 'required_pull_request_reviews[required_approving_review_count]=1' -F enforce_admins=false -F restrictions=null`;

/**
 * Whether to warn that `base` merges on whatever CI has reported: no merge.requiredChecks, and
 * protection (`rules`; null: not read) without a required check, or with checks and no required
 * review. An unknown review count does not warn, so a non-admin is not told to add what may exist.
 */
export function requiredChecksAdvice(config: Config, base: string, rules: BranchRules | null): { warn: boolean; detail: string } {
  if (normalizeRequiredChecks(config.merge.requiredChecks).length) return { warn: false, detail: 'merge.requiredChecks names the checks the root PR needs' };
  const b = safeText(base, 100);
  if (rules && rules.status === 'read' && rules.checks.length && (rules.reviews === null || rules.reviews >= 1))
    return { warn: false, detail: `${b}'s protection requires ${rules.checks.length} check${rules.checks.length === 1 ? '' : 's'}${rules.reviews === null ? '' : ' and a review'}` };
  const why =
    !rules || rules.status === 'unavailable'
      ? `could not read ${b}'s branch protection (${safeText(rules?.error ?? 'not read', 200)}) and merge.requiredChecks is empty`
      : `${b} has no merge.requiredChecks and no protection rule with required checks and a required review`;
  return { warn: true, detail: `${why}, so Forge merges on whatever CI has reported; set merge.requiredChecks (docs/CONFIG.md "Merge"), or run: ${protectCommand(base)}` };
}

/** `forge pr open`'s warning for the root PR's base: read only when merge.requiredChecks is empty, and never a failure. */
export function requiredChecksNote(config: Config, github: GitHub, cwd: string, slug: string, base: string): { requiredChecksWarning?: string } {
  try {
    if (normalizeRequiredChecks(config.merge.requiredChecks).length) return {};
    const advice = requiredChecksAdvice(config, base, github.branchRules(cwd, slug, base));
    return advice.warn ? { requiredChecksWarning: advice.detail } : {};
  } catch {
    return {};
  }
}
