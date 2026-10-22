// The foreman: with `foreman.enabled`, a job parking on a gate the foreman decides becomes a `gate`
// request for the `_office` daemon session, which hands the judgement to a forge:assistant
// sub-agent and records the verdict with `forge job human … --actor foreman`. The CLI, not the
// prompt, holds the authority line: checkForemanDecision runs before any write.
// docs/ARCHITECTURE.md "Foreman".
import fs from 'node:fs';
import path from 'node:path';
import { isForemanActor, jobDir, readEvents } from './jobs.ts';
import { OFFICE_SCOPE, daemonScope, enqueue, listRequests } from './requests.ts';
import { HANDOFF_CLASSES, OFFICE_GATES, reservedGateEntry } from './schema.ts';
import { isRepoProposalPark, pendingRepoProposals, repoProposals } from './repo-proposals.ts';
import { ForgeError, safeText } from './util.ts';
import type { Config, ForemanHandoff, ForgeRequest, GateClass, GateOwner, HandoffClass, Job, JobEvent } from './types.ts';

export { OFFICE_GATES } from './schema.ts';

/** The `forge job human` actions each gate class takes from the foreman. */
export const ACTIONS_BY_GATE: Record<GateClass, readonly string[]> = {
  'spec-approval': ['approve-spec', 'revise-spec'],
  'split-approval': ['approve-split', 'revise-split'],
  escalation: ['approve', 'revise-spec', 'rework'],
  'rounds-exhausted': ['approve', 'revise-spec', 'rework'],
  conflicts: ['approve'],
  'pr-feedback': ['rework'],
  'repo-proposal': ['approve-repos', 'reject-repos'],
  // No job waits on a release, so it has no SET_AFTER entry: checkOfficeSet refuses any move after it.
  release: ['approve-release'],
};

/** What reservedMatch returns when foreman.reserved can't be read: every gate stays with a human. */
export const INVALID_RESERVED = '(invalid foreman.reserved)';

const SHA = /^[0-9a-f]{40}$/;
/** decision.md is read only for its two sections; anything larger is not a decision the foreman takes. */
const MAX_DECISION_BYTES = 256 * 1024;

export const isGateClass = (g: unknown): g is GateClass => (OFFICE_GATES as readonly unknown[]).includes(g);

/**
 * The class of the gate a job waits on, or null: pr-review counts as pr-feedback, and RP1's `human`
 * park counts as repo-proposal while its events still hold a pending proposal.
 */
export function gateClass(job: Pick<Job, 'state' | 'waitingOn' | 'reason' | 'repos'>, events: JobEvent[] = []): GateClass | null {
  if (job.state !== 'waiting') return null;
  if (isRepoProposalPark(job)) return pendingRepoProposals(job, events).length ? 'repo-proposal' : null;
  if (job.waitingOn === 'pr-review') return 'pr-feedback';
  return isGateClass(job.waitingOn) ? job.waitingOn : null;
}

/** gateClass with the job's events read from disk, only for the one park that needs them. */
export function gateClassFor(root: string, job: Pick<Job, 'id' | 'state' | 'waitingOn' | 'reason' | 'repos'>): GateClass | null {
  return gateClass(job, isRepoProposalPark(job) ? readEvents(root, job.id) : []);
}

/** foreman.decides as written, with anything that isn't a gate class dropped (validation reports those). */
function listedDecides(config: Config): GateClass[] {
  const d = config.foreman?.decides;
  return Array.isArray(d) ? d.filter(isGateClass) : [];
}

const GATE_PREFIX = 'gate:';

/**
 * The gate classes foreman.reserved keeps with a human as a whole (`gate:<class>` entries). A
 * `reserved` that can't be read, or a mis-written `gate:` entry, is not handled here:
 * reservedMatch fails closed on it, so every gate still stays with a human.
 */
function reservedClasses(config: Config): GateClass[] {
  const patterns: unknown = config.foreman?.reserved;
  if (!Array.isArray(patterns)) return [];
  const out = new Set<GateClass>();
  for (const p of patterns) {
    const g = typeof p === 'string' ? reservedGateEntry(p) : null;
    if (g !== null && g !== 'invalid') out.add(g);
  }
  return [...out];
}

/** The `gate:<class>` entry that keeps `gate` with a human as a class, or null. */
export const classReservation = (config: Config, gate: GateClass): string | null => (reservedClasses(config).includes(gate) ? `${GATE_PREFIX}${gate}` : null);

/**
 * The gate classes the foreman decides: foreman.decides minus every class foreman.reserved keeps with
 * a human (`gate:<class>`), so reserved wins wherever a caller asks.
 */
export function decides(config: Config): GateClass[] {
  const held = reservedClasses(config);
  return listedDecides(config).filter((g) => !held.includes(g));
}

export const foremanEnabled = (config: Config): boolean => config.foreman?.enabled === true;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/**
 * The first foreman.reserved pattern found in `texts`, matched case-insensitively as a whole phrase
 * (no letter or digit on either side), or null. A setting that isn't a list of non-empty strings
 * fails closed with INVALID_RESERVED. Each pattern is an escaped literal, so matching is linear.
 */
export function reservedMatch(config: Config, texts: (string | null | undefined)[]): string | null {
  const patterns: unknown = config.foreman?.reserved;
  if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== 'string' || !p.trim())) return INVALID_RESERVED;
  const hay = texts.filter((t): t is string => typeof t === 'string' && t !== '');
  for (const p of patterns as string[]) {
    // `gate:<class>` reserves a class (reservedClasses), never text; a mis-written one fails closed.
    const g = reservedGateEntry(p);
    if (g === 'invalid') return INVALID_RESERVED;
    if (g !== null) continue;
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(p.trim())}(?![A-Za-z0-9])`, 'i');
    if (hay.some((t) => re.test(t))) return p;
  }
  return null;
}

/**
 * decision.md's text when it is a small regular file, '' when it is absent, and null when it can't
 * be read safely (a link, a FIFO, too large), which the caller treats as reserved.
 */
function readDecision(root: string, id: string): string | null {
  const file = path.join(jobDir(root, id), 'decision.md');
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_DECISION_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, st.size, 0));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? '' : null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Stands in for a decision.md that can't be read safely; reservedFor turns it into a reserved match. */
const INVALID_RESERVED_TEXT = '\u0000unreadable decision.md';

/** The bodies of the `## <title>` sections named, by a line scan (no regex over the whole text). */
export function sections(text: string, titles: string[]): string[] {
  const want = new Set(titles.map((t) => t.toLowerCase()));
  const out: string[] = [];
  let current: string[] | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      if (current) out.push(current.join('\n'));
      current = want.has(line.slice(3).trim().toLowerCase()) ? [] : null;
    } else if (current) current.push(line);
  }
  if (current) out.push(current.join('\n'));
  return out;
}

/**
 * What a reserved pattern is matched against for a gate: the reason, plus decision.md's Why and For the
 * human on escalations, and the agent-written reasons of the pending proposals on a repo proposal.
 */
function reservedTexts(root: string, job: Pick<Job, 'id' | 'reason'>, gate: GateClass | null): string[] {
  const texts = [job.reason ?? ''];
  // From events, not repo-proposals.md: the reasons the assistant reads, without the session-editable copy.
  if (gate === 'repo-proposal') texts.push(...repoProposals({ repos: [] }, readEvents(root, job.id)).filter((r) => r.status === 'pending').map((r) => r.reason));
  if (gate === 'escalation' || gate === 'rounds-exhausted') {
    const d = readDecision(root, job.id);
    // An unreadable decision.md can't be checked, so it counts as reserved.
    texts.push(d === null ? INVALID_RESERVED_TEXT : sections(d, ['Why', 'For the human']).join('\n'));
  }
  return texts;
}

/** What reservedFor returns when the latest round's security review asked for changes. */
export const SECURITY_CHANGES = '(security review: CHANGES)';
/** ...and when it is anything but PASS or CHANGES (MALFORMED, a value Forge doesn't know): fail closed. */
export const SECURITY_UNCLEAR = '(security review: not PASS)';

/** The verdict of the security lens in the latest round that has one, or null. */
export function latestSecurityVerdict(job: Pick<Job, 'verdicts'>): string | null {
  const rounds = Object.keys(job.verdicts ?? {})
    .map(Number)
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => b - a);
  for (const n of rounds) {
    const v = (job.verdicts as Record<string, Record<string, unknown>>)[String(n)]?.security;
    if (typeof v === 'string') return v;
  }
  return null;
}

/** The total-round ceiling: pipeline.maxTotalRounds, or twice the job's maxRounds when it is null. */
export function totalRoundCeiling(config: Config, job: Partial<Pick<Job, 'maxRounds'>>): number {
  const set = config?.pipeline?.maxTotalRounds;
  return typeof set === 'number' && Number.isInteger(set) && set >= 1 ? set : 2 * (Number(job.maxRounds) || 0);
}

/** The job's round is past the total-round ceiling, whoever opened its rounds. */
export function pastTotalCeiling(config: Config, job: Partial<Pick<Job, 'round' | 'maxRounds'>>): boolean {
  return typeof job.round === 'number' && job.round > totalRoundCeiling(config, job);
}

/**
 * What reservedFor returns at a retro job's spec gate, whatever the action and whatever foreman.decides
 * says: a retro rewrites the instructions every agent, the office's included, runs on.
 */
export const RETRO_SPEC_HOLD = "retro spec: a human approves Forge's own improvements";

const isRetroSpec = (job: Partial<Pick<Job, 'kind'>>, gate: GateClass | null): boolean => job.kind === 'retro' && gate === 'spec-approval';

/** What reservedFor returns at a rounds-exhausted park past the total-round ceiling, whatever the action. */
export const TOTAL_CEILING = '(total-round ceiling: only a human clears it)';

/** The foreman actions that send a job back to fix a security finding rather than accept it. */
const SECURITY_MITIGATIONS: readonly string[] = ['rework', 'revise-spec', 'revise-split', 'reject-repos'];

/** SECURITY_CHANGES or SECURITY_UNCLEAR while the latest security review isn't PASS, else null. */
export function securityHold(job: Pick<Job, 'verdicts'>): string | null {
  const security = latestSecurityVerdict(job);
  if (security === 'CHANGES') return SECURITY_CHANGES;
  // A security review Forge couldn't read (MALFORMED) is no proof the posture is fine.
  if (security !== null && security !== 'PASS') return SECURITY_UNCLEAR;
  return null;
}

/**
 * reservedMatch over reservedTexts (and extra texts such as the note), with an unreadable decision.md
 * reserved. A latest security review that isn't PASS (CHANGES, MALFORMED, anything else) holds what
 * would accept it: the foreman may still mitigate (rework or revise to fix the findings), never approve
 * past them: security always has to pass. With `action`, that action is judged; without, the gate is
 * held when it has no mitigation. A rounds-exhausted park past the total-round ceiling is held for
 * every action: only a person opens another round there.
 */
export function reservedFor(
  root: string,
  config: Config,
  job: Pick<Job, 'id' | 'reason' | 'verdicts'> & Partial<Pick<Job, 'round' | 'maxRounds' | 'waitingOn' | 'kind'>>,
  gate: GateClass | null,
  extra: (string | null | undefined)[] = [],
  opts: { action?: string } = {},
): string | null {
  if (isRetroSpec(job, gate)) return RETRO_SPEC_HOLD;
  if (gate === 'rounds-exhausted' && pastTotalCeiling(config, job)) return TOTAL_CEILING;
  const hold = securityHold(job);
  const mitigates = opts.action !== undefined ? SECURITY_MITIGATIONS.includes(opts.action) : gate !== null && ACTIONS_BY_GATE[gate].some((a) => SECURITY_MITIGATIONS.includes(a));
  if (hold && !mitigates) return hold;
  const texts = reservedTexts(root, job, gate);
  if (texts.includes(INVALID_RESERVED_TEXT)) return '(unreadable decision.md)';
  return reservedMatch(config, [...texts, ...extra]);
}

/**
 * A PR with feedback the foreman may act on: trusted feedback (threads or change requests from someone
 * with write access, counted by trustedFeedback in lib/pr.ts) or failing checks.
 */
function prHasFeedback(job: Pick<Job, 'pr'>, trusted: number): boolean {
  return trusted > 0 || job.pr?.checks?.state === 'failing';
}

const isGateRequest = (r: ForgeRequest, job: string, gate: GateClass) => r.type === 'gate' && r.job === job && r.args?.gate === gate;

/**
 * Who owns a waiting job's gate, for the dashboard: `foreman` when the foreman is on and the gate is
 * one it decides and isn't reserved (or refused by the foreman already), `human` for every other
 * gate, null when the job waits on nothing or the foreman is off.
 */
export function gateOwner(root: string, config: Config, job: Job, requests: ForgeRequest[] = listRequests(root)): GateOwner {
  if (!foremanEnabled(config) || job.state !== 'waiting') return null;
  const gate = gateClassFor(root, job);
  if (!gate || !decides(config).includes(gate)) return 'human';
  if (reservedFor(root, config, job, gate)) return 'human';
  const latest = requests.filter((r) => isGateRequest(r, job.id, gate) && (gate !== 'pr-feedback' || r.args?.key === job.pr?.headOid)).at(-1);
  // pr-feedback is the foreman's only once sync queued a gate for this head (trusted feedback or failing checks).
  if (gate === 'pr-feedback' && !latest) return 'human';
  return latest?.status === 'rejected' ? 'human' : 'foreman';
}

/**
 * Called by `forge job set` after its write: a new park (or a different gate) on a class the foreman
 * decides queues one `gate` request, unless one for the same job and gate is pending or in progress.
 * pr-review parks go through enqueuePrFeedbackGate instead.
 */
export function maybeEnqueueGate(root: string, config: Config, before: Pick<Job, 'state' | 'waitingOn'>, after: Job): ForgeRequest | null {
  if (!foremanEnabled(config)) return null;
  const gate = gateClassFor(root, after);
  if (!gate || gate === 'pr-feedback' || !decides(config).includes(gate)) return null;
  if (before.state === 'waiting' && before.waitingOn === after.waitingOn) return null;
  // Past the total-round ceiling, and at a retro's spec, the gate is a person's alone: no request for the office to read.
  if (gate === 'rounds-exhausted' && pastTotalCeiling(config, after)) return null;
  if (isRetroSpec(after, gate)) return null;
  const open =listRequests(root).some((r) => isGateRequest(r, after.id, gate) && (r.status === 'pending' || r.status === 'in-progress'));
  if (open) return null;
  const reserved = reservedFor(root, config, after, gate);
  return enqueue(root, config, { type: 'gate', job: after.id, args: { gate, reserved }, from: 'forge' });
}

/**
 * Called by `forge pr sync` (never by `forge pr merge`): a job waiting on pr-review with feedback
 * queues one pr-feedback gate per PR head, counting requests in any status, so a new push re-arms it.
 */
export function enqueuePrFeedbackGate(root: string, config: Config, job: Job, trusted: number): ForgeRequest | null {
  if (!foremanEnabled(config) || !decides(config).includes('pr-feedback')) return null;
  if (gateClass(job) !== 'pr-feedback' || !prHasFeedback(job, trusted)) return null;
  const key = job.pr?.headOid;
  if (typeof key !== 'string' || !SHA.test(key)) return null;
  if (listRequests(root).some((r) => isGateRequest(r, job.id, 'pr-feedback') && r.args?.key === key)) return null;
  const reserved = reservedFor(root, config, job, 'pr-feedback');
  return enqueue(root, config, { type: 'gate', job: job.id, args: { gate: 'pr-feedback', key, reserved }, from: 'forge' });
}

/** A pending or in-progress pr-feedback gate request for the job's current PR head exists. */
function queuedPrFeedbackGate(root: string, job: Pick<Job, 'id' | 'pr'>, requests: ForgeRequest[] = listRequests(root)): boolean {
  const head = job.pr?.headOid;
  if (typeof head !== 'string' || !SHA.test(head)) return false;
  return requests.some((r) => isGateRequest(r, job.id, 'pr-feedback') && r.args?.key === head && (r.status === 'pending' || r.status === 'in-progress'));
}

/** The daemon scope this call runs in is the office session. */
export function inOffice(env: NodeJS.ProcessEnv = process.env): boolean {
  const s = daemonScope(env);
  return 'daemon' in s && s.daemon && s.scope === OFFICE_SCOPE;
}

/**
 * Every check on a foreman decision, before anything is written: the office scope, no --link or
 * --reason, a job waiting on a gate the foreman decides, an action that belongs to that gate, for
 * pr-feedback a queued gate request for the current PR head, and no reserved pattern in the reason,
 * decision.md or the note. Throws ForgeError (exit 1).
 */
export function checkForemanDecision(
  root: string,
  config: Config,
  job: Job,
  action: string,
  note: string | null | undefined,
  flags: { link?: unknown; reason?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): GateClass {
  const refuse = (why: string): never => {
    throw new ForgeError(`--actor foreman refused: ${why}`, 1);
  };
  if (!inOffice(env)) refuse('only the office daemon session records foreman decisions');
  if (flags.link !== undefined || flags.reason !== undefined) refuse('linking an issue stays a human call (no --link or --reason)');
  if (typeof note !== 'string' || !note.trim()) refuse('a foreman decision needs --note with its reason');
  const gate = gateClassFor(root, job);
  if (!gate) refuse(`job ${job.id} is not waiting on a gate the foreman decides`);
  if (!foremanEnabled(config)) refuse('foreman.enabled is false');
  if (!listedDecides(config).includes(gate!)) refuse(`${gate} is not in foreman.decides`);
  const held = classReservation(config, gate!);
  if (held) refuse(`${gate} is reserved (${held}): left for a human`);
  if (!ACTIONS_BY_GATE[gate!].includes(action)) refuse(`${action} is not a ${gate} action (${ACTIONS_BY_GATE[gate!].join(', ')})`);
  // pr-feedback is the foreman's only once sync armed it for this head (trusted feedback or failing
  // checks): a queued gate request keyed by the PR's current head sha must exist.
  if (gate === 'pr-feedback' && !queuedPrFeedbackGate(root, job)) refuse(`no queued pr-feedback gate request for ${job.id}'s current PR head`);
  const reserved = reservedFor(root, config, job, gate, [note], { action });
  if (reserved) refuse(`reserved (${reserved}): left for a human`);
  return gate!;
}

/**
 * The stages a `forge job set --state running` may move a job to right after each foreman action: the
 * second column of the gate table in skills/forge/reference/foreman.md. undefined: the stage stays.
 */
const SET_AFTER: Record<string, readonly (string | undefined)[]> = {
  'approve-spec': [undefined, 'spec'],
  'revise-spec': ['spec'],
  'approve-split': ['plan'],
  'revise-split': ['plan'],
  approve: ['integrate', 'decide'],
  rework: ['build'],
  'approve-repos': [undefined],
  'reject-repos': [undefined],
};

/** Only these `forge job` subcommands run in the office session: it reads, decides and notes, nothing more. */
export const OFFICE_JOB_COMMANDS: readonly string[] = ['assist', 'human', 'set', 'note', 'handoff', 'show', 'get', 'list', 'step'];

/** The longest hand-off reason kept, after safeText. */
const HANDOFF_REASON_MAX = 200;

/** The reason as `forge job handoff` stores it: control characters and backticks removed, trimmed, at most 200 characters. */
export const cleanHandoffReason = (reason: unknown): string => (typeof reason === 'string' ? safeText(reason, HANDOFF_REASON_MAX).trim() : '');

const isHandoffClass = (c: unknown): c is HandoffClass => (HANDOFF_CLASSES as readonly unknown[]).includes(c);

/**
 * The Foreman hand-off standing at the job's current park, derived from events (job.json has no field
 * for it): the latest `foreman-handoff` for the gate class the job waits on, logged after its last
 * transition, with no `human` event (any actor or action) after it. Null when the job isn't waiting
 * on a Foreman gate, was never handed off there, parked again since or was decided since, or when the
 * event's class or reason doesn't validate (events.jsonl is appendable, so it is checked on read too).
 */
export function foremanHandoff(job: Pick<Job, 'state' | 'waitingOn' | 'reason' | 'repos'>, events: JobEvent[]): ForemanHandoff | null {
  const gate = gateClass(job, events);
  if (!gate) return null;
  const park = events.findLastIndex((e) => e.type === 'transition');
  const at = events.findLastIndex((e, i) => i > park && e.type === 'foreman-handoff' && e.gate === gate);
  if (at < 0 || events.some((e, i) => i > at && e.type === 'human')) return null;
  const e = events[at];
  const reason = cleanHandoffReason(e.reason);
  if (!isHandoffClass(e.class) || !reason || typeof e.ts !== 'string') return null;
  return { gate, class: e.class, reason, at: e.ts };
}

/** foremanHandoff with the job's events read from disk, only for a waiting job. */
export function foremanHandoffFor(root: string, job: Pick<Job, 'id' | 'state' | 'waitingOn' | 'reason' | 'repos'>): ForemanHandoff | null {
  return job.state === 'waiting' ? foremanHandoff(job, readEvents(root, job.id)) : null;
}

/**
 * In the office, `forge job set` only carries out a foreman decision: the job still waits, its latest
 * `human` event is the foreman's and came after the job parked, and the change is that action's
 * `--state running` (with its stage) and nothing else. So a misled foreman or assistant can't move a job
 * off a gate the CLI refused it, or that a human owns. Throws ForgeError (exit 1) before any write.
 */
function checkOfficeSet(
  job: Pick<Job, 'id' | 'state'>,
  events: JobEvent[],
  change: { stage?: unknown; state?: unknown; waitingOn?: unknown; reason?: unknown; fields?: Record<string, unknown> },
): void {
  const refuse = (why: string): never => {
    throw new ForgeError(`the office session may only carry out a recorded foreman decision with forge job set: ${why}`, 1);
  };
  if (change.fields && Object.keys(change.fields).length) refuse('no --field');
  if (change.waitingOn !== undefined || change.reason !== undefined) refuse('no --waiting-on or --reason');
  if (job.state !== 'waiting') refuse(`job ${job.id} is not waiting on a gate`);
  if (change.state !== 'running') refuse('only --state running');
  const decision = [...events].reverse().find((e) => e.type === 'human');
  const park = [...events].reverse().find((e) => e.type === 'transition' && (e.to as { state?: unknown } | null)?.state === 'waiting');
  if (!decision || !isForemanActor(decision) || !park || decision.ts < park.ts) refuse(`no foreman decision recorded for ${job.id}'s current gate`);
  const allowed = SET_AFTER[String(decision!.action)] ?? [];
  const stage = change.stage === undefined ? undefined : String(change.stage);
  if (!allowed.includes(stage)) refuse(`${decision!.action} moves the job to ${allowed.map((x) => x ?? 'its current stage').join(' or ')}, not ${stage ?? 'its current stage'}`);
}

/** checkOfficeSet with the job's events read from disk. */
export function checkOfficeSetFor(root: string, job: Pick<Job, 'id' | 'state'>, change: Parameters<typeof checkOfficeSet>[2]): void {
  checkOfficeSet(job, readEvents(root, job.id), change);
}
