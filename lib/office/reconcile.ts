// The reconciler: the one place that asks "is this running job being driven?" and acts when it is
// not. Level-triggered: it looks at what is (job states, leases, requests, and in `forge dash` its
// sessions), never at which event happened, so a missed event can't strand a job. Its only memory,
// one record per job it resumed, lives on disk, so a restarted dashboard keeps its count. A job it
// finds undriven gets one resume; undriven again with no progress since, it is parked on escalation
// for the foreman or a person. docs/ARCHITECTURE.md "Reconciler".
import path from 'node:path';
import { maybeEnqueueGate } from './foreman.ts';
import { leaseStatus, listJobs, loadJob, logEvent, readEvents, requeueOrphanedRequests, setJob } from '../core/job/store.ts';
import { paths } from '../core/paths.ts';
import { enqueue, listRequests, requestScope, validJobId } from '../core/job/requests.ts';
import { readJson, writeJsonAtomic } from '../core/os/fs.ts';
import { lockHeld, withLock } from '../core/os/lock.ts';
import type { Config, ForgeRequest, Job, JobEvent, LoadedJob } from '../core/types.ts';

/** Event types that mean the pipeline moved; renewals, syncs, notes and failures don't count. */
const PROGRESS_EVENTS: ReadonlySet<string> = new Set(['transition', 'round', 'verify', 'agent-start', 'agent-end', 'human', 'integrated', 'integration-review', 'pr-opened', 'pr-updated', 'pr-head-pulled', 'verdicts']);

/** The newest progress event's time, or null: what a later pass or failure compares against. */
export function progressMark(events: Pick<JobEvent, 'type' | 'ts'>[]): string | null {
  return events.findLast((e) => PROGRESS_EVENTS.has(e.type))?.ts ?? null;
}

/** How often a wanted pool reconciles. */
export const RECONCILE_MS = 30_000;
/**
 * How long a job's own session may sit idle with no background task while its lease says it drives
 * the job: long enough for a notification claude has queued to start its turn, short against the
 * stalls this ends (a missed agent end, a turn that stopped with nothing queued).
 */
export const IDLE_UNDRIVEN_MS = 60_000;
/** The resume the reconciler queues. Fixed: nothing from job.json or a request reaches a prompt. */
export const RECONCILE_TEXT =
  'The reconciler found this job running with nothing driving it. Record any agent that finished with `forge job agent <id> end` (one with no report ends with --status lost), then run the step loop from where it stands; if it cannot go on, park it on a gate rather than stopping.';

/** The lock a `forge dash` holds while its pool is started; `forge sync` probes it and leaves reconciling to the dash. */
export const daemonLockDir = (root: string): string => path.join(paths(root).locks, 'daemon');

/** Whether a live `forge dash` holds the daemon lock, read without taking it, so a probe never refuses a dash starting that instant. */
export const dashRunning = (root: string): boolean => lockHeld(daemonLockDir(root));

/** What `forge dash` knows about a job's own session: every id it ran under, its status, claude's background task count (-1 until reported) and since when it is idle. */
export type SessionFacts = { ids: string[]; status: string; background: number; idleSince: string | null };

/**
 * Whether a running job is driven. A request routed to it (pending or in progress), its own session
 * busy or stopping, or a live lease each drive it, except a lease whose driver is the job's own
 * session while that session is off, or has sat idle with no background task for IDLE_UNDRIVEN_MS:
 * that driver will not act again unasked. A claude that has not reported its background tasks
 * counts as busy with them only while job.json marks an agent running. Pure.
 */
export function judge(job: Pick<Job, 'lease' | 'agents'>, routed: readonly Pick<ForgeRequest, 'status'>[], facts: SessionFacts | null | undefined, at: number): { driven: boolean; why: string } {
  if (routed.some((r) => r.status === 'pending' || r.status === 'in-progress')) return { driven: true, why: 'request' };
  if (facts && (facts.status === 'busy' || facts.status === 'stopping')) return { driven: true, why: 'session busy' };
  const lease = leaseStatus(job, at);
  if (lease.status !== 'live') return { driven: false, why: lease.status === 'expired' ? 'lease expired' : 'no driver' };
  const own = Boolean(facts && job.lease.driver && facts.ids.includes(job.lease.driver));
  if (own && facts!.status === 'off') return { driven: false, why: 'its session is off' };
  const idle = facts?.idleSince ? Date.parse(facts.idleSince) : NaN;
  if (own && facts!.status === 'idle' && Number.isFinite(idle) && at - idle >= IDLE_UNDRIVEN_MS) {
    const agentsRunning = Object.values(job.agents ?? {}).some((a) => a?.status === 'running');
    if (facts!.background === 0 || (facts!.background < 0 && !agentsRunning)) return { driven: false, why: 'its session is idle' };
  }
  return { driven: true, why: 'lease' };
}

/** One job's memory: the progress mark when the reconciler resumed it, and that resume. */
interface Record_ {
  mark: string | null;
  stage: string;
  resumedAt: string;
  request: string;
}

interface Memory {
  v: 1;
  jobs: Record<string, Record_>;
}

const memoryFile = (root: string): string => path.join(paths(root).runtime, 'reconcile.json');
const memoryLock = (root: string): string => path.join(paths(root).locks, 'reconcile');

/** The memory file, tolerantly: it sits in the runtime dir sessions can write, so anything malformed is dropped. */
function readMemory(root: string): Memory {
  let raw: any;
  try {
    raw = readJson(memoryFile(root), null);
  } catch {
    raw = null;
  }
  const jobs: Record<string, Record_> = {};
  if (raw && typeof raw === 'object' && raw.v === 1 && raw.jobs && typeof raw.jobs === 'object') {
    for (const [id, r] of Object.entries(raw.jobs as Record<string, any>)) {
      if (!validJobId(id) || !r || typeof r !== 'object') continue;
      if (!(r.mark === null || typeof r.mark === 'string') || typeof r.stage !== 'string' || typeof r.resumedAt !== 'string' || typeof r.request !== 'string') continue;
      jobs[id] = { mark: r.mark, stage: r.stage, resumedAt: r.resumedAt, request: r.request };
    }
  }
  return { v: 1, jobs };
}

export interface ReconcileResult {
  resumed: string[];
  escalated: string[];
  requeued: string[];
}

/**
 * One pass: requeue orphaned requests, then judge every running job (or only `only`). An undriven
 * job is resumed the first time and whenever it made progress since the last resume, and escalated
 * when it is undriven again at the same mark with nothing routed to it. Jobs in any other state
 * lose their record. `facts` are the dash's sessions by job id; `exited`, session ids just seen
 * exiting (their claimed requests go back to pending); `busy`, the ids of the dash's sessions
 * mid-turn, whose claims stay however old.
 */
export function reconcile(
  root: string,
  config: Config,
  opts: { at?: number; facts?: Map<string, SessionFacts>; only?: string; exited?: string[]; busy?: readonly string[] } = {},
): ReconcileResult {
  const at = opts.at ?? Date.now();
  const out: ReconcileResult = { resumed: [], escalated: [], requeued: [] };
  out.requeued = requeueOrphanedRequests(root, { at, exited: opts.exited, busy: opts.busy }).requeued.map((r) => r.id);
  withLock(memoryLock(root), () => {
    const mem = readMemory(root);
    let jobs: LoadedJob[];
    if (opts.only !== undefined) {
      try {
        jobs = [loadJob(root, opts.only)];
      } catch {
        jobs = [];
        delete mem.jobs[opts.only];
      }
    } else {
      jobs = listJobs(root);
      const ids = new Set(jobs.map((j) => j.id));
      for (const id of Object.keys(mem.jobs)) if (!ids.has(id)) delete mem.jobs[id];
    }
    const open = listRequests(root).filter((r) => r.status === 'pending' || r.status === 'in-progress');
    for (const job of jobs) {
      if (job.state !== 'running') {
        delete mem.jobs[job.id];
        continue;
      }
      const routed = open.filter((r) => requestScope(root, r) === job.id);
      if (judge(job, routed, opts.facts?.get(job.id), at).driven) continue;
      const mark = progressMark(readEvents(root, job.id));
      const rec = mem.jobs[job.id];
      if (!rec || rec.mark !== mark) {
        const r = enqueue(root, null, { type: 'resume', job: job.id, text: RECONCILE_TEXT, from: 'reconciler' });
        mem.jobs[job.id] = { mark, stage: job.stage, resumedAt: new Date(at).toISOString(), request: r.id };
        logEvent(root, job.id, 'reconcile', { action: 'resume', stage: job.stage });
        out.resumed.push(job.id);
        continue;
      }
      delete mem.jobs[job.id];
      const reason = `undriven at ${job.stage}: resumed once with no progress since`;
      // Decided again under the job lock: a job that parked or moved meanwhile is left alone.
      const after = setJob(root, job.id, { derive: (j) => (j.state === 'running' && j.stage === job.stage ? { state: 'waiting', waitingOn: 'escalation', reason } : null) });
      if (after.state !== 'waiting' || after.reason !== reason) continue;
      logEvent(root, job.id, 'reconcile', { action: 'escalate', stage: job.stage });
      maybeEnqueueGate(root, config, job, after);
      out.escalated.push(job.id);
    }
    writeJsonAtomic(memoryFile(root), mem);
  });
  return out;
}
