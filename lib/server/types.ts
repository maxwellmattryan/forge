// The server's shapes outside /api, type-only: what startServer's onRequest hook reports.

/** One finished (or aborted) dashboard request, as startServer's onRequest hook reports it: lib/cli/activity.ts. */
export interface RequestInfo {
  method: string;
  /** The pathname only: a query string can carry the dashboard token. */
  path: string;
  status: number | 'aborted';
  ms: number;
  /** The response was a server-sent-event stream. */
  sse: boolean;
}
