// A mandate's merge queue: within each overlap group of its open PRs, the order they should land in (dependencies,
// then ready ones, then the most input + output tokens spent), and the wait step PR20 parks a lower-ranked PR in
// while Forge merges, which forge sync releases once the PR ahead merges or stops being ready, as it does dependency
// waits (deps.ts). The ranking is pure; the loader reads only job state, events and cached overlap reports, and every
// reason is fixed text around entry job ids and integers, so no report or tracker text reaches the output. Only ever
// a delay in front of a merge Forge makes: mergePr's own checks still decide whether anything merges.
import { autoMerge } from '#core/config/load.ts';
import { enqueue, listRequests } from '#core/job/requests.ts';
import { leaseStatus, listJobs, loadJob, readEvents } from '#core/job/store.ts';
import { isMap } from '#core/shape.ts';
import type { Config, Job, JobEvent, JobUsage, LoadedJob, MergeQueue, MergeQueueEntry } from '#core/types.ts';
import type { GitHub } from '#integrations/github/types.ts';
import { decisionEligible, lastDecision } from '../../pr/eligible.ts';
import { continueMerge } from '../../pr/merge.ts';
import { overlap, readOverlapReport } from '../../project/overlap.ts';
import { moveJob } from './apply.ts';

/** One open root PR before ranking: what the rules read. */
export interface QueueCandidate {
  job: string;
  pr: number;
  tokens: number;
  ready: boolean;
  openedAt: string | null;
  issue: number | null;
  dependsOn: string[];
}

export interface RankInput {
  entries: QueueCandidate[];
  /** Pairs of job ids an overlap report links; a pair naming an id outside `entries` is ignored. */
  links: [string, string][];
  /** The entries whose own overlap report could be read. */
  checked: string[];
  hold: boolean;
}

const MERGE_NOW_REASON = 'overlaps no other open PR of this mandate';
const MERGE_EVENTS = new Set(['pr-merged', 'pr-auto-merge', 'pr-merge-deferred', 'pr-merge-refused', 'pr-merge-failed']);
const STOPPED = new Set(['pr-merge-refused', 'pr-merge-failed']);

/** A count as a plain decimal integer: a missing, negative or non-finite value is 0, and nothing prints in exponent form. */
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), Number.MAX_SAFE_INTEGER) : 0);

/** The work a job spent: Σ job.usage.byRole of input + output. Cache reads and writes are left out; tokens, never dollars. */
export function workTokens(usage: JobUsage | null | undefined): number {
  const byRole = isMap(usage) && isMap(usage.byRole) ? usage.byRole : {};
  let sum = 0;
  for (const bucket of Object.values(byRole)) if (isMap(bucket)) sum += count(bucket.input) + count(bucket.output);
  return Math.min(sum, Number.MAX_SAFE_INTEGER);
}

/**
 * Whether a job's PR is ready to merge now, the one predicate that ranks entries and decides the hold: stage pr;
 * running, or waiting on pr-review or overlap; PR open and not a draft; checks passing or none; no changes requested;
 * an eligible recorded decision; and no refused or failed merge as the latest merge event since the last push.
 * Missing state reads as not ready.
 */
export function queueReady(job: Pick<Job, 'stage' | 'state' | 'waitingOn' | 'pr'>, events: JobEvent[]): boolean {
  if (job.stage !== 'pr') return false;
  if (!(job.state === 'running' || (job.state === 'waiting' && (job.waitingOn === 'pr-review' || job.waitingOn === 'overlap')))) return false;
  const pr = job.pr;
  if (!pr || pr.state !== 'OPEN' || pr.isDraft !== false) return false;
  const checks = pr.checks?.state;
  if (checks !== 'passing' && checks !== 'none') return false;
  if (pr.changesRequested !== undefined && pr.changesRequested !== 0) return false;
  if (!decisionEligible(lastDecision(events))) return false;
  const pushed = events.findLastIndex((e) => e.type === 'pr-opened' || e.type === 'pr-updated');
  const last = events.slice(pushed + 1).findLast((e) => MERGE_EVENTS.has(e.type));
  return !(last && STOPPED.has(last.type));
}

const openedMs = (at: string | null): number => {
  const t = at === null ? NaN : Date.parse(at);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
};

type Rule = 'ready' | 'tokens' | 'age' | 'issue' | 'id';

/** Rules 2–6 on two entries: which comes first, and the rule that told them apart. */
function compare(a: QueueCandidate, b: QueueCandidate): { first: QueueCandidate; rule: Rule } {
  if (a.ready !== b.ready) return { first: a.ready ? a : b, rule: 'ready' };
  if (a.tokens !== b.tokens) return { first: a.tokens > b.tokens ? a : b, rule: 'tokens' };
  const ta = openedMs(a.openedAt);
  const tb = openedMs(b.openedAt);
  if (ta !== tb) return { first: ta < tb ? a : b, rule: 'age' };
  const ia = a.issue ?? Number.POSITIVE_INFINITY;
  const ib = b.issue ?? Number.POSITIVE_INFINITY;
  if (ia !== ib) return { first: ia < ib ? a : b, rule: 'issue' };
  return { first: a.job < b.job ? a : b, rule: 'id' };
}

/** Why `a` sits above `b`: fixed text around their ids and integers. */
function pairText(a: QueueCandidate, b: QueueCandidate, rule: Rule | 'dependency'): string {
  switch (rule) {
    case 'dependency':
      return `${b.job} depends on ${a.job}`;
    case 'ready':
      return `${a.job} is ready to merge and ${b.job} is not`;
    case 'tokens':
      return `${a.job} spent ${a.tokens} input+output tokens, ${b.job} ${b.tokens}`;
    case 'age':
      return `same tokens (${a.tokens}); ${a.job}'s PR is older`;
    case 'issue':
      return `same tokens (${a.tokens}) and PR age; ${a.job} has the lower issue number`;
    case 'id':
      return `same tokens (${a.tokens}), PR age and issue; ${a.job} sorts first by job id`;
  }
}

/**
 * One group's order: a topological sort on its in-group dependencies, taking from the free entries (every in-group
 * dependency placed) the one rules 2–6 put first; in a cycle (none free), the best of the rest. Each entry after
 * the first carries the rule that ordered it against the one above: a dependency when it was not free as that one
 * was taken (only a direct dependency on it can hold it back that far), else the rule compare names.
 */
function orderGroup(group: QueueCandidate[]): { order: QueueCandidate[]; why: string[] } {
  const ids = new Set(group.map((e) => e.job));
  const deps = new Map(group.map((e) => [e.job, new Set(e.dependsOn.filter((d) => d !== e.job && ids.has(d)))]));
  const placed = new Set<string>();
  const order: QueueCandidate[] = [];
  const pools: Set<string>[] = [];
  let rest = [...group];
  while (rest.length) {
    const free = rest.filter((e) => [...deps.get(e.job)!].every((d) => placed.has(d)));
    const pool = free.length ? free : rest;
    const best = pool.reduce((x, y) => compare(x, y).first);
    order.push(best);
    pools.push(new Set(pool.map((e) => e.job)));
    placed.add(best.job);
    rest = rest.filter((e) => e !== best);
  }
  const why = order.map((b, i) => {
    if (i === 0) return '';
    const a = order[i - 1];
    return pairText(a, b, pools[i - 1].has(b.job) ? compare(a, b).rule : 'dependency');
  });
  return { order, why };
}

const byJob = (a: { job: string }, b: { job: string }) => (a.job < b.job ? -1 : a.job > b.job ? 1 : 0);

const entryOf = (c: QueueCandidate, ahead: string | null, reasons: string[]): MergeQueueEntry => ({ job: c.job, pr: c.pr, tokens: c.tokens, ready: c.ready, ahead, reasons });

/**
 * The merge queue from its candidates. Entries linked by a report pair or a dependsOn (either way, in the entries)
 * form overlap groups, transitively; an unlinked entry is merge-now when its own report was read and unchecked when
 * not. Each group entry's `ahead` is the highest-ranked ready entry above it, so a group's first entry is never held.
 * The output never depends on the input's order.
 */
export function rankMergeQueue(input: RankInput): MergeQueue {
  const entries = new Map<string, QueueCandidate>();
  for (const e of [...input.entries].sort(byJob)) if (!entries.has(e.job)) entries.set(e.job, { ...e, tokens: count(e.tokens), dependsOn: Array.isArray(e.dependsOn) ? e.dependsOn : [] });
  const parent = new Map<string, string>([...entries.keys()].map((k) => [k, k]));
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  const linked = new Set<string>();
  const link = (a: string, b: string) => {
    if (a === b || !entries.has(a) || !entries.has(b)) return;
    linked.add(a).add(b);
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const pair of input.links) if (Array.isArray(pair)) link(pair[0], pair[1]);
  for (const e of entries.values()) for (const d of e.dependsOn) link(e.job, d);

  const checked = new Set(input.checked);
  const sets = new Map<string, QueueCandidate[]>();
  const mergeNow: MergeQueueEntry[] = [];
  const unchecked: MergeQueueEntry[] = [];
  for (const e of entries.values()) {
    if (linked.has(e.job)) sets.set(find(e.job), [...(sets.get(find(e.job)) ?? []), e]);
    else if (checked.has(e.job)) mergeNow.push(entryOf(e, null, [MERGE_NOW_REASON]));
    else unchecked.push(entryOf(e, null, [`no overlap report yet: forge overlap ${e.job}`]));
  }
  const groups = [...sets.values()].map((g) => {
    const { order, why } = orderGroup(g);
    return order.map((e, i) => {
      const ahead = order.slice(0, i).find((x) => x.ready)?.job ?? null;
      const reason = i === 0 ? `ahead of ${order[1].job}: ${why[1]}` : `behind ${order[i - 1].job}: ${why[i]}`;
      return entryOf(e, ahead, [reason]);
    });
  });
  groups.sort((a, b) => byJob(a[0], b[0]));
  return { hold: input.hold, groups, mergeNow: mergeNow.sort(byJob), unchecked: unchecked.sort(byJob) };
}
// ---------- the queue from disk ----------

const ENDED = new Set(['done', 'cancelled']);

/** The smallest number after the last `#` in, or the whole of, any of the job's issue refs; null when none has one. */
function issueNumber(job: Pick<Job, 'issues'>): number | null {
  let best: number | null = null;
  for (const i of Array.isArray(job.issues) ? job.issues : []) {
    const ref = isMap(i) && typeof i.ref === 'string' ? i.ref : null;
    if (ref === null) continue;
    const tail = ref.slice(ref.lastIndexOf('#') + 1);
    if (!/^\d{1,15}$/.test(tail)) continue;
    const n = Number(tail);
    if (best === null || n < best) best = n;
  }
  return best;
}

/** A job of `mandate` with an open root PR: one queue entry. */
function isEntry(j: LoadedJob, mandate: string): boolean {
  const n = j.pr?.number;
  return j.mandate === mandate && j.kind !== 'eval' && !ENDED.has(j.state) && j.pr?.state === 'OPEN' && Number.isInteger(n) && (n as number) > 0;
}

/**
 * Mandate `mandate`'s merge queue, from its jobs with an open root PR, their events and their cached overlap
 * reports (readOverlapReport: a report a newer Forge wrote reads as missing). A report links its subject only to
 * a `job` counterpart whose ref is another entry's id; any other ref adds nothing and never reaches the output.
 * `hold` is autoMerge: Forge merges in this order, else it is a suggestion for a person.
 */
export function mergeQueue(root: string, config: Config, mandate: string, jobs: LoadedJob[] = listJobs(root)): MergeQueue {
  const own = jobs.filter((j) => isEntry(j, mandate));
  const ids = new Set(own.map((j) => j.id));
  const links: [string, string][] = [];
  const checked: string[] = [];
  const entries = own.map((j): QueueCandidate => {
    const report = readOverlapReport(root, j.id);
    if (report) {
      checked.push(j.id);
      for (const c of report.counterparts) if (isMap(c) && c.kind === 'job' && typeof c.ref === 'string' && c.ref !== j.id && ids.has(c.ref)) links.push([j.id, c.ref]);
    }
    return {
      job: j.id,
      pr: j.pr!.number,
      tokens: workTokens(j.usage),
      ready: queueReady(j, readEvents(root, j.id)),
      openedAt: typeof j.pr?.openedAt === 'string' ? j.pr.openedAt : null,
      issue: issueNumber(j),
      dependsOn: Array.isArray(j.dependsOn) ? j.dependsOn.filter((d): d is string => typeof d === 'string' && ids.has(d)) : [],
    };
  });
  return rankMergeQueue({ entries, links, checked, hold: autoMerge(config) });
}

/**
 * After forge pr open pushed a mandate job's PR: the overlap check for it, so the queue reads the pushed head. Every
 * error is swallowed: the push already happened, and the hold is a delay, never a safety gate; with no report the
 * job is unchecked and never held, so a failed check adds no hold. `check` is the overlap check, a parameter for tests.
 */
export function refreshQueueReport(root: string, config: Config, github: GitHub, id: string, check: typeof overlap = overlap): void {
  try {
    if (!loadJob(root, id).mandate) return;
    check(root, config, github, { job: id });
  } catch {}
}
// ---------- the hold ----------

const RELEASE_REASON = 'forge sync: the merge queue no longer holds it';
const RESUME_TEXT = 'forge sync: the merge queue no longer holds this job';

/**
 * The ready PR a job's merge waits for, or null: only when Forge merges (autoMerge), for a mandate job at stage pr
 * with an open PR, as its entry's `ahead`. A delay, never a safety gate: PR4's own checks still decide the merge.
 */
export function mergeHold(root: string, config: Config, job: Pick<Job, 'id' | 'mandate' | 'stage' | 'pr'>, jobs?: LoadedJob[]): string | null {
  if (!job.mandate || job.stage !== 'pr' || job.pr?.state !== 'OPEN' || !autoMerge(config)) return null;
  const q = mergeQueue(root, config, job.mandate, jobs);
  return q.groups.flat().find((e) => e.job === job.id)?.ahead ?? null;
}

/** forge sync's continuation of a deferred merge, unless a ready PR ranked ahead in its overlap group lands first. */
export async function continueQueued(root: string, config: Config, github: GitHub, id: string): Promise<Awaited<ReturnType<typeof continueMerge>> | { mergeHeld: string }> {
  let ahead: string | null = null;
  try {
    ahead = mergeHold(root, config, loadJob(root, id));
  } catch {
    // An unreadable queue holds nothing: mergePr's gate still decides.
    ahead = null;
  }
  if (ahead) return { mergeHeld: ahead };
  return continueMerge(root, config, github, id);
}

const heldHere = (j: Pick<Job, 'stage' | 'state' | 'waitingOn' | 'lease'>): boolean => j.stage === 'pr' && j.state === 'waiting' && j.waitingOn === 'overlap' && leaseStatus(j).status !== 'live';

/**
 * forge sync, after its PR loop: every job the merge queue held (stage pr, waiting on overlap, no live lease) whose
 * hold is gone (the PR ahead merged, closed, stopped being ready, or the config no longer auto-merges) goes back to
 * running, decided inside the job lock; under daemon.enabled one `resume` request lets the pool run its step loop.
 */
export async function releaseOverlapWaits(root: string, config: Config): Promise<Record<string, unknown>[]> {
  const jobs = listJobs(root);
  const out: Record<string, unknown>[] = [];
  for (const job of jobs) {
    if (!heldHere(job)) continue;
    let ahead: string | null;
    try {
      ahead = mergeHold(root, config, job, jobs);
    } catch {
      ahead = null;
    }
    if (ahead) continue;
    let released = false;
    await moveJob(root, config, job.id, {
      derive: (j) => {
        if (!heldHere(j)) return null;
        released = true;
        return { state: 'running', waitingOn: null, reason: RELEASE_REASON };
      },
    });
    if (!released) continue;
    // A fixed text, as for sync's other resumes: nothing from a PR or a report reaches a daemon session through it.
    if (config.daemon?.enabled === true && !listRequests(root, { status: 'pending' }).some((r) => r.type === 'resume' && r.job === job.id))
      enqueue(root, config, { type: 'resume', job: job.id, text: RESUME_TEXT, from: 'sync' });
    out.push({ id: job.id, mergeQueueReleased: true });
  }
  return out;
}
