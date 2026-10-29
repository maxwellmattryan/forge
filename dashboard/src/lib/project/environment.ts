// A job's environment as the dashboard shows it (issue #199): the Environment card's dev server row, backing services
// list and log viewer, and the Project page's Running environments section, over the routes in lib/server/routes/environment.ts. Plain TS,
// so a test can pin it. Log lines are untrusted text: they only ever reach `{line}`.
import { post } from './focus.ts';
import { projectApi } from '../core/project.ts';
import type { DevState, EnvironmentAction, EnvironmentRow, EnvironmentService, EnvironmentsResponse, EnvironmentTarget, JobEnvironmentResponse, PostEnvironmentResponse } from '../core/types.ts';

/** A state chip: its tone (TONE_CLASS) and the state it names, which the component turns into a message. */
export interface ChipModel<S extends string> {
  state: S;
  tone: 'ok' | 'live' | 'bad' | 'muted' | 'warn' | 'info';
}

const DEV_TONE: Record<DevState, ChipModel<DevState>['tone']> = { running: 'ok', starting: 'live', down: 'bad', stopped: 'muted' };

export function devChip(state: DevState): ChipModel<DevState> {
  return { state, tone: DEV_TONE[state] ?? 'muted' };
}

const SERVICE_TONE: Record<EnvironmentService['state'], ChipModel<EnvironmentService['state']>['tone']> = { running: 'ok', stopped: 'muted', missing: 'warn', unknown: 'muted', external: 'info' };

export function serviceChip(state: EnvironmentService['state']): ChipModel<EnvironmentService['state']> {
  return { state, tone: SERVICE_TONE[state] ?? 'muted' };
}

/** Why a control is disabled, as the hint the component shows; null when it is enabled for a reason the state shows. */
export type ButtonHint = 'inactive' | 'noWorktree' | 'noManaged' | null;

export interface Buttons {
  start: boolean;
  stop: boolean;
  restart: boolean;
  /** Why Start and Restart are off for this job (or every button, for `noManaged`). */
  hint: ButtonHint;
}

const NONE: Buttons = { start: false, stop: false, restart: false, hint: null };

/** The dev server row's Start (down or stopped), Stop (running or starting) and Restart (always), each only where the server allows it. */
export function devButtons(env: JobEnvironmentResponse | null): Buttons {
  if (!env?.dev) return NONE;
  const hint: ButtonHint = !env.active ? 'inactive' : !env.worktree ? 'noWorktree' : null;
  const s = env.dev.state;
  return { start: hint === null && (s === 'down' || s === 'stopped'), stop: s === 'running' || s === 'starting', restart: hint === null, hint };
}

/** The backing list's group controls: off when nothing is Docker-run; Start and Restart need an active job. */
export function backingButtons(env: JobEnvironmentResponse | null): Buttons {
  if (!env) return NONE;
  if (!env.backing.some((s) => s.managed)) return { ...NONE, hint: env.backing.length ? 'noManaged' : null };
  const hint: ButtonHint = env.active ? null : 'inactive';
  return { start: hint === null, stop: true, restart: hint === null, hint };
}

/** Docker itself is unreachable, as the server reports it: a container with another job's labels also reads `unknown`. */
export const dockerDown = (env: JobEnvironmentResponse | null): boolean => env?.docker === 'missing' || env?.docker === 'stopped';

/** Why a managed service's Logs toggle is off: the server streams only a container that reads running or stopped. */
export function logHint(s: Pick<EnvironmentService, 'state'>): 'logsMissing' | 'logsUnknown' | null {
  return s.state === 'running' || s.state === 'stopped' ? null : s.state === 'missing' ? 'logsMissing' : 'logsUnknown';
}

/** Which toast an action ends with, as a message-key suffix: `devStarted`, `backingRestarted`, … */
export function actionToast(target: EnvironmentTarget, action: EnvironmentAction): `${EnvironmentTarget}${'Started' | 'Stopped' | 'Restarted'}` {
  const done = action === 'start' ? 'Started' : action === 'stop' ? 'Stopped' : 'Restarted';
  return `${target}${done}`;
}

/** A GET that throws the server's `error`, else its text, else the status text. */
async function getJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(projectApi(url));
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const error = parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string' ? (parsed as { error: string }).error : '';
    throw new Error(error || text || res.statusText);
  }
  return parsed as T;
}

const jobPath = (id: string) => `/api/jobs/${encodeURIComponent(id)}/environment`;

/** GET /api/jobs/:id/environment. */
export const fetchEnvironment = (id: string, fetchImpl: typeof fetch = fetch): Promise<JobEnvironmentResponse> => getJson<JobEnvironmentResponse>(jobPath(id), fetchImpl);

/** POST /api/jobs/:id/environment: start, stop or restart the dev server or the backing services. */
export const postEnvironment = (id: string, target: EnvironmentTarget, action: EnvironmentAction, fetchImpl: typeof fetch = fetch): Promise<PostEnvironmentResponse> =>
  post<PostEnvironmentResponse>(jobPath(id), { target, action }, fetchImpl);

/** GET /api/environments. */
export const fetchEnvironments = (fetchImpl: typeof fetch = fetch): Promise<EnvironmentsResponse> => getJson<EnvironmentsResponse>('/api/environments', fetchImpl);

/** The log stream for one source, as an EventSource URL. */
export const logStreamUrl = (id: string, source: string): string => projectApi(`${jobPath(id)}/logs?${new URLSearchParams({ source })}`);

/** A log source for one backing service. */
export const backingSource = (name: string): string => `backing:${name}`;

/** One frame's data: a JSON string of one line; anything else is dropped. */
export function parseFrame(data: unknown): string | null {
  if (typeof data !== 'string') return null;
  try {
    const v: unknown = JSON.parse(data);
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

export const LOG_CAP = 1000;

/** The buffer with `lines` appended, keeping only the newest `cap`. */
export function pushLines(buf: readonly string[], lines: readonly string[], cap = LOG_CAP): string[] {
  const next = buf.concat(lines);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

const DASH = '—';
const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

/** `13107200` → `12.5 MiB`; `—` when unknown. */
export function formatBytes(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return DASH;
  let v = n;
  let u = 0;
  while (v >= 1024 && u < BYTE_UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${v} B` : `${v.toFixed(1)} ${BYTE_UNITS[u]}`;
}

/** `1.5` → `1.5%`; `—` when unknown. */
export function formatPercent(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${n.toFixed(1)}%` : DASH;
}

/** A sum of what is known; null when nothing is. */
function sum(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => typeof v === 'number');
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

/** One table row of the Running environments section, every cell formatted. `job` is null for the shared services. */
export interface ProjectEnvRow {
  key: string;
  job: string | null;
  title: string;
  state: string | null;
  devPort: string;
  devCpu: string;
  devMem: string;
  containers: number;
  cpu: string;
  mem: string;
}

export function projectRows(rows: readonly EnvironmentRow[] | null | undefined): ProjectEnvRow[] {
  return (rows ?? []).map((r) => ({
    key: r.job ?? '\0shared',
    job: r.job,
    title: r.title,
    state: r.state,
    devPort: r.dev?.port ? `localhost:${r.dev.port}` : DASH,
    devCpu: r.dev ? formatPercent(r.dev.cpu) : DASH,
    devMem: r.dev ? formatBytes(r.dev.memBytes) : DASH,
    containers: r.containers.length,
    cpu: r.containers.length ? formatPercent(sum(r.containers.map((c) => c.cpu))) : DASH,
    mem: r.containers.length ? formatBytes(sum(r.containers.map((c) => c.memBytes))) : DASH,
  }));
}
