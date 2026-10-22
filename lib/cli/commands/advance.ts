// `forge job advance`: step's executor. It runs the deterministic `run` actions `forge job step`
// returns in-process and hands back only the next action that needs judgement, so a stretch of
// bookkeeping costs the orchestrator one call instead of a turn per command. `step` stays pure.
import { refuseInboxDrive } from '../../office/owner.ts';
import { maybeEnqueueGate } from '../../office/foreman.ts';
import { assertEpoch, leaseStatus, loadJob, logEvent, readEvents, renewLease, setJob } from '../../core/job/store.ts';
import { progressMark } from '../../office/reconcile.ts';
import { loadStepInput, step } from '../../engine/pipeline/step.ts';
import { ForgeError } from '../../core/errors.ts';
import { safeText } from '../../core/text.ts';
import { num, req, str } from './args.ts';
import type { AdvanceRan, CliContext, Dispatch, Dispatched, Job } from '../../core/types.ts';

/**
 * The command groups advance runs: every group lib/engine/pipeline/step/ emits. Anything else (config writes,
 * commands that print for themselves, trackers, a nested advance) stays a separate call.
 */
export const ADVANCE_GROUPS = ['job', 'worktree', 'pr', 'verify', 'verifiers', 'integrate', 'run', 'stop', 'environment', 'eval'] as const;

export function runnableInProcess(argv: readonly string[]): boolean {
  return (ADVANCE_GROUPS as readonly string[]).includes(argv[0]) && !(argv[0] === 'job' && argv[1] === 'advance');
}

/** Result fields worth one line in `ran`; the rest (tails, steps, briefs, file contents) stays in the job dir. */
const SUMMARY_KEYS = ['ok', 'action', 'outcome', 'decision', 'complete', 'round', 'attempt', 'stage', 'state', 'waitingOn', 'created', 'released', 'stopped', 'merged', 'number', 'url', 'path', 'file', 'log', 'error'];
const MAX_SUMMARY = 200;

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** One line of at most 200 characters, so command output written by agents can't flood the orchestrator. */
export function summarize(data: unknown): string {
  let s: string;
  if (data === null || data === undefined) s = 'none';
  else if (typeof data === 'string') s = oneLine(data) || 'none';
  else if (Array.isArray(data)) s = `${data.length} items`;
  else if (typeof data === 'object') {
    const o = data as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of SUMMARY_KEYS) {
      const v = o[k];
      if (typeof v === 'string') parts.push(`${k}=${oneLine(v)}`);
      else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}=${v}`);
    }
    const f = o.failure as { name?: unknown } | string | null | undefined;
    if (typeof f === 'string') parts.push(`failure=${oneLine(f)}`);
    else if (f && typeof f === 'object' && typeof f.name === 'string') parts.push(`failure=${oneLine(f.name)}`);
    if (Array.isArray(o.conflicts)) parts.push(`conflicts=${o.conflicts.length}`);
    s = parts.join(' ') || 'ok';
  } else s = oneLine(String(data));
  if (s.length <= MAX_SUMMARY) return s;
  // Never end on half a surrogate pair.
  let cut = MAX_SUMMARY - 1;
  if (/[\uD800-\uDBFF]/.test(s[cut - 1])) cut--;
  return s.slice(0, cut) + '…';
}

/**
 * Entry checks, then step → run until step returns something other than `run`. Refuses (exit 3)
 * a job `session` does not hold, at entry and again after every command, so an unattended
 * session never drives a job another session took.
 */
export async function advance(ctx: CliContext, id: string, opts: { session: string; max: number; epoch?: number }, dispatch: Dispatch): Promise<Dispatched> {
  const { root, config } = ctx;
  const { session, max, epoch } = opts;
  const job = loadJob(root, id);
  const jobId = job.id;
  refuseInboxDrive(jobId);
  if (epoch !== undefined) assertEpoch(job, epoch, session);
  if (job.lease.driver !== session) {
    const driver = job.lease.driver;
    if (driver && leaseStatus(job).status === 'live') throw new ForgeError(`job ${jobId} is being driven by session ${driver}; advance only drives a job its session holds`, 3);
    throw new ForgeError(`job ${jobId} is not claimed by session ${session}; run: forge job claim ${jobId} --session ${session}`, 3);
  }

  const ran: AdvanceRan[] = [];
  for (;;) {
    // Fenced by epoch alone: G3's release leaves no driver but the same epoch, and a takeover always moves it.
    renewLease(root, jobId, { session, ...(epoch !== undefined ? { fence: { epoch } } : {}) });
    const x = loadStepInput(root, config, jobId);
    const a = step(x);
    if (a.action !== 'run') return { data: { ...a, ran }, exitCode: 0 };
    // A null driver keeps going: G3 releases this session's own claim, then waits.
    if (x.job.lease.driver && x.job.lease.driver !== session) return { data: { ...a, ran, refused: true, owner: x.job.lease.driver }, exitCode: 3 };
    if (ran.length >= max) return { data: { ...a, ran, capped: true }, exitCode: 0 };
    let result = '';
    let error: string | null = null;
    if (!runnableInProcess(a.command)) error = `forge job advance does not run "forge ${a.command[0]}" in-process`;
    else {
      try {
        const r = await dispatch(a.command, ctx);
        if (r.exitCode === 0) result = summarize(r.data);
        else error = summarize(r.data);
      } catch (e) {
        error = summarize(String((e as Error)?.message ?? e).split('\n')[0]);
      }
    }
    ran.push({ rule: a.rule, command: a.command, ok: error === null, ...(error === null ? { result } : { error }), ...(a.tell ? { tell: a.tell } : {}) });
    if (error !== null) return { data: { ...a, failed: true, error, ran, ...(parkRepeatedFailure(ctx, jobId, a.rule, a.command, error) ? { parked: true } : {}) }, exitCode: 1 };
  }
}

/**
 * Logs an `advance-failed` event, and parks the job on escalation when the same rule and command
 * already failed with no pipeline progress since (progressMark in lib/office/reconcile.ts): a session that stopped there
 * would leave the job running with nothing to drive it, so the gate hands it to the foreman instead.
 * The running check is made under the job lock: a job a human or another session moved since the
 * events were read is left exactly as it is. `hooks.beforePark` is a test seam, run just before.
 */
export function parkRepeatedFailure(ctx: CliContext, id: string, rule: string, command: readonly string[], error: string, hooks: { beforePark?: () => void } = {}): boolean {
  const { root, config } = ctx;
  const events = readEvents(root, id);
  const mark = progressMark(events);
  const prev = events.findLast((e) => e.type === 'advance-failed');
  logEvent(root, id, 'advance-failed', { rule, command, error, mark });
  if (!prev || prev.rule !== rule || JSON.stringify(prev.command) !== JSON.stringify(command) || prev.mark !== mark) return false;
  const reason = safeText(`${rule}: forge ${command.slice(0, 2).join(' ')} failed twice: ${error}`).slice(0, 200);
  hooks.beforePark?.();
  // Set inside derive, so `as` keeps the type from narrowing to null.
  let before = null as Pick<Job, 'state' | 'waitingOn'> | null;
  const after = setJob(root, id, {
    derive: (j) => {
      if (j.state !== 'running') return null;
      before = { state: j.state, waitingOn: j.waitingOn };
      return { state: 'waiting', waitingOn: 'escalation', reason };
    },
  });
  if (!before) return false;
  maybeEnqueueGate(root, config, before, after);
  return true;
}

export async function advanceCmd(ctx: CliContext, rest: string[], flags: Record<string, any>, dispatch: Dispatch): Promise<Dispatched> {
  // In this order, and all before loadJob, so a bad call writes nothing.
  const session = req(str(flags.session, '--session'), '--session');
  const epoch = num(flags.epoch, '--epoch', { integer: true });
  const max = num(flags.max, '--max', { integer: true }) ?? 20;
  const id = req(rest[0], 'job id');
  return advance(ctx, id, { session, max, epoch }, dispatch);
}
