// The refusals that keep the inbox session and the office runs' children (scope `_office`) from driving a job:
// the inbox only routes and the office does not drive jobs. Who drives a job is lib/office/driver.ts.
import { INBOX_SCOPE, OFFICE_SCOPE, SCOPE_ENV, daemonScope } from '#core/job/requests.ts';
import { ForgeError } from '#core/errors.ts';
import { oneLineTitle } from '#core/text.ts';

export const OFFICE_REFUSAL = 'the office does not drive jobs';

/**
 * The inbox session only routes and the office drives nothing: starting a job's worktree or agents there
 * would race the job's own session.
 */
export function refuseInboxDrive(id: string, env: NodeJS.ProcessEnv = process.env): void {
  const scope = daemonScope(env);
  if ('daemon' in scope && scope.daemon && scope.scope === INBOX_SCOPE)
    throw new ForgeError(`the inbox daemon session does not drive jobs; hand ${id} off with \`forge requests add resume --job ${id} --session <your session>\``, 1);
  refuseInOffice(`hand ${id} back with \`forge requests add resume --job ${id}\``, env);
}

/** The inbox session or an office run's child runs this: the scopes refuseInboxDrive refuses. */
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
 * A command only an office run (scope `_office`) or a person's own terminal runs (`forge mandate draft prepare|record`,
 * `forge office survey|board|start|resume|note`): every other daemon scope, and a missing or invalid one,
 * is refused (exit 1) before anything is read. `daemon` says whether an office run ran it.
 */
export function refuseOutsideOffice(command: string, env: NodeJS.ProcessEnv = process.env): { daemon: boolean } {
  const s = daemonScope(env);
  if ('problem' in s || (s.daemon && s.scope !== OFFICE_SCOPE)) {
    const scope = 'problem' in s ? oneLineTitle(env[SCOPE_ENV] ?? '').slice(0, 60) || 'unscoped' : s.scope;
    throw new ForgeError(`forge ${command} runs in an office run or a person's own terminal, not the ${scope} session`, 1);
  }
  return { daemon: s.daemon };
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
 * Refuses in an office run (scope `_office`): it claims no job and merges nothing, whatever a request or PR text says.
 * A daemon session whose scope is missing or invalid is refused too: it can't be told apart from it, so it
 * fails closed.
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
  const never = '; the foreman never merges; foreman.ship merge or release only feeds the approver and step PR4';
  if (flags.now !== undefined) throw new ForgeError("forge pr merge --now is a human's override; a daemon session never passes it. A human runs it in their own terminal", 1);
  if (scope.scope === OFFICE_SCOPE) throw new ForgeError(`${OFFICE_REFUSAL}${never}`, 1);
  if (scope.scope !== id) throw new ForgeError(`a daemon session merges only its own job (${scope.scope}), not ${String(id).slice(0, 200)}`, 1);
}
