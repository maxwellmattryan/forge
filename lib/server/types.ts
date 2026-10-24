// The server's shapes outside /api, type-only: startServer's options and result, the per-server context
// every route gets, the route table's rows, and what the onRequest hook reports.
import type http from 'node:http';
import type { DaemonPool } from '#office/pool.ts';
import type { Drive } from '#office/driver.ts';
import type { GhRunner, GitHubTarget } from '#integrations/github/preview.ts';
import type { GitHub } from '#integrations/github/types.ts';
import type { VersionInfo } from '#engine/ops/types.ts';
import type {
  BacklogResponse,
  DaemonPoolState,
  EnvironmentsResponse,
  GitHubPreviewResponse,
  JobEnvironmentResponse,
  LoadedJob,
  RepoBudgetStatus,
} from '#core/types.ts';

/** startServer's options. `distDir` is a test seam like `sseMaxAgeMs`. */
export interface ServerOptions {
  port?: number;
  host?: string;
  daemon?: import('#office/modes.ts').PoolOptions;
  sseMaxAgeMs?: number;
  ssePingMs?: number;
  distDir?: string;
  /**
   * Set only by `forge dash --dev` (what `npm run dev` runs): serve the watching dev build and leave
   * the daemon off until Start. No config key or /api route reaches it.
   */
  dev?: boolean;
  /** Test seam: what runs gh for GitHub previews. */
  ghRun?: GhRunner;
  /** Test seam: the GitHub adapter the merge route uses; ghGitHub by default. */
  github?: GitHub;
  /** Test seam: Claude Code's projects dir (claudeProjectsDir() by default). */
  projectsDir?: string;
  /**
   * Called once per request when its response finishes or closes early. Only `forge dash`'s activity
   * log sets it (lib/cli/activity.ts); it observes requests and never changes a response.
   */
  onRequest?: (r: RequestInfo) => void;
}

/** A listening dashboard server: what startServer resolves to. */
export interface RunningServer {
  server: http.Server;
  url: string;
  pool: DaemonPool;
  close: () => Promise<void>;
}

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

/**
 * One startServer call's state, built by createContext in lib/server/start.ts and handed to every
 * route. `pool`, `ping`, `backlogCache`, `budgetCache` and `envsCache` change while the server runs,
 * so handlers read and write them as `ctx.<field>`, never through a destructured copy.
 */
export interface ServerCtx {
  root: string;
  opts: ServerOptions;
  token: string;
  distDir: string;
  notBuilt: string;
  previewGitHub: (t: GitHubTarget) => Promise<GitHubPreviewResponse>;
  /** The GitHub adapter POST /api/jobs/:id/merge merges through. */
  github: GitHub;
  projects: string;
  provenance: VersionInfo;
  clients: Map<http.ServerResponse, string>;
  pool: DaemonPool | null;
  ping: NodeJS.Timeout | null;
  backlogCache: { at: number; data: BacklogResponse } | null;
  budgetCache: { at: number; data: RepoBudgetStatus } | null;
  envMemo: Map<string, { at: number; p: Promise<JobEnvironmentResponse> }>;
  envsCache: { at: number; p: Promise<EnvironmentsResponse> } | null;
  poolState: () => DaemonPoolState;
  /** Who drives a job, asked of the pool session whose scope is that job (lib/office/driver.ts whoDrives). */
  drive: (job: Pick<LoadedJob, 'id' | 'lease'>) => Drive;
  budget: () => RepoBudgetStatus;
}

/** A check the route table runs before a GET's handler: lib/server/http.ts holds each one. */
export type Guard = 'read' | 'token' | 'queryToken';

/** What a route matched: the request URL, and a RegExp path's capture groups ([] for a string path). */
export interface RouteMatch {
  url: URL;
  params: string[];
}

/** A route's handler: it runs only once the route's guards have passed. */
export type Handler = (ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch) => void | Promise<void>;

/** One row of the route table. A POST row takes no `guards`: dispatch always runs guardPost for it. */
export type Route =
  | { method: 'GET'; path: string | RegExp; guards?: readonly Guard[]; handler: Handler }
  | { method: 'POST'; path: string | RegExp; guards?: never; handler: Handler };
