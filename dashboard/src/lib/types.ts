// The forge dash HTTP API, for the dashboard. The /api/* and SSE shapes come from lib/api/types.ts
// with `export type *`, which the build erases, so nothing from lib/ reaches the bundle. This file
// holds only the runtime constants the bundle needs, each pinned to lib/api/constants.ts with
// `satisfies` where it has an engine twin. API_VERSION is pinned with `satisfies` to lib/api/versions.ts:
// after an append to API_CHANGES, set it to the list's new length + 1, or `npm run check:dashboard` fails.
import type { EFFORTS as ENGINE_EFFORTS, INBOX_SCOPE as ENGINE_INBOX_SCOPE, JOBS_SCOPE as ENGINE_JOBS_SCOPE, OFFICE_SCOPE as ENGINE_OFFICE_SCOPE } from '#api/constants.ts';
import type { API_VERSION as ENGINE_API_VERSION } from '#api/versions.ts';

export type * from '#api/types.ts';

/** lib/api/versions.ts API_VERSION: the dashboard refuses data from a newer server. */
export const API_VERSION = 42 satisfies typeof ENGINE_API_VERSION;
/** lib/core/job/requests.ts INBOX_SCOPE: the daemon session for requests without a job. */
export const INBOX_SCOPE = '_inbox' satisfies typeof ENGINE_INBOX_SCOPE;
/** lib/core/job/requests.ts OFFICE_SCOPE: the foreman's session, which decides gate requests. */
export const OFFICE_SCOPE = '_office' satisfies typeof ENGINE_OFFICE_SCOPE;
/** lib/api/constants.ts JOBS_SCOPE: POST /api/daemon/mode's scope for the job sessions' default. */
export const JOBS_SCOPE = '_jobs' satisfies typeof ENGINE_JOBS_SCOPE;

/** lib/core/job/schema.ts EFFORTS: reasoning effort levels, lowest first. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies typeof ENGINE_EFFORTS;
