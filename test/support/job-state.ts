// Builders for a job in a given state, so a test sets one up in a line instead of copying a
// createJob + setJob block or writing state by hand. They write only through the store's public
// functions, and they make no move: they call setJob, not moveJob, so no environment effect, gate
// request or tracker mirror runs (transition hooks fire as for any setJob). A test that needs those
// effects makes the move itself, through moveJob or the CLI.
import { createJob, ensureReviewDir, loadJob, logEvent, setJob, updateJob } from '#core/job/store.ts';
import { loadConfig } from '#core/config/load.ts';
import type { Config, JobChange, LoadedJob, Stage, JobState, Verdict, WaitingOn } from '#core/types.ts';

export interface JobAtOptions {
  /** Default: the repo's config, or defaults() in an uninitialised repo. */
  config?: Config;
  /** Default: `job at <stage>`. */
  title?: string;
  /** Forwarded to createJob: issues, kind, parent, branch… */
  create?: Omit<Parameters<typeof createJob>[2], 'title'>;
  /** Default: 'running', or 'done' at stage 'done'. */
  state?: JobState;
  waitingOn?: WaitingOn | null;
  /** Left as createJob made it (null) when omitted. */
  reason?: string | null;
  /** Written as the owned field `pr` when given. */
  pr?: Record<string, unknown> | null;
  /** setJob fields. */
  fields?: Record<string, unknown>;
}

// Where the pipeline parks each gate. A Record, so a new gate without a row fails typecheck.
const GATE_STAGE: Record<WaitingOn, Stage> = {
  'spec-approval': 'spec', // SP5
  'split-approval': 'plan', // P3
  'issue-link': 'spec', // SP7
  input: 'build', // N1b: any agent stage; build is the common one
  escalation: 'decide', // DC7
  infra: 'decide', // DC8
  conflicts: 'integrate', // IG4
  'rounds-exhausted': 'build', // B2
  'pr-review': 'pr', // PR5
  external: 'build', // no step rule; set by hand
  budget: 'build', // the round-start budget check
  human: 'build', // SC1b/PP1/RP1: any stage
  shelved: 'decide', // forge job shelve: any stage; keeps the one it had
};

const configOf = (root: string, opts: { config?: Config }): Config => opts.config ?? loadConfig(root).config;

/** A new job at `stage`, written in one setJob call: one transition event, unless the state is createJob's own. */
export function jobAt(root: string, stage: Stage, opts: JobAtOptions = {}): LoadedJob {
  const config = configOf(root, opts);
  const { id } = createJob(root, config, { ...opts.create, title: opts.title ?? `job at ${stage}` });
  const change: JobChange = { stage, state: opts.state ?? (stage === 'done' ? 'done' : 'running') };
  if (opts.waitingOn !== undefined) change.waitingOn = opts.waitingOn;
  if (opts.reason !== undefined) change.reason = opts.reason;
  if (opts.pr !== undefined) change.owned = { pr: opts.pr };
  if (opts.fields !== undefined) change.fields = opts.fields;
  if (opts.waitingOn !== 'shelved') return setJob(root, id, change);
  // Only forge job shelve puts a job on the shelf (checkShelfMove): written as it writes one, shelved from queued.
  const reason = 'set aside';
  const shelved = { at: new Date().toISOString(), reason, actor: { login: null, source: 'unknown' }, from: { state: 'queued', waitingOn: null, reason: null } };
  return setJob(root, id, { reason: `shelved: ${reason}`, ...change, owned: { ...change.owned, shelved }, shelf: 'shelve' });
}

/** A new job parked on `gate`, at the stage the pipeline parks it (or `opts.stage`). */
export function parkedAt(root: string, gate: WaitingOn, opts: Omit<JobAtOptions, 'state' | 'waitingOn'> & { stage?: Stage } = {}): LoadedJob {
  const config = configOf(root, opts);
  let fields = opts.fields;
  // B2's condition: the round past maxRounds.
  if (gate === 'rounds-exhausted' && fields?.round === undefined) fields = { ...fields, round: config.pipeline.maxRounds + 1 };
  // ghPr()'s PR, so memoryGitHub pairs with it; opts.pr replaces it whole.
  const pr = gate === 'pr-review' && opts.pr === undefined ? { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' } : opts.pr;
  const { stage, ...rest } = opts;
  return jobAt(root, stage ?? GATE_STAGE[gate], { ...rest, config, fields, pr, state: 'waiting', waitingOn: gate });
}

/**
 * The job in round `round` as `forge job round` leaves it (round field, review dir, round event),
 * and with `verdicts` as `forge job verdicts` then leaves it. No review files, no earlier rounds.
 */
export function withRound(root: string, id: string, round: number, verdicts?: Record<string, Verdict>): LoadedJob {
  setJob(root, id, { fields: { round } });
  ensureReviewDir(root, id, round);
  logEvent(root, id, 'round', { round });
  if (verdicts) {
    const values = Object.values(verdicts);
    const outcome = values.includes('MALFORMED') ? 'MALFORMED' : values.includes('CHANGES') ? 'CHANGES' : 'PASS';
    setJob(root, id, { fields: { [`verdicts.${round}`]: verdicts } });
    logEvent(root, id, 'verdicts', { round, outcome, sha: null });
  }
  return loadJob(root, id);
}

/**
 * A live lease held by `driver`, written straight onto the job (lease is locked, so setJob can't).
 * It adds no run and checks no ownership; use claimJob when a test needs the real claim.
 */
export function withLease(root: string, id: string, driver: string, opts: { epoch?: number; ttlMs?: number } = {}): LoadedJob {
  const now = Date.now();
  const at = new Date(now).toISOString();
  return updateJob(root, id, (j) => {
    j.lease = { driver, epoch: opts.epoch ?? 1, since: at, renewedAt: at, expiresAt: new Date(now + (opts.ttlMs ?? 30 * 60_000)).toISOString() };
  });
}
