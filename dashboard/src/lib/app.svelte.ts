// The dashboard's state and actions, ported from the pre-Svelte app.js: same fetches, toasts and follow-up refreshes.
// API payloads are $state.raw and replaced wholesale, so a poll re-renders only what reads them.
import { api, errorText } from './util.ts';
import { API_VERSION } from './types.ts';
import type {
  AboutResponse,
  ApiState,
  BacklogResponse,
  ConfigResponse,
  ConfigValue,
  DoctorResponse,
  EvalCompare,
  EvalsResponse,
  GitHubPreviewResponse,
  JobDetail,
  PostConfigBody,
  PostConfigResponse,
  PostJobBody,
  PostJobResponse,
  PostRequestResponse,
  Roster,
  Stats,
} from './types.ts';
import { pref } from './prefs.ts';
import { toast } from './toast.svelte.ts';
import { VIEWS, buildRequest, pickDrawerFile, queuedMessage, statsQuery } from './view.ts';
import { addFlashes, changedJobs } from './live.ts';
import { threadItems, threadMarks, threadOpening } from './thread.ts';
import { DEFAULT_DRAWER_TAB, PANE_DEFAULT, clampPaneWidth, type DrawerTab, type PaneMode } from './drawer.ts';
import type { RequestBody, RequestInput, ViewId } from './view.ts';

/** The backlog, or the error a forced refresh hit (that reply has no tracker). */
export type BacklogView = Omit<BacklogResponse, 'tracker'> & { tracker?: string };
export type DrawerContent = { html: true } | { text: string };
/** What Drawer.svelte shows; reassigned only where the old renderDrawer() ran. */
export type DrawerView = { detail: JobDetail; file: string | null; content: DrawerContent | null; tab: DrawerTab } | { error: string } | null;

class CompareState {
  a = $state('');
  b = $state('');
  result = $state.raw<EvalCompare | null>(null);
}

class DrawerState {
  id = $state<string | null>(null);
  file = $state<string | null>(null);
  tab = $state<DrawerTab>(DEFAULT_DRAWER_TAB);
  detail = $state.raw<JobDetail | null>(null);
  content = $state.raw<DrawerContent | null>(null);
  /** The Timeline's length when this drawer opened: later rows are marked new. Null until the first load. */
  eventsAtOpen = $state<number | null>(null);
  /** The Thread's marks when this drawer opened: messages new or changed since are marked. Null until the first load. */
  threadAtOpen = $state.raw<string[] | null>(null);
}

/** The job pane's layout. App measures the main column and the md breakpoint; the separator sets the width. */
class PaneState {
  /** The viewer's width (pref `paneWidth`), clamped to the main column wherever it is used. */
  width = $state(clampPaneWidth(Number(pref.get('paneWidth', String(PANE_DEFAULT))), Infinity));
  mode = $state<PaneMode>('split');
  /** The main column's width, px; 0 until App measures it. */
  available = $state(0);
  /** At md and up. */
  md = $state(true);
}

class AppState {
  data = $state.raw<ApiState | null>(null);
  dataKey = '';
  error = $state<string | null>(null);
  /** The last /api/state poll: null until one finishes, then whether it succeeded. The status bar's Connection reads it. */
  online = $state<boolean | null>(null);
  /** When the last poll succeeded (ISO). */
  polledAt = $state<string | null>(null);
  view = $state<ViewId>('pipeline');
  layout = $state(pref.get('layout', 'board'));
  filter = $state(pref.get('filter', 'active'));
  window = $state(pref.get('window', '30'));
  stats = $state.raw<Stats | null>(null);
  evals = $state.raw<EvalsResponse | null>(null);
  roster = $state.raw<Roster | null>(null);
  backlog = $state.raw<BacklogView | null>(null);
  compare = new CompareState();
  drawer = new DrawerState();
  drawerView = $state.raw<DrawerView>(null);
  pane = new PaneState();
  /** `#/inbox` was opened: StatusBar opens the Needs-you popover once its button renders, then clears this. */
  openNeeds = $state(false);
  /** Job id → when its card's change flash ends (epoch ms). */
  flashes = $state.raw<Record<string, number>>({});
  /** Job id → the Thread marks last shown, for the tab's unread count. In memory, so it lasts the page's lifetime. */
  threadSeen = $state.raw<Record<string, string[]>>({});
}

export const S = new AppState();

const TOKEN = (): string => document.querySelector<HTMLMetaElement>('meta[name="forge-token"]')?.content ?? '';
let token: string | null = null;
/** Read once, as the old app.js did at load. */
export const forgeToken = (): string => (token ??= TOKEN());

/** The last poll's job signatures; null until the first poll, so the page's first load flashes nothing. */
let sigs: Record<string, string> | null = null;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------- data ----------

export async function refresh(): Promise<void> {
  try {
    const data = await api<ApiState>('/api/state');
    S.online = true;
    S.polledAt = new Date().toISOString();
    S.error = data.apiVersion > API_VERSION ? 'This data was written by a newer Forge. Restart `forge dash` after updating the plugin.' : null;
    const key = JSON.stringify({ ...data, now: undefined });
    if (key !== S.dataKey) {
      // Only a poll whose data changed gets here, so an identical poll never flashes.
      const r = changedJobs(sigs, data.jobs);
      sigs = r.sigs;
      S.flashes = addFlashes(S.flashes, r.changed, Date.now());
      S.data = data;
      S.dataKey = key;
    }
    if (S.drawer.id) loadDrawer(false);
  } catch (e) {
    S.online = false;
    S.error = `Lost connection to the Forge server (${message(e)}). Is \`forge dash\` still running?`;
  }
}

export async function loadView(): Promise<void> {
  try {
    if (S.view === 'analytics') S.stats = await api<Stats>(`/api/stats${statsQuery(S.window, Date.now())}`);
    if (S.view === 'evals') S.evals = await api<EvalsResponse>('/api/evals');
    if (S.view === 'agents') S.roster = await api<Roster>('/api/roster');
    if (S.view === 'backlog') S.backlog = await api<BacklogResponse>('/api/backlog');
  } catch (e) {
    toast(message(e), true);
  }
}

/** GET /api/roster into S.roster, for the status bar's Model popover; the error reaches the caller, which shows it. */
export async function loadRoster(): Promise<void> {
  S.roster = await api<Roster>('/api/roster');
}

export function route(): void {
  const v = location.hash.replace(/^#\/?/, '') || 'pipeline';
  // Needs you was a page: its old link shows the Pipeline and opens the Needs-you popover (StatusBar does, once it renders).
  if (v === 'inbox') {
    history.replaceState(null, '', '#/pipeline');
    S.openNeeds = true;
  }
  S.view = VIEWS.find((x) => x.id === v)?.id ?? 'pipeline';
  loadView();
}

// ---------- controls ----------

export function setFilter(f: string): void {
  S.filter = f;
  pref.set('filter', f);
}

export function setLayout(l: string): void {
  S.layout = l;
  pref.set('layout', l);
}

export function setWindow(w: string): void {
  S.window = w;
  pref.set('window', w);
  loadView();
}

export async function refreshBacklog(): Promise<void> {
  S.backlog = await api<BacklogResponse>('/api/backlog?refresh=1').catch((e: unknown) => ({ items: [], error: message(e) }));
}

export async function compareRuns(a: string, b: string): Promise<void> {
  S.compare.a = a;
  S.compare.b = b;
  try {
    S.compare.result = await api<EvalCompare>(`/api/evals/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
  } catch (e) {
    toast(message(e), true);
  }
}

// ---------- requests ----------

const postInit = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forge-token': forgeToken() },
  body: JSON.stringify(body),
});

/** Queues a request; throws the server's `error` text, so the command bar can keep it in the dialog. */
export const postRequest = (body: RequestBody): Promise<PostRequestResponse> => jsonFetch<PostRequestResponse>('/api/requests', postInit(body));

export async function request(body: RequestBody): Promise<void> {
  try {
    const r = await postRequest(body);
    toast(queuedMessage(body.type, r.daemon));
    refresh();
  } catch (e) {
    toast(`Request failed: ${message(e)}`, true);
  }
}

/** POST /api/jobs: a new job from free text. Throws the server's `error` text. */
export const createJob = (body: PostJobBody): Promise<PostJobResponse> => jsonFetch<PostJobResponse>('/api/jobs', postInit(body));

/** Fills S.backlog for the command bar's ref completion, once; a failure leaves it empty with the error. */
export async function loadBacklog(): Promise<void> {
  if (S.backlog) return;
  S.backlog = await api<BacklogResponse>('/api/backlog').catch((e: unknown) => ({ items: [], error: message(e) }));
}

/** A request button: builds the body as the old `req` handler did, or toasts why not. */
export function req(input: RequestInput): void {
  const r = buildRequest(input);
  if ('error' in r) toast(r.error, true);
  else request(r.body);
}

// ---------- settings ----------

/** fetch for JSON endpoints: errors carry the reply's `error` text, never a raw JSON body. */
async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  if (!res.ok) throw new Error(errorText(text) || res.statusText);
  return JSON.parse(text) as T;
}

export const fetchConfig = (): Promise<ConfigResponse> => jsonFetch<ConfigResponse>('/api/config');

export const postConfig = (key: string, value: ConfigValue): Promise<PostConfigResponse> =>
  jsonFetch<PostConfigResponse>('/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forge-token': forgeToken() },
    body: JSON.stringify({ key, value } satisfies PostConfigBody),
  });

/** Takes the token: the server runs git and gh for it. */
export const fetchDoctor = (): Promise<DoctorResponse> => jsonFetch<DoctorResponse>('/api/doctor', { headers: { 'x-forge-token': forgeToken() } });

/** Takes the token: the server runs gh for it, on the login's rate limit. */
export const fetchGitHubPreview = (url: string): Promise<GitHubPreviewResponse> =>
  jsonFetch<GitHubPreviewResponse>(`/api/github/preview?url=${encodeURIComponent(url)}`, { headers: { 'x-forge-token': forgeToken() } });

export const fetchAbout = (): Promise<AboutResponse> => jsonFetch<AboutResponse>('/api/about');

// ---------- drawer ----------

const marksOf = (d: JobDetail): string[] => threadMarks(threadItems(d.requests, threadOpening(d), d.events));

function renderDrawer(): void {
  const d = S.drawer.detail;
  const id = S.drawer.id;
  if (!d) return;
  S.drawerView = { detail: d, file: S.drawer.file, content: S.drawer.content, tab: S.drawer.tab };
  // A job's first load counts as read, and so does everything while the Thread is the shown tab.
  if (id && (!Object.hasOwn(S.threadSeen, id) || S.drawer.tab === 'thread')) S.threadSeen = { ...S.threadSeen, [id]: marksOf(d) };
}

export async function openDrawer(id: string, file: string | null = null, tab: DrawerTab = DEFAULT_DRAWER_TAB): Promise<void> {
  S.drawer.id = id;
  S.drawer.detail = null;
  S.drawer.file = file;
  S.drawer.content = null;
  S.drawer.tab = tab;
  S.drawer.eventsAtOpen = null;
  S.drawer.threadAtOpen = null;
  await loadDrawer(true);
}

/** Keeps drawerView, so the panel slides out with its content. */
export function closeDrawer(): void {
  S.drawer.id = null;
  S.drawer.detail = null;
  S.drawer.file = null;
  S.drawer.content = null;
  S.drawer.tab = DEFAULT_DRAWER_TAB;
  S.drawer.eventsAtOpen = null;
  S.drawer.threadAtOpen = null;
}

async function loadDrawer(full: boolean): Promise<void> {
  const id = S.drawer.id;
  if (!id) return;
  try {
    const detail = await api<JobDetail>(`/api/jobs/${encodeURIComponent(id)}`);
    if (S.drawer.id !== id) return;
    const changed = JSON.stringify(detail) !== JSON.stringify(S.drawer.detail);
    S.drawer.detail = detail;
    if (full) {
      // The baselines new rows are marked against; reopening the drawer resets them.
      S.drawer.eventsAtOpen = detail.events.length;
      S.drawer.threadAtOpen = marksOf(detail);
    }
    S.drawer.file = pickDrawerFile(detail.files, S.drawer.file);
    if (S.drawer.file && (full || changed)) await loadFile(S.drawer.file, false);
    if (full || changed) renderDrawer();
  } catch (e) {
    S.drawerView = { error: message(e) };
  }
}

export async function loadFile(rel: string, rerender = true): Promise<void> {
  S.drawer.file = rel;
  if (rel.endsWith('.html')) S.drawer.content = { html: true };
  else S.drawer.content = { text: await api<string>(`/api/jobs/${encodeURIComponent(S.drawer.id ?? '')}/file?path=${encodeURIComponent(rel)}`) };
  if (rerender) renderDrawer();
}

export function setDrawerTab(tab: DrawerTab): void {
  S.drawer.tab = tab;
  renderDrawer();
}
