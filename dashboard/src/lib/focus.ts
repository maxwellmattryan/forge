// Focus and a job's environment as the dashboard shows them: the status bar's focus fact, the drawer's Environment
// section's header, and the POSTs behind it (lib/server.ts). Plain TS, so test/dashboard-focus.test.ts can pin it.
import type { ApiState, Endpoint, FocusResponse, Job, PostEditorResponse } from './types.ts';

const active = (state: unknown): boolean => state !== 'done' && state !== 'cancelled';

/** The status bar's focus fact: null unless the focused job is in this state's jobs and still active. */
export function focusFact(state: Partial<Pick<ApiState, 'focus' | 'jobs'>> | null | undefined): { id: string; title: string } | null {
  const f = state?.focus;
  if (!f) return null;
  const job = state?.jobs?.find((j) => j.id === f.id);
  if (!job || !active(job.state)) return null;
  return { id: f.id, title: f.title };
}

export type FocusLabelKey = 'environment.focus' | 'environment.unfocus';

export interface EnvironmentModel {
  /** Only an active job has an environment worth acting on. */
  visible: boolean;
  focused: boolean;
  focusLabel: FocusLabelKey;
  editorDisabled: boolean;
  endpoints: Endpoint[];
}

/** The server builds every URL from an integer port; anything else is dropped rather than linked. */
const LOCAL_URL = /^http:\/\/localhost:\d{1,5}\/$/;
const validEndpoint = (e: unknown): e is Endpoint => {
  const x = e as Partial<Endpoint> | null;
  if (!x || typeof x.name !== 'string' || !x.name || !Number.isInteger(x.port)) return false;
  if (x.kind === 'component') return typeof x.url === 'string' && LOCAL_URL.test(x.url) && (typeof x.live === 'boolean' || x.live === null);
  return x.kind === 'backing' && x.url === null && x.live === null;
};

/** What the drawer's Environment section shows for a job, given the focused job's id. */
export function environmentModel(job: Pick<Job, 'id' | 'state' | 'worktree'> & { endpoints?: unknown }, focusId: string | null | undefined): EnvironmentModel {
  const endpoints = Array.isArray(job.endpoints) ? job.endpoints.filter(validEndpoint) : [];
  const focused = focusId != null && focusId === job.id;
  return {
    visible: active(job.state),
    focused,
    focusLabel: focused ? 'environment.unfocus' : 'environment.focus',
    editorDisabled: !job.worktree,
    endpoints,
  };
}

/** A JSON POST that throws with the server's `error` field, else its text, else the status text (as postJobEffort). */
export async function post<T>(url: string, body: unknown, token: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forge-token': token }, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  const error = parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string' ? (parsed as { error: string }).error : '';
  if (!res.ok) throw new Error(error || text || res.statusText);
  return parsed as T;
}

/** POST /api/focus: a job id focuses it, null clears focus. */
export const postFocus = (job: string | null, token: string, fetchImpl: typeof fetch = fetch): Promise<FocusResponse> => post<FocusResponse>('/api/focus', { job }, token, fetchImpl);

/** POST /api/jobs/:id/editor: opens the job's worktree in FORGE_EDITOR on the machine running forge dash. */
export const postEditor = (id: string, token: string, fetchImpl: typeof fetch = fetch): Promise<PostEditorResponse> => post<PostEditorResponse>(`/api/jobs/${encodeURIComponent(id)}/editor`, {}, token, fetchImpl);
