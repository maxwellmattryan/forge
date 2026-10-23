// The refusals that keep the inbox and office daemon sessions from driving a job: the inbox only
// routes and the office only decides gates. Who drives a job is lib/office/driver.ts.
import { INBOX_SCOPE, OFFICE_SCOPE, daemonScope } from '#core/job/requests.ts';
import { ForgeError } from '#core/errors.ts';

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
