// The server's shapes outside /api, type-only: startServer's options and result, the machine context
// and the per-project context routes get, a loaded project entry and its boot pass, the route tables'
// rows, and what the onRequest hook reports.
import type http from 'node:http';
import type { DaemonPool, createPool } from '#office/pool.ts';
import type { Drive } from '#office/driver.ts';
import type { MachineSlots } from '#office/slots.ts';
import type { GhRunner, GitHubTarget } from '#integrations/github/preview.ts';
import type { GitHub } from '#integrations/github/types.ts';
import type { VersionInfo } from '#engine/ops/types.ts';
import type { UptimeProject } from '#engine/project/login-service.ts';
import type { SleepSpawn } from '#integrations/os-service/types.ts';
import type {
  BacklogResponse,
  DaemonPoolState,
  EnvironmentsResponse,
  GitHubPreviewResponse,
  JobEnvironmentResponse,
  LoadedJob,
  ProjectsResponse,
  RepoBudgetStatus,
} from '#core/types.ts';

/** startServer's options. `distDir`, `home` and `refreshMs` are test seams like `sseMaxAgeMs`. */
export interface ServerOptions {
  port?: number;
  host?: string;
  daemon?: import('#office/modes.ts').PoolOptions;
  sseMaxAgeMs?: number;
  ssePingMs?: number;
  distDir?: string;
  /** The machine index directory whose registered projects the server serves; forgeHome() by default. */
  home?: string;
  /** How often the server re-reads the machine index (only when its size or mtime changed); 2000 ms by default. */
  refreshMs?: number;
  /** How often an open /api/projects/events stream recomputes its body; 5000 ms by default. */
  projectsPollMs?: number;
  /**
   * Set only by `forge dash --dev` (what `npm run dev` runs): serve the watching dev build and leave
   * every pool off until Start. No config key or /api route reaches it.
   */
  dev?: boolean;
  /** Test seam: what runs gh for GitHub previews. */
  ghRun?: GhRunner;
  /** Test seam: the GitHub adapter the merge route uses; ghGitHub by default. */
  github?: GitHub;
  /** Test seam: Claude Code's projects dir (claudeProjectsDir() by default). */
  projectsDir?: string;
  /** Test seam: what builds each project's pool (lib/office/pool.ts createPool by default). */
  createPool?: typeof createPool;
  /**
   * Called once per request when its response finishes or closes early. Only `forge dash`'s activity
   * log sets it (lib/cli/activity.ts); it observes requests and never changes a response.
   */
  onRequest?: (r: RequestInfo) => void;
  /**
   * The machine's sleep assertion (lib/server/uptime.ts): set only by a non-dev `forge dash`, with the
   * real helper spawn; without it the server holds nothing.
   */
  keepAwake?: KeepAwakeOptions;
}

/** startKeepAwake's options: the helper's spawn, and test seams for the env (FORGE_KEEP_AWAKE), platform, pid and check interval. */
export interface KeepAwakeOptions {
  spawn: SleepSpawn;
  /** `FORGE_KEEP_AWAKE: never` here turns the assertion off; `{}` by default, never this process's. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The pid the helper waits on; this process's by default. */
  pid?: number;
  intervalMs?: number;
}

/** One project's boot pass (lib/server/uptime.ts resumeProject): what it found in flight. */
export type ProjectBoot = UptimeProject;

/** One loaded project: its name and root, the context its routes get, and its pool. */
export interface ProjectEntry {
  name: string;
  root: string;
  ctx: ServerCtx;
  pool: DaemonPool;
}

/** Called for each loaded entry; what it returns runs when that entry closes. */
export type ProjectListener = (entry: ProjectEntry) => void | (() => void);

/** A listening machine dashboard: what startServer resolves to. */
export interface RunningServer {
  server: http.Server;
  url: string;
  /** A loaded project by name (no refresh), or null. */
  entry(name: string): ProjectEntry | null;
  entries(): ProjectEntry[];
  /** `fn` for every loaded entry now and each one loaded later; the function returned unsubscribes. */
  onProject(fn: ProjectListener): () => void;
  /** Re-reads the machine index now. */
  refresh(): void;
  /** The boot passes of the projects whose pools booted as the server started, once they settle; never rejects. */
  booted(): Promise<ProjectBoot[]>;
  close: () => Promise<void>;
  /** Last resort from a process `exit` handler: every pool's children and the sleep helper, synchronously. */
  killSync(): void;
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

/** The loaded projects (lib/server/machine.ts createEntries). */
export interface Entries {
  /** `name` when it is a valid project name and registered, after one refresh on a miss; else null. */
  resolve(name: string): ProjectEntry | null;
  get(name: string): ProjectEntry | null;
  list(): ProjectEntry[];
  /** Re-reads the index: `force` skips the throttle and the size-and-mtime check. */
  refresh(force?: boolean): void;
  summaries(): ProjectsResponse;
  onProject(fn: ProjectListener): () => void;
  /** The machine index's settings.maxConcurrent at the last good read. */
  setting(): number | null;
  /** The boot passes of the projects loaded by start()'s first refresh whose pools booted, settled; [] before start(). */
  booted(): Promise<ProjectBoot[]>;
  close(): Promise<void>;
  killSync(): void;
}

/**
 * One startServer call's machine-wide state, handed to the machine routes: the page, its assets,
 * /api/about and /api/projects. One token and one set of event streams (MAX_SSE_CLIENTS counts them
 * all) serve every project. Nothing per-server lives at module level.
 */
export interface MachineCtx {
  opts: ServerOptions;
  home: string;
  token: string;
  distDir: string;
  notBuilt: string;
  provenance: VersionInfo;
  github: GitHub;
  /** Claude Code's projects dir. */
  projects: string;
  /** Open event streams and the `<project>/<scope>` each one follows (`projects` for /api/projects/events). */
  clients: Map<http.ServerResponse, string>;
  ping: NodeJS.Timeout | null;
  slots: MachineSlots;
  entries: Entries;
}

/**
 * One project's state, built by createContext in lib/server/machine.ts and handed to every project
 * route. `opts`, `token`, `clients`, `projects` and `github` are the machine's own objects. `backlogCache`,
 * `budgetCache` and `envsCache` change while the server runs, so handlers read and write them as
 * `ctx.<field>`, never through a destructured copy.
 */
export interface ServerCtx {
  name: string;
  root: string;
  machine: MachineCtx;
  opts: ServerOptions;
  token: string;
  previewGitHub: (t: GitHubTarget) => Promise<GitHubPreviewResponse>;
  /** The GitHub adapter POST /api/p/<project>/jobs/:id/merge merges through. */
  github: GitHub;
  projects: string;
  /** The machine's streams: a project route keys its own as `<name>/<scope>`. */
  clients: Map<http.ServerResponse, string>;
  pool: DaemonPool | null;
  backlogCache: { at: number; data: BacklogResponse } | null;
  budgetCache: { at: number; data: RepoBudgetStatus } | null;
  envMemo: Map<string, { at: number; p: Promise<JobEnvironmentResponse> }>;
  envsCache: { at: number; p: Promise<EnvironmentsResponse> } | null;
  /** The pool was not booted with the server because its files are not the ones a human approved; a Start clears it. */
  needsApproval: boolean;
  poolState: () => DaemonPoolState;
  /** Who drives a job, asked of the pool session whose scope is that job (lib/office/driver.ts whoDrives). */
  drive: (job: Pick<LoadedJob, 'id' | 'lease'>) => Drive;
  budget: () => RepoBudgetStatus;
}

/** A check the route tables run before a GET's handler: lib/server/http.ts holds each one. */
export type Guard = 'read' | 'token' | 'queryToken';

/** What a route matched: the request URL, and a RegExp path's capture groups ([] for a string path). */
export interface RouteMatch {
  url: URL;
  params: string[];
}

/** A route's handler: it runs only once the route's guards have passed. */
export type Handler<C = ServerCtx> = (ctx: C, req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch) => void | Promise<void>;

/** One row of a route table. A POST row takes no `guards`: dispatch always runs guardPost for it. */
export type Route<C = ServerCtx> =
  | { method: 'GET'; path: string | RegExp; guards?: readonly Guard[]; handler: Handler<C> }
  | { method: 'POST'; path: string | RegExp; guards?: never; handler: Handler<C> };
