// What the daemon's session records say about who drives what: the ids `forge dash` sessions ran
// under (the supervisor expires their leases when they exit, lib/office/session/lifecycle.ts and lib/office/pool.ts),
// and the refusals that keep the inbox and office sessions from driving a job.
// A separate module because lib/office/session/lifecycle.ts imports lib/core/job/store.ts, which must not import it back.
import { UUID, readInfo, sessionRecords } from '#core/job/session-files.ts';
import { INBOX_SCOPE, OFFICE_SCOPE, daemonScope } from '#core/job/requests.ts';
import { ForgeError } from '#core/errors.ts';

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

/** Every id, current or past, of every session record: the sessions `forge dash` ran, as opposed to interactive ones. */
export function daemonSessionIds(root: string): string[] {
  const ids = sessionRecords(root).flatMap((r) => {
    const info = readInfo(r.info);
    return uuids([info.sessionId, ...pastIds(info)]);
  });
  return [...new Set(ids)];
}

export const OFFICE_REFUSAL = 'the office session decides gates and does not drive jobs';

/**
 * The inbox session only routes and the office only decides gates: starting a job's worktree or
 * agents there would race the job's own session.
 */
export function refuseInboxDrive(id: string, env: NodeJS.ProcessEnv = process.env): void {
  const scope = daemonScope(env);
  if ('daemon' in scope && scope.daemon && scope.scope === INBOX_SCOPE)
    throw new ForgeError(`the inbox daemon session does not drive jobs; hand ${id} off with \`forge requests add resume --job ${id} --session <your session>\``, 1);
  refuseInOffice(`hand ${id} back with \`forge requests add resume --job ${id}\``, env);
}

/** The inbox or office daemon session runs this: the scopes refuseInboxDrive refuses. */
export function inInboxOrOffice(env: NodeJS.ProcessEnv = process.env): boolean {
  const scope = daemonScope(env);
  return 'daemon' in scope && scope.daemon === true && (scope.scope === INBOX_SCOPE || scope.scope === OFFICE_SCOPE);
}

/** refuseInboxDrive for a command that acts for every job rather than one (`forge backing down --shared`). */
export function refuseInboxOrOffice(hint: string, env: NodeJS.ProcessEnv = process.env): void {
  const scope = daemonScope(env);
  if ('daemon' in scope && scope.daemon && scope.scope === INBOX_SCOPE) throw new ForgeError(`the inbox daemon session does not drive jobs; ${hint}`, 1);
  refuseInOffice(hint, env);
}

/** Refuses in the office session: it claims no job and merges nothing, whatever a request or PR text says. */
export function refuseInOffice(hint: string, env: NodeJS.ProcessEnv = process.env): void {
  const scope = daemonScope(env);
  if ('daemon' in scope && scope.daemon && scope.scope === OFFICE_SCOPE) throw new ForgeError(`${OFFICE_REFUSAL}; ${hint}`, 1);
}
