// When a job's owner is a `forge dash` session that has provably let go, so another session may
// claim the job without --force. Daemon sessions are separate processes: the inbox hands a job to
// that job's session, and a job session's next incarnation has a new uuid. The proofs come from
// the session records (lib/daemon.ts); an owner in no record keeps the time-based rule in claimJob.
// A separate module because lib/daemon.ts imports lib/jobs.ts, which must not import it back.
import { UUID, isOurChild, readInfo, sessionRecords } from './daemon.ts';
import { INBOX_SCOPE, daemonScope } from './requests.ts';
import { ForgeError } from './util.ts';
import { pidAlive } from './worktree.ts';
import type { JobOwner } from './types.ts';

export type YieldReason = 'moved-on' | 'not-running' | 'inbox-handoff';

/** The child a record describes is running: alive, and provably the claude process it recorded. */
const recordedChildLive = (info: any): boolean => Number.isInteger(info.pid) && pidAlive(info.pid) && isOurChild(info, info.pid);

const uuids = (xs: unknown[]): string[] => xs.filter((s): s is string => typeof s === 'string' && UUID.test(s));

/** Ids a record held before its current one: its past list and the id its child was spawned with. */
const pastIds = (info: any): string[] => uuids([...(Array.isArray(info.pastSessionIds) ? info.pastSessionIds : []), info.spawnSessionId]);

/** Every id, current or past, of the inbox session's record. */
export function inboxSessionIds(root: string): string[] {
  const rec = sessionRecords(root).find((r) => r.scope === INBOX_SCOPE);
  if (!rec) return [];
  const info = readInfo(rec.info);
  return [...new Set(uuids([info.sessionId, ...pastIds(info)]))];
}

/**
 * Why `owner` yields `jobId` to the caller, or null when it doesn't. In order: the inbox yields to
 * the job's own daemon session (it never drives a job); a recorded session whose child isn't
 * running holds nothing; a session its record has since replaced has exited.
 */
export function ownerYield(
  root: string,
  jobId: string,
  owner: JobOwner | null | undefined,
  opts: { env?: NodeJS.ProcessEnv; isLive?: (info: any) => boolean } = {},
): YieldReason | null {
  const sid = owner?.session;
  if (typeof sid !== 'string' || !UUID.test(sid)) return null;
  const records = sessionRecords(root).map((r) => ({ scope: r.scope, info: readInfo(r.info) }));
  if (!records.length) return null;
  const scope = daemonScope(opts.env ?? process.env);
  if ('daemon' in scope && scope.daemon && scope.scope === jobId && jobId !== INBOX_SCOPE && inboxSessionIds(root).includes(sid)) return 'inbox-handoff';
  const current = records.filter((r) => r.info.sessionId === sid);
  if (current.length) {
    const isLive = opts.isLive ?? recordedChildLive;
    return current.some((r) => isLive(r.info)) ? null : 'not-running';
  }
  return records.some((r) => pastIds(r.info).includes(sid)) ? 'moved-on' : null;
}

/** The claimJob options every command-layer claim passes. */
export function daemonClaimOpts(root: string, jobId: string, env: NodeJS.ProcessEnv = process.env): { yields: (o: JobOwner) => YieldReason | null } {
  return { yields: (o) => ownerYield(root, jobId, o, { env }) };
}

/** The inbox session only routes: starting a job's worktree or agents there would race the job's own session. */
export function refuseInboxDrive(id: string, env: NodeJS.ProcessEnv = process.env): void {
  const scope = daemonScope(env);
  if ('daemon' in scope && scope.daemon && scope.scope === INBOX_SCOPE)
    throw new ForgeError(`the inbox daemon session does not drive jobs; hand ${id} off with \`forge requests add resume --job ${id} --session <your session>\``, 1);
}
