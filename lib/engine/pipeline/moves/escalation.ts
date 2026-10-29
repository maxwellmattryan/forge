// Escalation reasons as data: the one park reason that lists them (`escalation: <rules>`), its parser
// (today's form and the reasons the merge gates wrote before they collapsed), the `gate` events
// `forge job gate` logs, and the brief lines that carry them. Pure: no I/O.
// lib/engine/guard/protected.ts imports this module, so it never imports protected.ts.
import { ESCALATION_RULES, GATE_RULES } from '#api/constants.ts';
import { isForemanActor } from '#core/job/store.ts';
import type { GateReason, GateRule, Job, JobEvent, ProtectedPaths } from '#core/types.ts';

/**
 * The rules only a person clears: never the Foreman, so a Foreman approve can't lead to an auto-merge
 * past an auth change, a migration or infra steps.
 */
export const HUMAN_ONLY_RULES: readonly GateRule[] = ['protected-paths', 'lens-escalate', 'runbook'];

/** The collapsed escalation park's reason prefix; PP1 puts PUSH_HELD before it. */
export const ESCALATION_PREFIX = 'escalation: ';
const PUSH_HELD = 'push held: ';

/** The `approver` reason's detail: fixed words, so decision.md's text never reaches a reason. */
export const APPROVER_DETAIL = 'the approver escalated: see decision.md';

/** At most this many paths on one reason. */
export const REASON_PATHS = 10;

/** A detail is CLI-composed; this caps one read back from an event. */
const DETAIL_MAX = 200;
const PATH_MAX = 400;
/** No park reason Forge writes is longer; a longer one lists no rule. */
const REASON_MAX = 4096;

// The reasons PR15, PR16, PP1b and PP1 wrote before the merge gates collapsed into one park.
const LEGACY_APPROVER = 'approver escalated: see decision.md';
const LEGACY_RUNBOOK = 'runbook: steps before merge';
const LEGACY_PROTECTED = 'protected paths: ';

/** The detail a park's rule gets when no gate event names it (a legacy park, or a flag raised after it). */
const FALLBACK_DETAIL: Record<GateRule, string> = {
  approver: APPROVER_DETAIL,
  'protected-paths': 'escalate paths no person approved',
  'lens-escalate': 'a review says ESCALATE',
  runbook: 'runbook.md has steps for a person',
  acs: 'acceptance criteria are unmapped or failing',
  version: 'a manifest version changed',
  dependencies: 'a dependency table changed',
};

const CONTROL = /[\x00-\x1f\x7f\u{2028}\u{2029}]/gu;
// U+2028 and U+2029, which JSON.stringify leaves raw; built from code points so no source line holds either.
const SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const oneLineJson = (v: unknown): string => JSON.stringify(v).replace(SEPARATORS, (c) => `\\u${c.charCodeAt(0).toString(16)}`);

const isRule = (v: unknown): v is GateRule => (ESCALATION_RULES as readonly unknown[]).includes(v);
const isGateRule = (v: unknown): v is GateRule => (GATE_RULES as readonly unknown[]).includes(v);

/** The rules, unique, in ESCALATION_RULES order. */
export const sortRules = (rules: readonly GateRule[]): GateRule[] => ESCALATION_RULES.filter((r) => rules.includes(r));

/** `escalation: a, b`: the park reason listing `rules`, unique and in table order. */
export function escalationReason(rules: readonly GateRule[]): string {
  return `${ESCALATION_PREFIX}${sortRules(rules).join(', ')}`;
}

/**
 * The rules a park reason lists, in table order: `escalation: <rules>`, with or without PP1's
 * `push held: ` prefix (any unknown token lists nothing), and the legacy forms: `approver escalated:
 * see decision.md`, `runbook: steps before merge` and `protected paths: …`. [] for any other reason.
 */
export function parseEscalationReason(reason: unknown): GateRule[] {
  if (typeof reason !== 'string' || reason.length > REASON_MAX) return [];
  const r = reason.startsWith(PUSH_HELD) ? reason.slice(PUSH_HELD.length) : reason;
  if (r === LEGACY_APPROVER) return ['approver'];
  if (r === LEGACY_RUNBOOK) return ['runbook'];
  if (r.startsWith(LEGACY_PROTECTED)) return ['protected-paths'];
  if (!r.startsWith(ESCALATION_PREFIX)) return [];
  const tokens = r.slice(ESCALATION_PREFIX.length).split(', ');
  return tokens.every(isRule) ? sortRules(tokens) : [];
}

/** A decision a person made: anything but the Foreman's. #384/#449 add the daemon source here. */
export const personDecision = (e: { actor?: unknown }): boolean => !isForemanActor(e);

/**
 * A `gate` event's reasons, checked again: a rule `forge job gate` computes, a string detail with
 * control characters dropped, and at most REASON_PATHS string paths. Anything else is skipped.
 */
export function readGateReasons(v: unknown): GateReason[] {
  if (!Array.isArray(v)) return [];
  const out: GateReason[] = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const { rule, detail, paths } = r as Record<string, unknown>;
    if (!isGateRule(rule) || typeof detail !== 'string') continue;
    const ps = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string').slice(0, REASON_PATHS).map((p) => p.slice(0, PATH_MAX)) : [];
    out.push({ rule, detail: detail.replace(CONTROL, ' ').slice(0, DETAIL_MAX), ...(ps.length ? { paths: ps } : {}) });
  }
  return out;
}

/** The last `gate` event, when it comes after position `after` (any, when null): its position and checked reasons. */
export function latestGate(events: readonly JobEvent[], after: number | null): { i: number; reasons: GateReason[] } | null {
  const i = events.findLastIndex((e) => e.type === 'gate');
  if (i < 0 || (after !== null && i <= after)) return null;
  return { i, reasons: readGateReasons(events[i].reasons) };
}

/** The `protected-paths` reason for an unapproved flag: the count of every hit, and the first REASON_PATHS paths. */
export function protectedGateReason(flag: Pick<ProtectedPaths, 'hits' | 'more'>): GateReason {
  const n = flag.hits.length + (Number(flag.more) || 0);
  const paths = flag.hits.slice(0, REASON_PATHS).map((h) => String(h.path).slice(0, PATH_MAX));
  return { rule: 'protected-paths', detail: `${n} escalate path${n === 1 ? '' : 's'} no person approved`, paths };
}

/**
 * The reasons of the park at `parkIdx`: each rule its reason lists, with the details of the latest gate
 * event before the park (protected paths from `flag`, when given), else a fixed detail. [] for a park
 * whose reason lists no rule.
 */
export function parkReasons(events: readonly JobEvent[], parkIdx: number, flag?: Pick<ProtectedPaths, 'hits' | 'more'> | null): GateReason[] {
  const rules = parseEscalationReason(events[parkIdx]?.reason);
  if (!rules.length) return [];
  const known = readGateReasons(events.slice(0, parkIdx).findLast((e) => e.type === 'gate')?.reasons);
  const out: GateReason[] = [];
  for (const rule of rules) {
    const mine = known.filter((r) => r.rule === rule);
    if (rule === 'protected-paths' && flag?.hits?.length) out.push(protectedGateReason(flag));
    else if (rule !== 'approver' && mine.length) out.push(...mine);
    else out.push({ rule, detail: FALLBACK_DETAIL[rule] });
  }
  return out;
}

/**
 * /api/state's `gateReasons`: while the job waits on `escalation` with a reason that lists rules, the
 * reasons of the park its last transition entered; null otherwise.
 */
export function waitingGateReasons(job: Pick<Job, 'state' | 'waitingOn' | 'reason' | 'protectedPaths'>, events: readonly JobEvent[]): GateReason[] | null {
  if (job.state !== 'waiting' || job.waitingOn !== 'escalation' || !parseEscalationReason(job.reason).length) return null;
  const at = events.findLastIndex((e) => e.type === 'transition');
  const reasons = at < 0 ? [] : parkReasons(events, at, job.protectedPaths);
  return reasons.length ? reasons : null;
}

/**
 * The approver's and the Foreman assistant's `Gate reasons` line: the latest gate event after `after`
 * as JSON (so a branch path can't start a line of the brief), or `none`.
 */
export function gateReasonsLine(events: readonly JobEvent[], after: number | null): string {
  const g = latestGate(events, after);
  if (!g?.reasons.length) return 'Gate reasons: none';
  return `Gate reasons (JSON): ${oneLineJson(g.reasons)} · facts the CLI found, each already held for a person: don't re-derive them, never argue one away, never mark auto-merge eligible while any is listed`;
}

/** The approver's `Protected paths:` line. JSON, so a path can't start a line of the brief. */
export function protectedLine(job: Pick<Job, 'protectedPaths'>): string {
  const flag = job.protectedPaths;
  if (!flag?.hits?.length) return 'Protected paths: none';
  const shown = flag.hits.slice(0, 20).map((h) => h.path);
  const more = flag.hits.length - shown.length + (Number(flag.more) || 0);
  return `Protected paths: ${oneLineJson(shown)}${more > 0 ? ` (+${more} more)` : ''}: a human must approve after you whatever you decide; never mark auto-merge eligible`;
}
