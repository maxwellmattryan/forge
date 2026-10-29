// The dashboard's state and actions, ported from the pre-Svelte app.js: same fetches, toasts and follow-up refreshes.
// API payloads are $state.raw and replaced wholesale, so a poll re-renders only what reads them.
import { api, errorText } from './util.ts';
import { SIGNED_OUT_MESSAGE, connectionBanner, isSignedOutError } from './login.ts';
import { API_VERSION } from './types.ts';
import { currentProject, isNotRegisteredError, notRegistered, projectApi, setProject } from './project.ts';
import { parseRoute, routeProject, type Route } from '../shell/routes.ts';
import type {
  AboutResponse,
  ApiState,
  BacklogItemResponse,
  BacklogResponse,
  ConfigResponse,
  ConfigValue,
  DoctorResponse,
  EnvironmentsResponse,
  EvalCompare,
  EvalsResponse,
  GitHubPreviewResponse,
  JobDetail,
  MandatesResponse,
  PostConfigBody,
  PostBudgetAckResponse,
  PostConfigResponse,
  PostJobBody,
  PostJobResponse,
  PostRequestResponse,
  RequestsResponse,
  ProjectResponse,
  ProjectsResponse,
  ProjectsStatsResponse,
  Roster,
  Stats,
} from './types.ts';
import { bundleFilename } from '../settings/diagnostics.ts';
import { fetchEnvironments } from '../project/environment.ts';
import { fetchMandates } from '../office/foreman.ts';
import { pref } from '../settings/prefs.ts';
import { toast } from '../ui/overlay/toast.svelte.ts';
import { buildRequest, queuedMessage } from './requests.ts';
import { pruneSent, type SentDecision } from '../gates/decision.ts';
import { statsQuery } from '../metrics/analytics.ts';
import { addFlashes, pollChanges, type PollMemo } from '../sessions/live.ts';
import { threadItems, threadMarks, threadOpening } from '../jobs/thread.ts';
import { DEFAULT_DRAWER_TAB, PANE_DEFAULT, clampPaneWidth, pickDrawerFile, type DrawerTab } from '../jobs/drawer.ts';
import type { RequestBody, RequestInput } from './requests.ts';
import type { ViewId } from '../shell/nav.ts';
import { readSidebar, type SidebarState } from '../shell/sidebar.ts';
import { selectionOpenable, switcherEntries } from '../shell/switcher.ts';

const SIDE_START: SidebarState = readSidebar(pref.get);

/** The tracker's items, or the error a forced refresh hit (that reply has no tracker). */
export type BacklogView = Omit<BacklogResponse, 'tracker'> & { tracker?: string };
export type DrawerContent = { html: true } | { text: string };
/** What Drawer.svelte shows; reassigned only where the old renderDrawer() ran. */
export type DrawerView = { detail: JobDetail; file: string | null; content: DrawerContent | null; tab: DrawerTab } | { error: string } | null;

class CompareState {
  a = $state('');
  b = $state('');
  result = $state.raw<EvalCompare | null>(null);
}

/** The issue panel's GET /api/backlog/item for `ref`: null data while it loads, `error` when the fetch itself failed. */
export type IssueViewState = { ref: string; data: BacklogItemResponse | null; error: string | null };

/** The drawer's two panels share one shell. At most one of `id` (the job panel's) and `issue` (the issue panel's) is set. */
class DrawerState {
  /** The panel the drawer shows; kept after a close, so the drawer slides out with its last content. */
  kind = $state<'job' | 'issue'>('job');
  /** The open issue's ref. */
  issue = $state<string | null>(null);
  /** The issue ref the job panel's Back button returns to; null when the job was opened any other way. */
  back = $state<string | null>(null);
  id = $state<string | null>(null);
  file = $state<string | null>(null);
  tab = $state<DrawerTab>(DEFAULT_DRAWER_TAB);
  detail = $state.raw<JobDetail | null>(null);
  content = $state.raw<DrawerContent | null>(null);
  /** The Timeline's length when this drawer opened: later rows are marked new. Null until the first load. */
  eventsAtOpen = $state<number | null>(null);
  /** The Thread's marks when this drawer opened: messages new or changed since are marked. Null until the first load. */
  threadAtOpen = $state.raw<string[] | null>(null);
  /** Either panel is open: the drawer covers the page. */
  get open(): boolean {
    return this.id !== null || this.issue !== null;
  }
}

/** The job drawer's layout. App binds the window width and the md breakpoint; the separator sets the width. */
class PaneState {
  /** The viewer's width (pref `paneWidth`), one for every job, clamped to the viewport wherever it is used. */
  width = $state(clampPaneWidth(Number(pref.get('paneWidth', String(PANE_DEFAULT))), Infinity));
  /** At md and up. */
  md = $state(true);
  /** The window's innerWidth; App binds it. */
  viewport = $state(Infinity);
}

/** The sidebar's layout (prefs `sidebarWidth`, `sidebarCompact`); App's separator sets it and saves it. */
class SideState {
  /** The last expanded width, kept while compact so the separator's Enter can restore it. */
  width = $state(SIDE_START.width);
  /** The icon-only rail. */
  compact = $state(SIDE_START.compact);
}

class AppState {
  data = $state.raw<ApiState | null>(null);
  dataKey = '';
  error = $state<string | null>(null);
  /** The last /api/state poll: null until one finishes, then whether it succeeded. The status bar's Connection reads it. */
  online = $state<boolean | null>(null);
  /** When the last poll succeeded (ISO). */
  polledAt = $state<string | null>(null);
  /** The page the hash names. A project page selects its project; a global page keeps the selection. */
  route = $state.raw<Route>({ scope: 'global', view: 'overview' });
  /** The selected project (project.ts's, as state), remembered as the machine pref `lastProject`; null for none. */
  selected = $state<string | null>(null);
  /** The last project page's view; a global page leaves it as it was. */
  view = $state<ViewId>('pipeline');
  /** GET /api/projects, polled every 5 s; a failed poll keeps the last list. */
  machine = $state.raw<ProjectsResponse | null>(null);
  /** The last /api/projects poll: null until one finishes, then whether it succeeded. */
  machineOnline = $state<boolean | null>(null);
  /** The lost-connection line for the global pages while the last /api/projects poll failed. */
  machineLost = $state<string | null>(null);
  /** GET /api/projects/stats for the Overview's graphs; a failed load keeps the last answer and sets `overviewError`. */
  overview = $state.raw<ProjectsStatsResponse | null>(null);
  overviewError = $state<string | null>(null);
  /** The Overview's graph window in days (machine pref `overviewWindow`). */
  overviewWindow = $state(pref.get('overviewWindow', '30'));
  layout = $state(pref.get('layout', 'board'));
  filter = $state(pref.get('filter', 'active'));
  window = $state(pref.get('window', '30'));
  stats = $state.raw<Stats | null>(null);
  evals = $state.raw<EvalsResponse | null>(null);
  roster = $state.raw<Roster | null>(null);
  project = $state.raw<ProjectResponse | null>(null);
  /** The Project page's Running environments; a failed load keeps the last answer and sets `environmentsError`. */
  environments = $state.raw<EnvironmentsResponse | null>(null);
  environmentsError = $state<string | null>(null);
  backlog = $state.raw<BacklogView | null>(null);
  /** The Office page's GET /api/mandates; a failed load keeps the last answer and sets `mandatesError`. */
  mandates = $state.raw<MandatesResponse | null>(null);
  mandatesError = $state<string | null>(null);
  compare = new CompareState();
  drawer = new DrawerState();
  drawerView = $state.raw<DrawerView>(null);
  /** The issue panel's item text; kept after a close, like drawerView, and for the same ref while it re-fetches. */
  issueView = $state.raw<IssueViewState | null>(null);
  pane = new PaneState();
  side = new SideState();
  /** `#/inbox` was opened: StatusBar opens the Needs-you popover once its button renders, then clears this. */
  openNeeds = $state(false);
  /** Job id → when its card's change flash ends (epoch ms). */
  flashes = $state.raw<Record<string, number>>({});
  /** Job id → when its card's cooling edge from a stage change ends (epoch ms). */
  cooling = $state.raw<Record<string, number>>({});
  /**
   * When the first good poll landed, moved by the first good poll after a failed one (epoch ms); null before. Heat and
   * entry effects wait SETTLE_MS past it (motion.ts settled()). It changes only on those polls, so reading it never
   * re-renders on every poll.
   */
  readyAt = $state<number | null>(null);
  /** Job id → the Thread marks last shown, for the tab's unread count. In memory, so it lasts the page's lifetime. */
  threadSeen = $state.raw<Record<string, string[]>>({});
  /** Job id → the gate decision this tab sent, until the request leaves the queue (decision.ts). Per project. */
  sent = $state.raw<Record<string, SentDecision>>({});
}

export const S = new AppState();

/** The last poll's job signatures; null until the first poll, so the page's first load flashes nothing. */
let memo: PollMemo | null = null;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------- data ----------

/** The server answered 404 for a project that is not (or no longer) registered: it is up, so this is not a lost connection. */
const isUnregistered = (e: unknown): boolean => isNotRegisteredError(errorText(message(e)));

// A 401 from a running server means this browser holds no login cookie (a new profile, a restart, a localhost URL), which
// a new login link fixes; anything else is a lost connection.
const lostConnection = (e: unknown): string => connectionBanner(errorText(message(e)), `Lost connection to the Forge server (${message(e)}). Is \`forge dash\` still running?`);

/** GET /api/projects into S.machine: the switcher, the Overview and the Machine page read it. A failure keeps the last list. */
export async function refreshMachine(): Promise<void> {
  try {
    S.machine = await api<ProjectsResponse>('/api/projects');
    S.machineOnline = true;
    S.machineLost = null;
  } catch (e) {
    S.machineOnline = false;
    S.machineLost = lostConnection(e);
  }
}

/**
 * The startup check on the remembered project, once the first /api/projects poll is in: one no longer registered and
 * openable (removed, renamed, or its directory moved) is forgotten, and a global page selects none. A project page keeps
 * the selection and shows refresh()'s not-registered banner. A failed poll checks nothing.
 */
export function checkSelection(): void {
  const name = currentProject();
  if (name === null || S.machineOnline !== true || selectionOpenable(switcherEntries(S.machine), name)) return;
  if (S.route.scope === 'global') switchProject(null);
  else pref.set('lastProject', '');
}

/** GET /api/projects/stats for the Overview's graphs over S.overviewWindow; a failure keeps the last graphs and sets the error line. */
export async function loadOverview(): Promise<void> {
  const days = S.overviewWindow;
  try {
    const r = await api<ProjectsStatsResponse>(`/api/projects/stats?days=${encodeURIComponent(days)}`);
    // A reply for a window the user has since changed is dropped: the newer load sets it.
    if (S.overviewWindow !== days) return;
    S.overview = r;
    S.overviewError = null;
  } catch (e) {
    if (S.overviewWindow === days) S.overviewError = message(e);
  }
}

export function setOverviewWindow(w: string): void {
  S.overviewWindow = w;
  pref.set('overviewWindow', w);
  loadOverview();
}

export async function refresh(): Promise<void> {
  // A global page has no project to poll; a reply for a project that is no longer selected is dropped.
  const project = currentProject();
  if (project === null) return;
  try {
    const data = await api<ApiState>('/api/state');
    if (currentProject() !== project) return;
    // Before the unchanged-poll check: a request that came and went between two polls can leave the rest of the state as it was.
    const pruned = pruneSent(S.sent, data.requests ?? [], data.now);
    if (pruned.resolved.length) {
      S.sent = pruned.sent;
      reportRejected(pruned.resolved);
    }
    // Read before this poll marks the connection good: the first poll after a failed one rebaselines.
    const resumed = S.online === false;
    const now = Date.now();
    S.online = true;
    S.polledAt = new Date(now).toISOString();
    S.error = data.apiVersion > API_VERSION ? 'This data was written by a newer Forge. Restart `forge dash` after updating the plugin.' : null;
    if (S.readyAt === null || resumed) S.readyAt = now;
    const key = JSON.stringify({ ...data, now: undefined });
    if (key !== S.dataKey) {
      // Only a poll whose data changed gets here, so an identical poll never flashes.
      const r = pollChanges(memo, data.jobs, resumed);
      memo = r.memo;
      S.flashes = addFlashes(S.flashes, r.changed, now);
      S.cooling = addFlashes(S.cooling, r.staged, now, 1000);
      S.data = data;
      S.dataKey = key;
    }
    if (S.drawer.id) loadDrawer(false);
  } catch (e) {
    if (currentProject() !== project) return;
    const signedOut = isSignedOutError(errorText(message(e)));
    if (isUnregistered(e) || signedOut) {
      // The server is up; either this project is not registered (a stale link, or `forge project remove` while the page was open)
      // or this browser holds no login cookie (a new profile, or a restart that rotated the key). The board and its actions go,
      // so nothing on screen calls a route that now 404s or 401s; a re-registered or signed-in project rebaselines.
      S.online = true;
      S.error = signedOut ? SIGNED_OUT_MESSAGE : notRegistered(currentProject());
      S.data = null;
      S.dataKey = '';
      S.readyAt = null;
      memo = null;
      closeDrawer();
      return;
    }
    S.online = false;
    S.error = lostConnection(e);
  }
}

export async function loadView(): Promise<void> {
  // A global page has no project views; a reply for a project that is no longer selected is dropped.
  const project = currentProject();
  if (project === null || S.route.scope !== 'project') return;
  const current = (): boolean => currentProject() === project;
  try {
    if (S.view === 'analytics') {
      const stats = await api<Stats>(`/api/stats${statsQuery(S.window, Date.now())}`);
      if (current()) S.stats = stats;
    }
    if (S.view === 'evals') {
      const evals = await api<EvalsResponse>('/api/evals');
      if (current()) S.evals = evals;
    }
    if (S.view === 'agents') {
      const roster = await api<Roster>('/api/roster');
      if (current()) S.roster = roster;
    }
    if (S.view === 'project') {
      // Its own failure is a line in its section, not a toast every 15 s, and never blocks the graph.
      const envs = fetchEnvironments().then(
        (r) => {
          if (!current()) return;
          S.environments = r;
          S.environmentsError = null;
        },
        (e: unknown) => void (current() && (S.environmentsError = message(e))),
      );
      const graph = await api<ProjectResponse>('/api/project');
      if (current()) S.project = graph;
      await envs;
    }
    if (S.view === 'issues') {
      const backlog = await api<BacklogResponse>('/api/backlog');
      if (current()) S.backlog = backlog;
    }
    if (S.view === 'office') await loadMandates();
  } catch (e) {
    // An unregistered project is the Banner's message (the next poll sets it), not a toast of the server's JSON.
    if (current() && !isUnregistered(e)) toast(message(e), true);
  }
}

/**
 * GET /api/mandates into S.mandates for the Office page: on open, on the view poll and after each write. Its failure is
 * the page's banner, not a toast every 15 s; a reply for another project is dropped.
 */
export async function loadMandates(): Promise<void> {
  const project = currentProject();
  if (project === null) return;
  try {
    const r = await fetchMandates();
    if (currentProject() !== project) return;
    S.mandates = r;
    S.mandatesError = null;
  } catch (e) {
    if (currentProject() === project && !isUnregistered(e)) S.mandatesError = message(e);
  }
}

/** GET /api/roster into S.roster, for the status bar's Model popover; the error reaches the caller, which shows it. */
export async function loadRoster(): Promise<void> {
  S.roster = await api<Roster>('/api/roster');
}

/**
 * Shows the page the hash names (lib/shell/routes.ts), rewriting the hash in place when it is not canonical. A route naming
 * another project switches to it; a global page keeps the selected project, and the first one the page shows selects
 * `lastProject`, the project selected when the dashboard was last open (checkSelection drops it if it is gone).
 */
export function route(): void {
  const last = pref.get('lastProject', '') || null;
  const r = parseRoute(location.hash, last);
  if (r.replace !== null) history.replaceState(null, '', r.replace);
  const next = routeProject(r.route) ?? currentProject() ?? last;
  if (next !== currentProject()) switchProject(next);
  S.route = r.route;
  if (r.route.scope === 'project') S.view = r.route.view;
  // Needs you was a page: its old link shows the Pipeline and opens the Needs-you popover (StatusBar does, once it renders).
  if (r.openNeeds) S.openNeeds = true;
  if (r.route.scope === 'global' && r.route.view === 'overview') loadOverview();
  loadView();
}

/**
 * Selects `name` (null for none): the old project's page state goes, its per-project prefs are read again, and the new
 * project loads at once. Nothing is sent to either project's pool: its jobs and sessions keep running on the server.
 */
export function switchProject(name: string | null): void {
  setProject(name);
  S.selected = currentProject();
  pref.set('lastProject', S.selected ?? '');
  closeDrawer();
  S.data = null;
  S.dataKey = '';
  S.error = null;
  S.online = null;
  S.polledAt = null;
  // Its first poll flashes nothing, as a page load.
  S.readyAt = null;
  memo = null;
  S.stats = null;
  S.evals = null;
  S.roster = null;
  S.project = null;
  S.environments = null;
  S.environmentsError = null;
  S.backlog = null;
  S.mandates = null;
  S.mandatesError = null;
  S.compare.a = '';
  S.compare.b = '';
  S.compare.result = null;
  S.drawerView = null;
  S.issueView = null;
  S.flashes = {};
  S.cooling = {};
  S.threadSeen = {};
  S.sent = {};
  S.openNeeds = false;
  S.layout = pref.get('layout', 'board');
  S.filter = pref.get('filter', 'active');
  S.window = pref.get('window', '30');
  refresh();
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

/** Sets the sidebar and keeps it in this browser; the separator calls it once per key press, double-click or drag. */
export function setSidebar(next: SidebarState, save = true): void {
  S.side.width = next.width;
  S.side.compact = next.compact;
  if (!save) return;
  pref.set('sidebarWidth', String(next.width));
  pref.set('sidebarCompact', next.compact ? '1' : '0');
}

export function setWindow(w: string): void {
  S.window = w;
  pref.set('window', w);
  loadView();
}

export async function refreshBacklog(): Promise<void> {
  // A refetch spends the tracker's rate limit, so only this button asks for one.
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
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Queues a request; throws the server's `error` text, so the command bar can keep it in the dialog. */
export const postRequest = (body: RequestBody): Promise<PostRequestResponse> => jsonFetch<PostRequestResponse>('/api/requests', postInit(body));

/** Queues a request and toasts the outcome; resolves the queued request, or null when it failed. */
async function post(body: RequestBody, quiet: boolean): Promise<PostRequestResponse | null> {
  try {
    const r = await postRequest(body);
    if (!quiet) toast(queuedMessage(body.type, r.daemon));
    refresh();
    return r;
  } catch (e) {
    toast(`Request failed: ${message(e)}`, true);
    return null;
  }
}

/** Queues a request and toasts the outcome; resolves whether it was queued. */
export const request = async (body: RequestBody): Promise<boolean> => (await post(body, false)) !== null;

/** Sent decisions that left the queue rejected: the buttons are back, and this toast says why. Done ones need no word, the job moved on. */
async function reportRejected(ids: string[]): Promise<void> {
  const project = currentProject();
  const all = await api<RequestsResponse>('/api/requests').catch(() => null);
  if (!all || currentProject() !== project) return;
  for (const r of all) if (ids.includes(r.id) && r.status === 'rejected') toast(`Forge rejected "${r.type}"${r.result ? `: ${r.result}` : '.'}`, true);
}

/** POST /api/budget/ack: a human acknowledges the current, exceeded month or day. Throws the server's `error` text. */
export const postBudgetAck = (period: string): Promise<PostBudgetAckResponse> => jsonFetch<PostBudgetAckResponse>('/api/budget/ack', postInit({ period }));

/** POST /api/jobs: a new job from free text. Throws the server's `error` text. */
export const createJob = (body: PostJobBody): Promise<PostJobResponse> => jsonFetch<PostJobResponse>('/api/jobs', postInit(body));

/** Fills S.backlog for the command bar's ref completion, once; a failure leaves it empty with the error. */
export async function loadBacklog(): Promise<void> {
  const project = currentProject();
  if (S.backlog || project === null) return;
  const backlog = await api<BacklogResponse>('/api/backlog').catch((e: unknown) => ({ items: [], error: message(e) }));
  if (currentProject() === project) S.backlog = backlog;
}

/**
 * A request button: builds the body as the old `req` handler did, or toasts why not. Null when nothing was sent (the
 * input is invalid), else whether it was queued: a composer clears on send and restores its text only on failure.
 */
export function req(input: RequestInput, label?: string): Promise<boolean> | null {
  const r = buildRequest(input);
  if ('error' in r) {
    toast(r.error, true);
    return null;
  }
  const job = r.body.job;
  // A gate decision (a button with a label): the job's buttons give way to its status line (decision.ts) at once, so
  // nobody presses twice or presses another; the status line says it was queued, so it needs no toast.
  if (!label || !job) return request(r.body);
  S.sent = { ...S.sent, [job]: { label, id: null, at: null } };
  return post(r.body, true).then((q) => {
    const { [job]: mine, ...rest } = S.sent;
    if (mine?.id === null) S.sent = q ? { ...rest, [job]: { label, id: q.id, at: q.createdAt } } : rest;
    return q !== null;
  });
}

/** A job's sent decision, if this tab has one in flight. */
export const sentFor = (job: string): SentDecision | null => S.sent[job] ?? null;

// ---------- settings ----------

/** fetch for JSON endpoints, a project path going to this page's project: errors carry the reply's `error` text, never a raw JSON body. */
async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(projectApi(path), init);
  const text = await res.text();
  if (!res.ok) throw new Error(errorText(text) || res.statusText);
  return JSON.parse(text) as T;
}

export const fetchConfig = (): Promise<ConfigResponse> => jsonFetch<ConfigResponse>('/api/config');

export const postConfig = (key: string, value: ConfigValue): Promise<PostConfigResponse> =>
  jsonFetch<PostConfigResponse>('/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, value } satisfies PostConfigBody),
  });

/** The server runs git and gh for it. */
export const fetchDoctor = (): Promise<DoctorResponse> => jsonFetch<DoctorResponse>('/api/doctor');

/** The support bundle as a blob and the name to save it under: the server runs git and gh and reads job logs for it. */
export async function fetchBundle(): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(projectApi('/api/doctor/bundle'));
  if (!res.ok) throw new Error(errorText(await res.text()) || res.statusText);
  return { blob: await res.blob(), filename: bundleFilename(res.headers.get('content-disposition')) };
}

/** The server runs gh for it, on the login's rate limit. */
export const fetchGitHubPreview = (url: string): Promise<GitHubPreviewResponse> =>
  jsonFetch<GitHubPreviewResponse>(`/api/github/preview?url=${encodeURIComponent(url)}`);

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

/** Opens job `id`'s panel; `back` is the issue ref its Back button returns to (only the issue panel passes one). */
export async function openDrawer(id: string, file: string | null = null, tab: DrawerTab = DEFAULT_DRAWER_TAB, back: string | null = null): Promise<void> {
  S.drawer.issue = null;
  S.drawer.kind = 'job';
  S.drawer.back = back;
  S.drawer.id = id;
  S.drawer.detail = null;
  S.drawer.file = file;
  S.drawer.content = null;
  S.drawer.tab = tab;
  S.drawer.eventsAtOpen = null;
  S.drawer.threadAtOpen = null;
  await loadDrawer(true);
}

/** The job panel's fields back to closed. */
function clearJob(): void {
  S.drawer.id = null;
  S.drawer.detail = null;
  S.drawer.file = null;
  S.drawer.content = null;
  S.drawer.tab = DEFAULT_DRAWER_TAB;
  S.drawer.eventsAtOpen = null;
  S.drawer.threadAtOpen = null;
}

/** Keeps `kind`, drawerView and issueView, so the panel slides out with its content. */
export function closeDrawer(): void {
  clearJob();
  S.drawer.issue = null;
  S.drawer.back = null;
}

/** The server runs the tracker (gh for GitHub) for it, on the login's rate limit. */
export const fetchBacklogItem = (ref: string): Promise<BacklogItemResponse> =>
  jsonFetch<BacklogItemResponse>(`/api/backlog/item?ref=${encodeURIComponent(ref)}`);

/**
 * Opens the issue panel on `ref` and fetches its text. The same ref keeps its last text while it re-fetches, so Back
 * doesn't flash; a reply for an issue or a project no longer shown is dropped.
 */
export async function openIssue(ref: string): Promise<void> {
  clearJob();
  S.drawer.back = null;
  S.drawer.issue = ref;
  S.drawer.kind = 'issue';
  if (S.issueView?.ref !== ref) S.issueView = { ref, data: null, error: null };
  const project = currentProject();
  const current = (): boolean => S.drawer.issue === ref && currentProject() === project;
  try {
    const data = await fetchBacklogItem(ref);
    if (current()) S.issueView = { ref, data, error: null };
  } catch (e) {
    if (current()) S.issueView = { ref, data: null, error: message(e) };
  }
}

/** The job panel's Back button: the issue panel it was opened from. */
export function backToIssue(): void {
  const ref = S.drawer.back;
  if (ref) void openIssue(ref);
}

async function loadDrawer(full: boolean): Promise<void> {
  const id = S.drawer.id;
  const project = currentProject();
  if (!id || project === null) return;
  try {
    const detail = await api<JobDetail>(`/api/jobs/${encodeURIComponent(id)}`);
    if (S.drawer.id !== id || currentProject() !== project) return;
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
    if (currentProject() === project) S.drawerView = { error: message(e) };
  }
}

export async function loadFile(rel: string, rerender = true): Promise<void> {
  const project = currentProject();
  S.drawer.file = rel;
  if (rel.endsWith('.html')) S.drawer.content = { html: true };
  else {
    const text = await api<string>(`/api/jobs/${encodeURIComponent(S.drawer.id ?? '')}/file?path=${encodeURIComponent(rel)}`);
    if (currentProject() !== project) return;
    S.drawer.content = { text };
  }
  if (rerender) renderDrawer();
}

export function setDrawerTab(tab: DrawerTab): void {
  S.drawer.tab = tab;
  renderDrawer();
}
