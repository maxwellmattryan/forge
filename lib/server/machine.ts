// The machine dashboard's project entries: one per project registered in the machine index whose
// directory exists, each with its own context, caches and pool (booted under the old per-repo rule, and
// only while a human's approval of its trusted files still matches them, with a boot pass that resumes
// its undriven jobs at once), kept in step with the index by
// a throttled re-read, and summarised for GET /api/projects.
import fs from 'node:fs';
import { daemonProblems, loadConfig } from '#core/config/load.ts';
import { listJobs, logRepoEvent } from '#core/job/store.ts';
import { machinePaths, paths } from '#core/paths.ts';
import { scopeKnownValues } from '#engine/guard/known-secrets.ts';
import { repoBudgetStatus } from '#engine/metrics/repo-budget.ts';
import { PROJECT_NAME, listProjects, readMachineIndex, type MachineProject, type ProjectStatus } from '#engine/project/machine-index.ts';
import { trustApproved } from '#engine/project/trust-approval.ts';
import { launchActor } from '#integrations/github/actor.ts';
import { createPreviewer, ghRunner } from '#integrations/github/preview.ts';
import { whoDrives } from '#office/driver.ts';
import { createPool } from '#office/pool.ts';
import { createChatRecorder } from '#office/chat/recorder.ts';
import type { DaemonPoolState, DaemonStatus, Job, MachineProjectSummary, ProjectsResponse, RepoBudgetStatus } from '#core/types.ts';
import { idlePoolState } from './routes/office.ts';
import { SSE_SLOW_CLIENT_BYTES, broadcast, lineFrame, stateFrame } from './sse.ts';
import { resumeProject } from './uptime.ts';
import type { Entries, MachineCtx, ProjectBoot, ProjectEntry, ProjectListener, ServerCtx } from './types.ts';

/** How long /api/p/<project>/state reuses the repo budget status. */
const BUDGET_MEMO_MS = 5000;
const REFRESH_MS = 2000;
/** The shortest gap between two re-reads that requests for unregistered names force while the index file is unchanged. */
const MISS_REFRESH_MS = 250;
const FINISHED = ['done', 'cancelled', 'failed'];

/**
 * A project's Overview counts: its unfinished jobs, and those waiting on a person. A dependency park
 * waits on other jobs and a shelved job on nobody, so neither counts as waiting.
 */
export function projectJobCounts(jobs: readonly Pick<Job, 'state' | 'waitingOn'>[]): { active: number; waiting: number } {
  return {
    active: jobs.filter((j) => !FINISHED.includes(j.state)).length,
    waiting: jobs.filter((j) => j.state === 'waiting' && j.waitingOn !== 'external' && j.waitingOn !== 'shelved').length,
  };
}

/** A project's office status for the Overview, from its office runs (no session serves `_office`): busy while one is live, idle while the pool is wanted with the foreman on, else off. */
export function officeStatus(st: Pick<DaemonPoolState, 'office' | 'wanted' | 'foreman'>): DaemonStatus {
  return st.office.live > 0 ? 'busy' : st.wanted && st.foreman ? 'idle' : 'off';
}

/** One project's route context: the machine's shared objects plus its own caches. */
export function createContext(machine: MachineCtx, name: string, root: string): ServerCtx {
  const { opts } = machine;
  const ctx: ServerCtx = {
    name,
    root,
    machine,
    opts,
    previewGitHub: createPreviewer({ run: opts.ghRun ?? ghRunner(root) }),
    github: machine.github,
    projects: machine.projects,
    clients: machine.clients,
    pool: null,
    backlogCache: null,
    needsApproval: false,
    poolState: (): DaemonPoolState => {
      const st = ctx.pool ? ctx.pool.state() : idlePoolState(root);
      // A flag, not a message: the dashboard words it (its Start approves the files), and it is no error.
      return { ...st, needsApproval: !st.wanted && ctx.needsApproval, clients: machine.clients.size };
    },
    // Asked of the pool's session for this job, under every id it has had, never of ps or the session records.
    drive: (job) => whoDrives(job, ctx.pool?.facts(job.id) ?? null),
    // Polls come every few seconds and the ledger stats every job's events, so the status is reused for 5 s.
    // write: false, so a GET never writes .forge/runtime/.
    budgetCache: null,
    budget: (): RepoBudgetStatus => {
      if (!ctx.budgetCache || Date.now() - ctx.budgetCache.at > BUDGET_MEMO_MS) ctx.budgetCache = { at: Date.now(), data: repoBudgetStatus(root, loadConfig(root).config, { write: false }) };
      return ctx.budgetCache.data;
    },
    envMemo: new Map(),
    envsCache: null,
  };
  return ctx;
}

type Loaded = ProjectEntry & { cleanups: (() => void)[]; unsubscribe: () => void };

/** The entries of one machine server; nothing is loaded until start(). */
export function createEntries(machine: MachineCtx): Entries & { start(): void } {
  const { opts, home } = machine;
  const refreshMs = opts.refreshMs ?? REFRESH_MS;
  const loaded = new Map<string, Loaded>();
  const listeners = new Set<ProjectListener>();
  let statuses: (MachineProject & { status: ProjectStatus })[] = [];
  let error: string | null = null;
  let setting: number | null = null;
  let lastKey: string | null = null;
  let lastAt = 0;
  /** When a request for an unloaded name last forced a re-read. */
  let missAt = 0;
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  /** Collects the boot passes during start()'s first refresh only; null otherwise. */
  let firstPasses: Promise<ProjectBoot | null>[] | null = null;
  let booted: Promise<ProjectBoot[]> = Promise.resolve([]);

  /** The index file's size, mtime and inode: a change in any means a write. */
  const fileKey = (): string => {
    try {
      const st = fs.statSync(machinePaths(home).projects);
      return `${st.size}:${st.mtimeMs}:${st.ino}`;
    } catch {
      return 'none';
    }
  };

  function attach(e: Loaded, fn: ProjectListener): void {
    try {
      const cleanup = fn(e);
      if (typeof cleanup === 'function') e.cleanups.push(cleanup);
    } catch {
      // A listener (the activity log) never stops a project from loading.
    }
  }

  function load(name: string, root: string): void {
    const ctx = createContext(machine, name, root);
    const pool = (opts.createPool ?? createPool)(root, { ...opts.daemon, slots: machine.slots });
    ctx.pool = pool;
    // A chat's session lines and session ids go into its chat files first (it never throws).
    const recordChat = createChatRecorder(root);
    // Each stream gets only its own project's and session's lines and state.
    const unsubscribe = pool.subscribe((e) => {
      recordChat(e);
      let frame: string;
      try {
        frame = e.kind === 'line' ? lineFrame(e.offset, e.line) : stateFrame(e.state, scopeKnownValues(root, e.scope, loadConfig(root).config));
      } catch {
        // Unreadable config: a state frame that can't be redacted is dropped, never sent raw.
        return;
      }
      broadcast(machine.clients, frame, SSE_SLOW_CLIENT_BYTES, `${name}/${e.scope}`);
    });
    const entry: Loaded = { name, root, ctx, pool, cleanups: [], unsubscribe };
    loaded.set(name, entry);
    for (const fn of listeners) attach(entry, fn);
    // The run's launch mode reaches this project's sessions from now on, so its audit log says so: at start-up, and
    // when a project registered later loads. A repo without .forge/config.yml gets no .forge/ for it.
    const launchMode = opts.daemon?.launchPermissionMode;
    if (launchMode && fs.existsSync(paths(root).config)) {
      try {
        logRepoEvent(root, 'daemon-mode', { mode: launchMode, actor: launchActor() });
      } catch {
        // An unwritable audit log never stops a project from loading.
      }
    }
    try {
      const { config } = loadConfig(root);
      // A dev dashboard often serves fresh clones of repos that commit daemon.enabled: true, so it
      // never boots a paid session by itself; Start still works.
      if (!opts.dev && config.daemon?.enabled === true && !daemonProblems(config, root).length) {
        // Only while the files Forge trusts are the ones a human approved for this project. Booting
        // snapshots them as approved, so a restart, or `forge dash` in another repo, must not do that
        // for bytes nobody looked at (a session's change that stopped this daemon, a pull).
        if (trustApproved(home, root)) {
          const st = pool.start('boot');
          // At once, not at the pool's first RECONCILE_MS: a restart resumes what it left in flight.
          if (st.wanted) {
            const pass = resumeProject(name, root, pool);
            firstPasses?.push(pass);
          }
        } else ctx.needsApproval = true;
      }
    } catch {}
  }

  /** Off the map at once (its routes 404), then its listeners, streams and pool. */
  async function unload(e: Loaded, stop: boolean): Promise<void> {
    if (loaded.get(e.name) === e) loaded.delete(e.name);
    for (const c of e.cleanups) {
      try {
        c();
      } catch {}
    }
    e.unsubscribe();
    for (const [res, key] of [...machine.clients]) {
      if (!key.startsWith(`${e.name}/`)) continue;
      machine.clients.delete(res);
      res.end();
    }
    try {
      if (stop) await e.pool.stop('removed');
    } finally {
      // Closed even when its stop fails, so it leaves the machine cap and its timers stop.
      await e.pool.close();
    }
  }

  function refresh(force = false): void {
    if (closed) return;
    const now = Date.now();
    if (!force && now - lastAt < refreshMs) return;
    lastAt = now;
    const key = fileKey();
    if (!force && key === lastKey) return;
    lastKey = key;
    let listed: typeof statuses;
    try {
      listed = listProjects(home).projects;
      setting = readMachineIndex(home).settings.maxConcurrent;
      error = null;
    } catch (e) {
      // The last good set stays loaded; /api/projects reports why.
      error = (e as Error).message;
      return;
    }
    statuses = listed;
    const want = new Map(listed.filter((p) => p.status !== 'missing').map((p) => [p.name, p.path]));
    // One project's failure is its own: it never escapes the timer or a request, nor skips the projects after it.
    for (const e of [...loaded.values()]) if (want.get(e.name) !== e.root) unload(e, true).catch(() => {});
    for (const [name, root] of want) {
      if (loaded.has(name)) continue;
      try {
        load(name, root);
      } catch {
        // Not loaded (its routes 404, /api/projects lists it unloaded); the next forced re-read tries it again.
      }
    }
  }

  const summary = (p: MachineProject & { status: ProjectStatus }): MachineProjectSummary => {
    const e = loaded.get(p.name);
    if (!e || e.root !== p.path) return { name: p.name, path: p.path, status: p.status, loaded: false, jobs: null, latest: null, daemon: null };
    let jobs = { active: 0, waiting: 0 };
    let latest: MachineProjectSummary['latest'] = null;
    try {
      const all = listJobs(e.root);
      jobs = projectJobCounts(all);
      // The job's own title: the dashboard escapes it, so it is never cut or cleaned here.
      for (const j of all) {
        if (j.kind === 'eval' || !j.updatedAt || (latest && j.updatedAt <= latest.at)) continue;
        latest = { id: j.id, title: j.title, at: j.updatedAt, stage: j.stage, state: j.state };
      }
    } catch {}
    const st = e.pool.state();
    return {
      name: p.name,
      path: p.path,
      status: p.status,
      loaded: true,
      jobs,
      latest,
      daemon: { enabled: st.enabled, wanted: st.wanted, foreman: st.foreman, office: officeStatus(st), live: st.live, maxConcurrent: st.maxConcurrent },
    };
  };

  return {
    start() {
      firstPasses = [];
      refresh(true);
      const passes = firstPasses;
      firstPasses = null;
      // resumeProject never rejects, so neither does this.
      booted = Promise.all(passes).then((all) => all.filter((b): b is ProjectBoot => b !== null));
      timer = setInterval(() => refresh(false), refreshMs);
      timer.unref();
    },
    resolve(name) {
      // The name is checked before anything is read, so a crafted segment never reaches the index.
      if (!PROJECT_NAME.test(name)) return null;
      const hit = loaded.get(name);
      if (hit) return hit;
      // A miss reads the index again, but a loop of requests for a name nobody registered must not
      // re-read it and stat every project each time: once per MISS_REFRESH_MS, or at once when the file changed.
      const now = Date.now();
      if (now - missAt >= MISS_REFRESH_MS || fileKey() !== lastKey) {
        missAt = now;
        refresh(true);
      }
      return loaded.get(name) ?? null;
    },
    get: (name) => loaded.get(name) ?? null,
    list: () => [...loaded.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
    refresh,
    summaries: (): ProjectsResponse => ({
      error,
      machine: { maxConcurrent: machine.slots.cap(), source: setting === null ? 'auto' : 'settings', live: machine.slots.live(), launchPermissionMode: opts.daemon?.launchPermissionMode ?? null },
      projects: statuses.map(summary),
    }),
    onProject(fn) {
      listeners.add(fn);
      for (const e of loaded.values()) attach(e, fn);
      return () => void listeners.delete(fn);
    },
    setting: () => setting,
    booted: () => booted,
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      await Promise.all([...loaded.values()].map((e) => unload(e, false)));
    },
    killSync() {
      for (const e of loaded.values()) e.pool.killSync();
    },
  };
}
