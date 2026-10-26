// The mandate contract's rules: the stored shape a file needs to be read, the refusals of `forge mandate
// new|edit`, the defaults a new mandate takes, the contract as it applies under the config (what it caps),
// the derived state and chain, and the guidance and goal fences. Reads no file: store.ts does. docs/architecture/foreman.md.
import { MANDATE_ID_SOURCE } from '#api/constants.ts';
import { MANDATE_ON_UNFINISHABLE, MANDATE_ORDERS, MANDATE_SCORING, MANDATE_STATUSES, MANDATE_UNTIL } from '#core/job/schema.ts';
import { MANDATE_SCHEMA_VERSION, MANDATE_STEPS } from '#core/versions/mandate.ts';
import { runSteps } from '#core/versions/steps.ts';
import { checkIssueRef } from '#core/job/issue-ref.ts';
import { defaults } from '#core/config/load.ts';
import { isMap } from '#core/shape.ts';
import { fenceImport, oneLineTitle, visibleText } from '#core/text.ts';
import { localRepoSlug } from '#integrations/git/repo-slug.ts';
import { INVALID_RESERVED, classReservation, decides, foremanEnabled, isGateClass, listedDecides, reservedMatch } from '#engine/pipeline/moves/foreman-gates.ts';
import type { Config, GateClass } from '#core/types.ts';
import type { Mandate, MandateContract, MandateInput, MandateState, MandateSummary, ReadMandate } from './types.ts';

/** A mandate id: also its file name, so the grammar is what keeps a path inside the mandates dir. */
export const MANDATE_ID = new RegExp(MANDATE_ID_SOURCE);
/** `none` clears a list or `after` on the command line, so it can never be an id. */
export const isMandateId = (v: unknown): v is string => typeof v === 'string' && MANDATE_ID.test(v) && v !== 'none';

const TITLE_MAX = 200;
const REASON_MAX = 200;
export const BODY_MAX = 8000;
/** Milestones and labels reach `gh` as arguments (a tracker's `scope`): bounded, and never a flag. */
const ENTRY_MAX = 100;
const SCOPE_LIST_MAX = 10;
const ISSUES_MAX = 100;
export const GOAL_MAX = 4000;
// C0, DEL, C1 and the line and paragraph separators (built from code points: a literal one ends a regex literal).
const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const CONTROL = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${SEPARATORS}]`);
/** CONTROL but LF and TAB: what a goal may not hold. The separators would split its one stored line. */
export const GOAL_CONTROL = new RegExp(`[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f${SEPARATORS}]`);

/** The frontmatter keys, in the order a file holds them; every one is always written, `goal` last (store.ts). */
export const MANDATE_KEYS = [
  'schemaVersion', 'id', 'title', 'status', 'reason', 'scope', 'until', 'maxJobs', 'order', 'decides', 'budget', 'stall', 'onUnfinishable', 'scoring', 'after', 'createdAt', 'updatedAt', 'closedAt', 'filedAt', 'goal',
] as const;

export const isReadable = (m: ReadMandate | undefined): m is Mandate => m !== undefined && !('problem' in m);

const got = (v: unknown) => `(got ${typeof v === 'number' ? String(v) : String(JSON.stringify(v)).slice(0, 60)})`;
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isIso = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v));
const oneOf = (v: unknown, allowed: readonly string[]): boolean => typeof v === 'string' && allowed.includes(v);
const badId = (what: string, v: unknown) => `${what} ${JSON.stringify(String(v ?? '')).slice(0, 60)} is not a mandate id (lowercase letters, digits and -, at most 40, not starting with -, and not none)`;

/** A milestone filed from a draft becomes a scope milestone, so it follows the same rule (filing.ts checks it before any write). */
export const SCOPE_MILESTONE_MAX = 200;

/** Whether `e` may be a scope milestone or label of at most `max` characters: not empty, never a flag, no control or hidden character. */
export const scopeEntryOk = (e: unknown, max: number): e is string =>
  typeof e === 'string' && e.length > 0 && e.length <= max && !e.startsWith('-') && !CONTROL.test(e) && visibleText(e).removed === 0;

function scopeListProblems(kind: 'milestone' | 'label', list: unknown): string[] {
  const key = `scope.${kind}s`;
  if (!Array.isArray(list)) return [`${key} must be a list ${got(list)}`];
  const problems: string[] = [];
  if (list.length > SCOPE_LIST_MAX) problems.push(`more than ${SCOPE_LIST_MAX} ${kind}s (${list.length})`);
  // A milestone filed from a draft may carry a title up to the draft's 200; a label stays at 100.
  const max = kind === 'milestone' ? SCOPE_MILESTONE_MAX : ENTRY_MAX;
  for (const e of list) {
    // Hidden characters (zero-width, bidi overrides) would read differently on the page than in argv, as titles lose them in oneLineTitle.
    if (!scopeEntryOk(e, max)) problems.push(`${kind} ${JSON.stringify(String(e)).slice(0, 120)} must be 1-${max} characters, not start with "-" and have no control or hidden characters`);
  }
  return problems;
}

/**
 * Why owner text on lines breaks the goal's rules (not blank, at most `max` characters, no control
 * character but LF and TAB, no line or paragraph separator), or null: shared by the goal and a draft
 * decision's note (gate.ts), which add their own hidden-text check.
 */
export function textLinesProblem(what: string, v: unknown, max: number): string | null {
  if (typeof v !== 'string' || !v.trim()) return `${what} needs at least one character that is not whitespace`;
  if (v.length > max) return `${what} must be at most ${max} characters (got ${v.length})`;
  if (GOAL_CONTROL.test(v)) return `${what} must hold no control character but line feed and tab, and no line or paragraph separator`;
  return null;
}

/** A goal is null, or owner text on lines: not blank, at most GOAL_MAX characters, no control character but LF and TAB. */
function goalProblems(goal: unknown): string[] {
  if (goal === null) return [];
  if (typeof goal !== 'string' || !goal.trim()) return ['a goal needs at least one character that is not whitespace'];
  const p = textLinesProblem('the goal', goal, GOAL_MAX);
  return p ? [p] : [];
}

/**
 * Every rule a mandate's terms follow, as they are stored: the file a read accepts, and the base of the
 * write-time refusals. Without `decides`, the decides term is left to mandateProblems, which judges it
 * against the config instead.
 */
function termProblems(m: Record<string, any>, opts: { decides: boolean }): string[] {
  const problems: string[] = [];
  if (typeof m.title !== 'string' || !m.title) problems.push('a mandate needs a title');
  else if (m.title.length > TITLE_MAX || oneLineTitle(m.title) !== m.title) problems.push(`title must be one line of at most ${TITLE_MAX} characters`);
  if (!oneOf(m.status, MANDATE_STATUSES)) problems.push(`status must be one of ${MANDATE_STATUSES.join(' | ')} ${got(m.status)}`);
  if (m.reason !== null && (typeof m.reason !== 'string' || !m.reason || m.reason.length > REASON_MAX || oneLineTitle(m.reason) !== m.reason))
    problems.push(`reason must be null or one line of at most ${REASON_MAX} characters`);
  const s = m.scope;
  if (!isMap(s) || Object.keys(s).some((k) => k !== 'milestones' && k !== 'labels' && k !== 'issues')) problems.push('scope must be a map of milestones, labels and issues');
  else {
    problems.push(...scopeListProblems('milestone', s.milestones), ...scopeListProblems('label', s.labels));
    if (!Array.isArray(s.issues)) problems.push(`scope.issues must be a list ${got(s.issues)}`);
    else {
      if (s.issues.length > ISSUES_MAX) problems.push(`more than ${ISSUES_MAX} issues (${s.issues.length})`);
      // The stored form only: write time checked each against the repo's tracker (issueRefs).
      for (const ref of s.issues) {
        const r = checkIssueRef(ref, { tracker: '', slug: null });
        if (!('ref' in r) || r.ref !== ref) problems.push(`issue ${JSON.stringify(String(ref)).slice(0, 120)} is not a stored issue ref`);
      }
    }
    const lists = [s.milestones, s.labels, s.issues].map((l) => (Array.isArray(l) ? l.length : 0));
    const goal = typeof m.goal === 'string';
    // A goal mandate is in intake until its draft is filed: its scope stays empty. Filed, it is an ordinary scoped mandate.
    if (goal && m.filedAt === null) {
      if (lists.some((n) => n > 0)) problems.push("a goal mandate's scope stays empty until its draft is filed");
    } else if (lists.every((n) => n === 0)) problems.push(goal ? "a filed goal mandate's scope needs at least one milestone, label or issue" : "a mandate's scope needs at least one milestone, label or issue, or a goal");
    else if (m.order === 'listed' && (lists[2] === 0 || lists[0] > 0 || lists[1] > 0)) problems.push('order listed needs scope.issues and no milestones or labels');
    else if (lists[2] > 0 && m.order !== 'listed') problems.push('scope.issues needs order listed (issues are worked in the order given)');
  }
  if (m.filedAt !== null && !isIso(m.filedAt)) problems.push('filedAt must be null or an ISO time');
  else if (m.filedAt !== null && typeof m.goal !== 'string') problems.push('filedAt is set only on a goal mandate, when its draft is filed');
  if (!oneOf(m.until, MANDATE_UNTIL)) problems.push(`until must be one of ${MANDATE_UNTIL.join(' | ')} ${got(m.until)}`);
  if (!isInt(m.maxJobs, 1, 16)) problems.push(`maxJobs must be an integer 1-16 ${got(m.maxJobs)}`);
  if (!oneOf(m.order, MANDATE_ORDERS)) problems.push(`order must be one of ${MANDATE_ORDERS.join(' | ')} ${got(m.order)}`);
  if (opts.decides && (!Array.isArray(m.decides) || !m.decides.every(isGateClass) || new Set(m.decides).size !== m.decides.length))
    problems.push(`decides must be a list of distinct gate classes ${got(m.decides)}`);
  const b = m.budget;
  if (!isMap(b) || Object.keys(b).some((k) => k !== 'usd' && k !== 'jobs')) problems.push('budget must be a map of usd and jobs');
  else {
    if (!(typeof b.usd === 'number' && Number.isFinite(b.usd) && b.usd > 0 && b.usd <= 100000)) problems.push(`budget.usd must be a number over 0 and at most 100000 ${got(b.usd)}`);
    if (!isInt(b.jobs, 1, 1000)) problems.push(`budget.jobs must be an integer 1-1000 ${got(b.jobs)}`);
  }
  const st = m.stall;
  if (!isMap(st) || Object.keys(st).some((k) => k !== 'cadences' && k !== 'bounces')) problems.push('stall must be a map of cadences and bounces');
  else {
    if (!isInt(st.cadences, 1, 100)) problems.push(`stall.cadences must be an integer 1-100 ${got(st.cadences)}`);
    if (!isInt(st.bounces, 1, 100)) problems.push(`stall.bounces must be an integer 1-100 ${got(st.bounces)}`);
  }
  if (!oneOf(m.onUnfinishable, MANDATE_ON_UNFINISHABLE)) problems.push(`onUnfinishable must be one of ${MANDATE_ON_UNFINISHABLE.join(' | ')} ${got(m.onUnfinishable)}`);
  if (!oneOf(m.scoring, MANDATE_SCORING)) problems.push(`scoring must be one of ${MANDATE_SCORING.join(' | ')} ${got(m.scoring)}`);
  if (m.after !== null && !isMandateId(m.after)) problems.push(badId('after', m.after));
  else if (m.after !== null && m.after === m.id) problems.push(`--after ${m.after}: a mandate can't follow itself`);
  for (const k of ['createdAt', 'updatedAt'] as const) if (!isIso(m[k])) problems.push(`${k} must be an ISO time`);
  if (m.closedAt !== null && !isIso(m.closedAt)) problems.push('closedAt must be null or an ISO time');
  problems.push(...goalProblems(m.goal));
  if (typeof m.body !== 'string') problems.push('the body must be text');
  else if (m.body.length > BODY_MAX) problems.push(`the body must be at most ${BODY_MAX} characters (got ${m.body.length})`);
  return problems;
}

/**
 * A file's parsed frontmatter and body as a Mandate, or unreadable with the first problem found: a
 * version from a newer Forge, an id that differs from the file name, a missing or unknown key, or any
 * term that breaks the rules. Never repaired: an unreadable mandate is never acted on.
 */
export function storedMandate(raw: unknown, fileId: string, body: string): ReadMandate {
  const bad = (problem: string): ReadMandate => ({ id: fileId, problem });
  if (!isMap(raw)) return bad('its frontmatter is not a map');
  const v = raw.schemaVersion;
  if (!Number.isInteger(v) || (v as number) < 1) return bad('schemaVersion must be a positive integer');
  if ((v as number) > MANDATE_SCHEMA_VERSION) return bad(`written by a newer Forge (schemaVersion ${v}); update the plugin`);
  const m = runSteps(MANDATE_STEPS, raw, v as number);
  if (m.id !== fileId) return bad(`its id ${JSON.stringify(String(m.id)).slice(0, 60)} differs from its file name`);
  const keys = Object.keys(m);
  const unknown = keys.find((k) => !(MANDATE_KEYS as readonly string[]).includes(k));
  if (unknown !== undefined) return bad(`unknown key ${JSON.stringify(unknown).slice(0, 60)}`);
  const missing = MANDATE_KEYS.find((k) => !keys.includes(k));
  if (missing !== undefined) return bad(`no ${missing}`);
  const problems = termProblems({ ...m, body }, { decides: true });
  if (problems.length) return bad(problems[0]);
  const pick = Object.fromEntries(MANDATE_KEYS.map((k) => [k, m[k]]));
  return { ...(pick as Omit<Mandate, 'body'>), schemaVersion: MANDATE_SCHEMA_VERSION, body };
}

/** The classes a mandate may be given: the effective foreman.decides, or none while foreman.reserved can't be read. */
export const grantable = (config: Config): GateClass[] => (reservedMatch(config, []) === INVALID_RESERVED ? [] : decides(config));

/**
 * `input` with every contract term it lacks taken from foreman.mandate, but scoring, which is `all` (no
 * config key sets it). The default decides is cut to the classes the config grants, so a default never
 * causes a refusal; a decides the owner names is not.
 */
export function fillDefaults(config: Config, input: MandateInput): MandateInput {
  const d = { ...defaults().foreman.mandate, ...(isMap(config.foreman?.mandate) ? config.foreman.mandate : {}) };
  const allowed = grantable(config);
  const defaultDecides = Array.isArray(d.decides) ? d.decides.filter((g: unknown): g is GateClass => isGateClass(g) && allowed.includes(g)) : [];
  return {
    ...input,
    until: input.until ?? d.until,
    maxJobs: input.maxJobs ?? d.maxJobs,
    order: input.order ?? d.order,
    decides: input.decides ?? defaultDecides,
    budgetUsd: input.budgetUsd ?? d.budget?.usd,
    budgetJobs: input.budgetJobs ?? d.budget?.jobs,
    stallCadences: input.stallCadences ?? d.stall?.cadences,
    stallBounces: input.stallBounces ?? d.stall?.bounces,
    onUnfinishable: input.onUnfinishable ?? d.onUnfinishable,
    scoring: input.scoring ?? 'all',
  };
}

/** A new mandate's record before any check: `active`, with no scope, contract or body until `input` fills them. */
export function blankMandate(id: string, at: string): Mandate {
  return {
    schemaVersion: MANDATE_SCHEMA_VERSION,
    id,
    title: '',
    status: 'active',
    reason: null,
    scope: { milestones: [], labels: [], issues: [] },
    until: 'merge-ready',
    maxJobs: 1,
    order: 'graph',
    decides: [],
    budget: { usd: 1, jobs: 1 },
    stall: { cadences: 1, bounces: 1 },
    onUnfinishable: 'park',
    scoring: 'all',
    after: null,
    createdAt: at,
    updatedAt: at,
    closedAt: null,
    filedAt: null,
    goal: null,
    body: '',
  };
}

/** `base` with only the terms `input` gives replaced. Values are taken as given: mandateProblems judges them. */
export function applyInput(base: Mandate, input: MandateInput): Mandate {
  const pick = <T>(v: T | undefined, was: T): T => (v === undefined ? was : v);
  return {
    ...base,
    title: input.title === undefined ? base.title : oneLineTitle(input.title),
    scope: { milestones: pick(input.milestones, base.scope.milestones), labels: pick(input.labels, base.scope.labels), issues: pick(input.issues, base.scope.issues) },
    until: pick(input.until, base.until) as Mandate['until'],
    maxJobs: pick(input.maxJobs, base.maxJobs),
    order: pick(input.order, base.order) as Mandate['order'],
    decides: pick(input.decides, base.decides) as GateClass[],
    budget: { usd: pick(input.budgetUsd, base.budget.usd), jobs: pick(input.budgetJobs, base.budget.jobs) },
    stall: { cadences: pick(input.stallCadences, base.stall.cadences), bounces: pick(input.stallBounces, base.stall.bounces) },
    onUnfinishable: pick(input.onUnfinishable, base.onUnfinishable) as Mandate['onUnfinishable'],
    scoring: pick(input.scoring, base.scoring) as Mandate['scoring'],
    after: pick(input.after, base.after),
    goal: pick<string | null>(input.goal, base.goal),
    body: pick(input.body, base.body),
  };
}

/**
 * `input.issues` in their stored form (`12` qualified with the repo under the github tracker), and why any
 * is refused; a refused ref is left out, so it is reported once.
 */
export function issueRefs(root: string, config: Config, input: MandateInput): { input: MandateInput; problems: string[] } {
  if (input.issues === undefined) return { input, problems: [] };
  const tracker = config.tracker?.kind ?? 'local';
  const slug = tracker === 'github' ? localRepoSlug(root, config) : null;
  const problems: string[] = [];
  const issues: string[] = [];
  for (const raw of input.issues) {
    const r = checkIssueRef(raw, { tracker, slug });
    if ('error' in r) problems.push(`issue ${JSON.stringify(raw).slice(0, 120)}: ${r.error}`);
    else issues.push(r.ref);
  }
  return { input: { ...input, issues }, problems };
}

/**
 * Every reason `forge mandate new|edit` refuses `m` (the record it would write), [] when it may be
 * written: the id, a closed target, every stored rule, a `decides` class the config doesn't grant, and
 * an `after` that is missing, unreadable, already followed (chains stay linear) or would close a cycle.
 */
export function mandateProblems(config: Config, m: Mandate, all: ReadMandate[], existing: Mandate | null): string[] {
  const problems: string[] = [];
  if (!isMandateId(m.id)) problems.push(badId('mandate id', m.id));
  if (existing?.status === 'closed') problems.push(`mandate ${m.id} is closed`);
  problems.push(...termProblems(m, { decides: false }));
  const written: unknown[] = Array.isArray(m.decides) ? m.decides : [];
  const listed = listedDecides(config);
  for (const g of written) {
    if (!isGateClass(g)) problems.push(`${oneLineTitle(String(g)).slice(0, 60)} is not a gate class`);
    else if (!listed.includes(g)) problems.push(`${g} is not in foreman.decides`);
    else if (classReservation(config, g)) problems.push(`${g} is reserved (gate:${g})`);
  }
  if (new Set(written).size !== written.length) problems.push('decides lists a class twice');
  if (written.length && reservedMatch(config, []) === INVALID_RESERVED) problems.push('foreman.reserved is invalid: every gate stays with a human until it is fixed');
  if (m.after !== null && isMandateId(m.after) && m.after !== m.id) problems.push(...afterProblems(m, all));
  return problems;
}

function afterProblems(m: Mandate, all: ReadMandate[]): string[] {
  const after = m.after!;
  const byId = new Map(all.map((x) => [x.id, x]));
  const target = byId.get(after);
  if (!target) return [`--after ${after}: no mandate ${after}`];
  if (!isReadable(target)) return [`--after ${after}: mandate ${after} can't be read (${target.problem})`];
  const follower = all.find((x) => isReadable(x) && x.after === after && x.id !== m.id);
  if (follower) return [`--after ${after}: mandate ${follower.id} already follows ${after} (chains stay linear)`];
  const seen = new Set<string>();
  for (let cur: ReadMandate | undefined = target; isReadable(cur) && cur.after !== null && !seen.has(cur.id); cur = byId.get(cur.after)) {
    seen.add(cur.id);
    if (cur.after === m.id) return [`--after ${after}: that would close a cycle (${after} already comes after ${m.id})`];
  }
  return [];
}

/**
 * The contract as it applies now, and `capped`: one line per term the config changed. decides keeps
 * only the classes the effective foreman.decides grants (none while the foreman is off or
 * foreman.reserved can't be read); `merged` applies only under foreman.ship: merge.
 */
export function effectiveContract(config: Config, m: Mandate): { effective: MandateContract; capped: string[] } {
  const capped: string[] = [];
  let kept: GateClass[] = [];
  if (!foremanEnabled(config)) {
    if (m.decides.length) capped.push('decides: none apply (foreman.enabled is false)');
  } else if (reservedMatch(config, []) === INVALID_RESERVED) {
    if (m.decides.length) capped.push('decides: none apply (foreman.reserved is invalid)');
  } else {
    const listed = listedDecides(config);
    for (const g of m.decides) {
      const held = classReservation(config, g);
      if (!listed.includes(g)) capped.push(`decides: ${g} dropped (not in foreman.decides)`);
      else if (held) capped.push(`decides: ${g} dropped (reserved: ${held})`);
      else kept.push(g);
    }
  }
  let until = m.until;
  if (until === 'merged' && config.foreman?.ship !== 'merge') {
    until = 'merge-ready';
    capped.push('until: merged needs foreman.ship: merge; merge-ready applies');
  }
  return { effective: { ...contractOf(m), decides: kept, until }, capped };
}

const contractOf = (m: Mandate): MandateContract => ({
  until: m.until,
  maxJobs: m.maxJobs,
  order: m.order,
  decides: [...m.decides],
  budget: { ...m.budget },
  stall: { ...m.stall },
  onUnfinishable: m.onUnfinishable,
  scoring: m.scoring,
});

/** closed; paused; waiting while `after` names a mandate that isn't closed (or is missing or unreadable); else active. */
export function mandateState(m: Mandate, all: ReadMandate[]): MandateState {
  if (m.status === 'closed') return 'closed';
  if (m.status === 'paused') return 'paused';
  if (m.after === null) return 'active';
  const before = all.find((x) => x.id === m.after);
  return isReadable(before) && before.status === 'closed' ? 'active' : 'waiting';
}

const byCreated = (a: Mandate, b: Mandate) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/**
 * The chain `m` sits in, first link to last, and its active link: the first that isn't closed (an
 * unreadable one counts as not closed, so nothing after it starts), or null when every link is closed.
 */
export function mandateChain(m: Mandate, all: ReadMandate[]): { chain: string[]; activeLink: string | null } {
  const byId = new Map(all.map((x) => [x.id, x]));
  const seen = new Set([m.id]);
  const links: ReadMandate[] = [m];
  for (let cur: ReadMandate = m; isReadable(cur) && cur.after !== null && !seen.has(cur.after); ) {
    const prev = byId.get(cur.after);
    if (!prev) break;
    seen.add(prev.id);
    links.unshift(prev);
    cur = prev;
  }
  const readable = all.filter(isReadable);
  for (let cur = m; ; ) {
    const next = readable.filter((x) => x.after === cur.id && !seen.has(x.id)).sort(byCreated)[0];
    if (!next) break;
    seen.add(next.id);
    links.push(next);
    cur = next;
  }
  const active = links.find((x) => !(isReadable(x) && x.status === 'closed'));
  return { chain: links.map((x) => x.id), activeLink: active ? active.id : null };
}

/** The summary every `forge mandate` command returns for one mandate. */
export function mandateSummary(m: Mandate, all: ReadMandate[]): MandateSummary {
  return {
    id: m.id,
    title: m.title,
    status: m.status,
    state: mandateState(m, all),
    reason: m.reason,
    after: m.after,
    intake: m.goal !== null,
    scope: { milestones: [...m.scope.milestones], labels: [...m.scope.labels], issues: [...m.scope.issues] },
    contract: contractOf(m),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    closedAt: m.closedAt,
    filedAt: m.filedAt,
  };
}

/** The owner's guidance fenced as data, the only form a brief or `show` ever carries it in; '' for an empty body. */
export const mandateGuidance = (m: Pick<Mandate, 'id' | 'body'>): string => (m.body.trim() ? fenceImport(m.body, `mandate ${m.id}`) : '');

/** A goal mandate's goal fenced as data, the only form `show` and the drafting survey carry it in; '' for none. */
export const mandateGoal = (m: Pick<Mandate, 'id' | 'goal'>): string => (m.goal === null ? '' : fenceImport(m.goal, `mandate ${m.id} goal`));

/** A pause or close reason as stored: one line, at most 200 characters, null when empty. */
export const cleanReason = (raw: unknown): string | null => {
  const r = typeof raw === 'string' ? oneLineTitle(raw).slice(0, REASON_MAX).trim() : '';
  return r || null;
};
