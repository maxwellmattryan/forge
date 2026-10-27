// The forge dash HTTP API, for the dashboard. The /api/* and SSE shapes come from lib/api/types.ts
// with `export type *`, which the build erases, so nothing from lib/ reaches the bundle. This file
// holds only the runtime constants the bundle needs, each pinned to lib/api/constants.ts with
// `satisfies` where it has an engine twin. API_VERSION is pinned with `satisfies` to lib/api/versions.ts:
// after an append to API_CHANGES, set it to the list's new length + 1, or `npm run check:dashboard` fails.
import type {
  EFFORTS as ENGINE_EFFORTS,
  GATE_RUN_OUTCOMES as ENGINE_GATE_RUN_OUTCOMES,
  INBOX_SCOPE as ENGINE_INBOX_SCOPE,
  OFFICE_GATES as ENGINE_OFFICE_GATES,
  JOBS_SCOPE as ENGINE_JOBS_SCOPE,
  MANDATE_ID_SOURCE as ENGINE_MANDATE_ID_SOURCE,
  MANDATE_ON_UNFINISHABLE as ENGINE_MANDATE_ON_UNFINISHABLE,
  MANDATE_ORDERS as ENGINE_MANDATE_ORDERS,
  MANDATE_UNTIL as ENGINE_MANDATE_UNTIL,
  OFFICE_SCOPE as ENGINE_OFFICE_SCOPE,
  PROJECT_NAME_SOURCE as ENGINE_PROJECT_NAME_SOURCE,
} from '#api/constants.ts';
import type { API_VERSION as ENGINE_API_VERSION } from '#api/versions.ts';

export type * from '#api/types.ts';

/** lib/api/versions.ts API_VERSION: the dashboard refuses data from a newer server. */
export const API_VERSION = 57 satisfies typeof ENGINE_API_VERSION;
/** lib/api/constants.ts PROJECT_NAME_SOURCE: a registered project's name, the `/api/p/<project>/` segment. */
export const PROJECT_NAME_SOURCE = '^[a-z0-9][a-z0-9._-]{0,63}$' satisfies typeof ENGINE_PROJECT_NAME_SOURCE;
/** lib/api/constants.ts MANDATE_ID_SOURCE: a mandate id, which is also its file name (`none` matches but is never one). */
export const MANDATE_ID_SOURCE = '^[a-z0-9][a-z0-9-]{0,39}$' satisfies typeof ENGINE_MANDATE_ID_SOURCE;
/** lib/core/job/requests.ts INBOX_SCOPE: the daemon session for requests without a job. */
export const INBOX_SCOPE = '_inbox' satisfies typeof ENGINE_INBOX_SCOPE;
/** lib/core/job/requests.ts OFFICE_SCOPE: the Foreman's session for draft and direct requests; forge dash's gate runner decides the gates. */
export const OFFICE_SCOPE = '_office' satisfies typeof ENGINE_OFFICE_SCOPE;

/** lib/core/job/requests.ts sharedScope, as far as the dashboard sees sessions: not a job's scope (the inbox or the office). */
export function sharedScope(s: unknown): boolean {
  return s === INBOX_SCOPE || s === OFFICE_SCOPE;
}

/** lib/api/constants.ts OFFICE_GATES: the gate classes the Foreman may decide, each a gate run's gate. */
export const OFFICE_GATES = ['spec-approval', 'split-approval', 'escalation', 'rounds-exhausted', 'conflicts', 'pr-feedback', 'repo-proposal', 'release', 'milestone-approval'] as const satisfies typeof ENGINE_OFFICE_GATES;
/** lib/api/constants.ts GATE_RUN_OUTCOMES: how a gate run ended. */
export const GATE_RUN_OUTCOMES = ['approve', 'revise', 'rework', 'no-action', 'escalated', 'reserved', 'refused', 'stale', 'requeued', 'failed'] as const satisfies typeof ENGINE_GATE_RUN_OUTCOMES;
/** lib/api/constants.ts JOBS_SCOPE: POST /api/daemon/mode's scope for the job sessions' default. */
export const JOBS_SCOPE = '_jobs' satisfies typeof ENGINE_JOBS_SCOPE;

/** lib/api/constants.ts MANDATE_UNTIL, MANDATE_ORDERS and MANDATE_ON_UNFINISHABLE: the mandate editor's choices. */
export const MANDATE_UNTIL = ['merge-ready', 'merged'] as const satisfies typeof ENGINE_MANDATE_UNTIL;
export const MANDATE_ORDERS = ['graph', 'priority', 'listed'] as const satisfies typeof ENGINE_MANDATE_ORDERS;
export const MANDATE_ON_UNFINISHABLE = ['park', 'cancel'] as const satisfies typeof ENGINE_MANDATE_ON_UNFINISHABLE;

/** lib/core/job/schema.ts EFFORTS: reasoning effort levels, lowest first. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies typeof ENGINE_EFFORTS;
