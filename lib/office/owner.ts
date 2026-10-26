// The refusals that keep the inbox, office and assistant foreman daemon sessions from driving a job: the inbox only
// routes, the office does not drive jobs and the assistant foremen only decide gates. Who drives a job is lib/office/driver.ts.
import { INBOX_SCOPE, OFFICE_SCOPE, daemonScope, isAssistantScope } from '#core/job/requests.ts';
import { ForgeError } from '#core/errors.ts';

export const OFFICE_REFUSAL = 'the office session does not drive jobs';
export const ASSISTANT_REFUSAL = 'an assistant foreman session decides gates and does not drive jobs';

/**
 * The inbox session only routes, the office drives nothing and the assistant foremen only decide gates:
 * starting a job's worktree or agents there would race the job's own session.
 */
export function refuseInboxDrive(id: string, env: NodeJS.ProcessEnv = process.env): void {
  const scope = daemonScope(env);
  if ('daemon' in scope && scope.daemon && scope.scope === INBOX_SCOPE)
    throw new ForgeError(`the inbox daemon session does not drive jobs; hand ${id} off with \`forge requests add resume --job ${id} --session <your session>\``, 1);
  refuseInOffice(`hand ${id} back with \`forge requests add resume --job ${id}\``, env);
}

/** The inbox, office or an assistant foreman daemon session runs this: the scopes refuseInboxDrive refuses. */
export function inInboxOrOffice(env: NodeJS.ProcessEnv = process.env): boolean {
  const scope = daemonScope(env);
  return 'daemon' in scope && scope.daemon === true && (scope.scope === INBOX_SCOPE || scope.scope === OFFICE_SCOPE || isAssistantScope(scope.scope));
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
 * Refuses in the office and assistant foreman sessions: they claim no job and merge nothing, whatever a
 * request or PR text says. A daemon session whose scope is missing or invalid is refused too: it can't be
 * told apart from them, so it fails closed.
 */
export function refuseInOffice(hint: string, env: NodeJS.ProcessEnv = process.env): void {
  const scope = daemonScope(env);
  if ('problem' in scope) throw new ForgeError(scope.problem, 1);
  if (scope.daemon && scope.scope === OFFICE_SCOPE) throw new ForgeError(`${OFFICE_REFUSAL}; ${hint}`, 1);
  if (scope.daemon && isAssistantScope(scope.scope)) throw new ForgeError(`${ASSISTANT_REFUSAL}; ${hint}`, 1);
}

/**
 * `forge pr merge` in a daemon session, before any gh call: `--now` is a person's override and is
 * refused in every scope, the job's own included (whatever its value); a session merges only its
 * own job; the office and the assistant foremen merge nothing; a broken scope is refused. Outside a daemon, nothing.
 */
export function refuseDaemonMerge(id: string, flags: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void {
  const scope = daemonScope(env);
  if ('problem' in scope) throw new ForgeError(scope.problem, 1);
  if (!scope.daemon) return;
  const never = '; the foreman never merges; foreman.ship merge only feeds the approver and step PR4';
  if (isAssistantScope(scope.scope)) throw new ForgeError(`${ASSISTANT_REFUSAL}${never}`, 1);
  if (flags.now !== undefined) throw new ForgeError("forge pr merge --now is a human's override; a daemon session never passes it. A human runs it in their own terminal", 1);
  if (scope.scope === OFFICE_SCOPE) throw new ForgeError(`${OFFICE_REFUSAL}${never}`, 1);
  if (scope.scope !== id) throw new ForgeError(`a daemon session merges only its own job (${scope.scope}), not ${String(id).slice(0, 200)}`, 1);
}
