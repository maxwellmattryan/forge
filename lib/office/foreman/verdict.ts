// A gate run's verdict: the strict parser over the forge:assistant's last line, the reason it carries,
// cleaned, and the gate table that turns a verdict into the decision the gate runner (./run.ts) records.
// The assistant's reply is model output steered by job text, so nothing here is lenient: anything but
// the exact line is malformed, and a malformed reply never becomes an approve. docs/architecture/foreman.md.
import type { GateClass } from '#core/types.ts';

export const VERDICTS = ['approve', 'revise', 'rework', 'escalate'] as const;
export type Verdict = (typeof VERDICTS)[number];
/** A senior pass's verdicts (./senior.ts): the assistant's, plus shelve, which the gate runner handles before the gate table. */
export const SENIOR_VERDICTS = [...VERDICTS, 'shelve'] as const;
export type SeniorVerdict = (typeof SENIOR_VERDICTS)[number];

/** The longest reason kept: it becomes the decision's note and the hand-off reason. */
export const REASON_MAX = 200;

/**
 * The exact verdict line: `ASSIST:` in capitals, one space, a lowercase verdict, then space, U+00B7, space,
 * and a reason. One unbounded group after fixed text, so no input backtracks.
 */
const VERDICT_LINE = /^ASSIST: (approve|revise|rework|escalate) · (.+)$/;
/** The senior pass's line: the same shape, with shelve too. */
const SENIOR_VERDICT_LINE = /^ASSIST: (approve|revise|rework|escalate|shelve) · (.+)$/;

/** What a reason loses: quotes, backticks, `$`, backslashes, control characters, and the line and paragraph separators. */
const UNSAFE = /["`$\\\p{Cc}\p{Zl}\p{Zp}]/gu;

/**
 * A reason as a note and a hand-off store it: `"`, `` ` ``, `$`, `\` and every control character (with the
 * Unicode line and paragraph separators) removed, whitespace runs collapsed to one space, trimmed, at most
 * REASON_MAX characters. Empty when nothing is left.
 */
export function cleanReason(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(UNSAFE, '').replace(/\s+/g, ' ').trim().slice(0, REASON_MAX);
}

/**
 * The verdict on the last non-empty line of the assistant's final result text, trimmed, or null when that
 * line is not exactly `ASSIST: <verdict> · <reason>` or its reason is empty once cleaned. Lines before it
 * (a preamble, an earlier ASSIST line) are ignored; a line after it makes the reply malformed. Only with
 * `senior` (a senior pass) is `shelve` a verdict; the assistant's `shelve` is malformed.
 */
export function parseVerdict(text: unknown, opts: { senior?: boolean } = {}): { verdict: SeniorVerdict; reason: string } | null {
  if (typeof text !== 'string') return null;
  const last = text
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .at(-1);
  const m = last === undefined ? null : (opts.senior === true ? SENIOR_VERDICT_LINE : VERDICT_LINE).exec(last);
  if (!m) return null;
  const reason = cleanReason(m[2]);
  return reason ? { verdict: m[1] as SeniorVerdict, reason } : null;
}

/** What a gate's verdict becomes: a `forge job human` action, a milestone-draft decision, a hand-off, or (pr-feedback) nothing. */
export type GateMove = { action: string } | { draft: 'approve' | 'revise' } | 'escalate' | 'no-action';

const job = (approve: string, revise: string, rework: string) => ({ approve: { action: approve }, revise: { action: revise }, rework: { action: rework } });

/** The gate table: every (gate, verdict) pair but escalate, which always hands off. */
export const GATE_TABLE: Readonly<Record<GateClass, Readonly<Record<Exclude<Verdict, 'escalate'>, GateMove>>>> = Object.freeze({
  'spec-approval': job('approve-spec', 'revise-spec', 'revise-spec'),
  'split-approval': job('approve-split', 'revise-split', 'revise-split'),
  escalation: job('approve', 'revise-spec', 'rework'),
  'rounds-exhausted': job('approve', 'revise-spec', 'rework'),
  conflicts: { approve: { action: 'approve' }, revise: 'escalate', rework: { action: 'approve' } },
  'repo-proposal': job('approve-repos', 'reject-repos', 'reject-repos'),
  'pr-feedback': { approve: 'no-action', revise: { action: 'rework' }, rework: { action: 'rework' } },
  release: { approve: { action: 'approve-release' }, revise: 'escalate', rework: 'escalate' },
  'milestone-approval': { approve: { draft: 'approve' }, revise: { draft: 'revise' }, rework: { draft: 'revise' } },
});

/** The move for `verdict` at `gate`: escalate for escalate, else the table's cell. */
export const gateMove = (gate: GateClass, verdict: Verdict): GateMove => (verdict === 'escalate' ? 'escalate' : GATE_TABLE[gate][verdict]);
