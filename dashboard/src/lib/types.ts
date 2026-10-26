// The forge dash HTTP API, for the dashboard. The /api/* and SSE shapes come from lib/api/types.ts
// with `export type *`, which the build erases, so nothing from lib/ reaches the bundle. This file
// holds only the runtime constants the bundle needs, each pinned to lib/api/constants.ts with
// `satisfies` where it has an engine twin. API_VERSION is pinned with `satisfies` to lib/api/versions.ts:
// after an append to API_CHANGES, set it to the list's new length + 1, or `npm run check:dashboard` fails.
import type {
  ASSISTANTS_SCOPE as ENGINE_ASSISTANTS_SCOPE,
  ASSISTANT_SCOPE_PREFIX as ENGINE_ASSISTANT_SCOPE_PREFIX,
  EFFORTS as ENGINE_EFFORTS,
  INBOX_SCOPE as ENGINE_INBOX_SCOPE,
  JOBS_SCOPE as ENGINE_JOBS_SCOPE,
  MANDATE_ID_SOURCE as ENGINE_MANDATE_ID_SOURCE,
  OFFICE_SCOPE as ENGINE_OFFICE_SCOPE,
  PROJECT_NAME_SOURCE as ENGINE_PROJECT_NAME_SOURCE,
} from '#api/constants.ts';
import type { API_VERSION as ENGINE_API_VERSION } from '#api/versions.ts';

export type * from '#api/types.ts';

/** lib/api/versions.ts API_VERSION: the dashboard refuses data from a newer server. */
export const API_VERSION = 49 satisfies typeof ENGINE_API_VERSION;
/** lib/api/constants.ts PROJECT_NAME_SOURCE: a registered project's name, the `/api/p/<project>/` segment. */
export const PROJECT_NAME_SOURCE = '^[a-z0-9][a-z0-9._-]{0,63}$' satisfies typeof ENGINE_PROJECT_NAME_SOURCE;
/** lib/api/constants.ts MANDATE_ID_SOURCE: a mandate id, which is also its file name (`none` matches but is never one). */
export const MANDATE_ID_SOURCE = '^[a-z0-9][a-z0-9-]{0,39}$' satisfies typeof ENGINE_MANDATE_ID_SOURCE;
/** lib/core/job/requests.ts INBOX_SCOPE: the daemon session for requests without a job. */
export const INBOX_SCOPE = '_inbox' satisfies typeof ENGINE_INBOX_SCOPE;
/** lib/core/job/requests.ts OFFICE_SCOPE: the Foreman's session; its assistant foremen decide gate requests. */
export const OFFICE_SCOPE = '_office' satisfies typeof ENGINE_OFFICE_SCOPE;
/** lib/api/constants.ts ASSISTANTS_SCOPE: the request group of gates, never a session. */
export const ASSISTANTS_SCOPE = '_assistants' satisfies typeof ENGINE_ASSISTANTS_SCOPE;
/** lib/api/constants.ts ASSISTANT_SCOPE_PREFIX: an assistant foreman session is this prefix and its number. */
export const ASSISTANT_SCOPE_PREFIX = '_assistant-' satisfies typeof ENGINE_ASSISTANT_SCOPE_PREFIX;

/** lib/core/job/requests.ts isAssistantScope: `_assistant-1` … `_assistant-16`. */
export function isAssistantScope(s: unknown): s is string {
  return typeof s === 'string' && /^_assistant-([1-9]|1[0-6])$/.test(s);
}

/** lib/core/job/requests.ts sharedScope: not a job's scope (the inbox, the office, the gate group or an assistant foreman). */
export function sharedScope(s: unknown): boolean {
  return s === INBOX_SCOPE || s === OFFICE_SCOPE || s === ASSISTANTS_SCOPE || isAssistantScope(s);
}

/** An assistant foreman scope's number, for its label. */
export function assistantNumber(scope: string): number {
  return Number(scope.slice(ASSISTANT_SCOPE_PREFIX.length));
}
/** lib/api/constants.ts JOBS_SCOPE: POST /api/daemon/mode's scope for the job sessions' default. */
export const JOBS_SCOPE = '_jobs' satisfies typeof ENGINE_JOBS_SCOPE;

/** lib/core/job/schema.ts EFFORTS: reasoning effort levels, lowest first. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies typeof ENGINE_EFFORTS;
