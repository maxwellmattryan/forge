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

/**
 * In a daemon session, a missing, empty or invalid scope refuses every command: the per-command
 * checks would otherwise read it as "not the office" and let the session slip past them.
 */
export function refuseBrokenScope(env: NodeJS.ProcessEnv = process.env): void {
  const scope = daemonScope(env);
  if ('problem' in scope) throw new ForgeError(scope.problem, 1);
}

/**
 * Refuses in the office session: it claims no job and merges nothing, whatever a request or PR text
 * says. A daemon session whose scope is missing or invalid is refused too: it can't be told apart
 * from the office, so it fails closed.
 */
export function refuseInOffice(hint: string, env: NodeJS.ProcessEnv = process.env): void {
  const scope = daemonScope(env);
  if ('problem' in scope) throw new ForgeError(scope.problem, 1);
  if (scope.daemon && scope.scope === OFFICE_SCOPE) throw new ForgeError(`${OFFICE_REFUSAL}; ${hint}`, 1);
}

/**
 * `forge pr merge` in a daemon session, before any gh call: `--now` is a person's override and is
 * refused in every scope, the job's own included (whatever its value); a session merges only its
 * own job; the office merges nothing; a broken scope is refused. Outside a daemon, nothing.
 */
export function refuseDaemonMerge(id: string, flags: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void {
  const scope = daemonScope(env);
  if ('problem' in scope) throw new ForgeError(scope.problem, 1);
  if (!scope.daemon) return;
  if (flags.now !== undefined) throw new ForgeError("forge pr merge --now is a human's override; a daemon session never passes it. A human runs it in their own terminal", 1);
  if (scope.scope === OFFICE_SCOPE) throw new ForgeError(`${OFFICE_REFUSAL}; the foreman never merges; foreman.ship merge only feeds the approver and step PR4`, 1);
  if (scope.scope !== id) throw new ForgeError(`a daemon session merges only its own job (${scope.scope}), not ${String(id).slice(0, 200)}`, 1);
}
