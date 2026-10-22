// The forge dash HTTP API, for the dashboard. The /api/* and SSE shapes come from lib/api-types.ts
// with `export type *`, which the build erases, so nothing from lib/ reaches the bundle. This file
// holds only the runtime constants the bundle needs, each pinned to lib/constants.ts with
// `satisfies` where it has an engine twin. Bump API_VERSION here and in lib/schema.ts together;
// test/dashboard-lib.test.ts fails if they differ.
import type { EFFORTS as ENGINE_EFFORTS, INBOX_SCOPE as ENGINE_INBOX_SCOPE, OFFICE_SCOPE as ENGINE_OFFICE_SCOPE } from '../../../lib/constants.ts';

export type * from '../../../lib/api-types.ts';

/** lib/schema.ts API_VERSION: the dashboard refuses data from a newer server. */
export const API_VERSION = 35;
/** lib/requests.ts INBOX_SCOPE: the daemon session for requests without a job. */
export const INBOX_SCOPE = '_inbox' satisfies typeof ENGINE_INBOX_SCOPE;
/** lib/requests.ts OFFICE_SCOPE: the foreman's session, which decides gate requests. */
export const OFFICE_SCOPE = '_office' satisfies typeof ENGINE_OFFICE_SCOPE;

/** lib/schema.ts EFFORTS: reasoning effort levels, lowest first. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies typeof ENGINE_EFFORTS;
