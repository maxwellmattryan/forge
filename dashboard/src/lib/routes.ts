// The hash router: `#/overview` and `#/machine` (global pages, no project selected) and `#/p/<project>/<view>`. A project
// segment is checked raw, never decoded, against PROJECT_NAME before anything uses it. Old links land on the new routes,
// and a renamed view's old id on its new one (`backlog` is now `issues`).
import { GLOBAL_VIEWS, VIEWS, type GlobalViewId, type ViewId } from './nav.ts';
import { projectFromSearch } from './project.ts';
import { PROJECT_NAME_SOURCE } from './types.ts';

const PROJECT_NAME = new RegExp(PROJECT_NAME_SOURCE);

export type Route = { scope: 'global'; view: GlobalViewId } | { scope: 'project'; project: string; view: ViewId };

export interface ParsedRoute {
  route: Route;
  /** The hash to put in place of the current one with history.replaceState, or null to keep it. */
  replace: string | null;
  /** The route was an inbox link: open the Needs-you popover. */
  openNeeds: boolean;
}

const OVERVIEW: Route = { scope: 'global', view: 'overview' };
const isView = (v: string): v is ViewId => VIEWS.some((x) => x.id === v);
const isGlobalView = (v: string): v is GlobalViewId => GLOBAL_VIEWS.some((x) => x.id === v);
const validName = (name: string | null): name is string => name !== null && PROJECT_NAME.test(name);

const projectRoute = (project: string, view: ViewId): Route => ({ scope: 'project', project, view });
const toOverview: ParsedRoute = { route: OVERVIEW, replace: '#/overview', openNeeds: false };

/** Old view ids, each to the view that replaced it, so printed links and bookmarks keep working. */
const RENAMED_VIEWS: ReadonlyMap<string, ViewId> = new Map([['backlog', 'issues']]);

/**
 * The route a location hash names. `lastProject` (the machine pref) sends an old `#/<view>` or `#/inbox` link to that
 * project's page; anything unknown, and a project segment failing PROJECT_NAME, is the Overview with a rewrite.
 */
export function parseRoute(hash: string, lastProject: string | null): ParsedRoute {
  const h = hash.replace(/^#/, '');
  if (h === '' || h === '/') return { route: OVERVIEW, replace: null, openNeeds: false };
  if (h.startsWith('/p/')) {
    const [name, view, ...extra] = h.slice('/p/'.length).split('/');
    if (!validName(name)) return toOverview;
    const canonical = view !== undefined && isView(view) && !extra.length;
    if (canonical) return { route: projectRoute(name, view), replace: null, openNeeds: false };
    const renamed = view !== undefined && !extra.length ? RENAMED_VIEWS.get(view) : undefined;
    if (renamed !== undefined) return { route: projectRoute(name, renamed), replace: `#/p/${name}/${renamed}`, openNeeds: false };
    return { route: projectRoute(name, 'pipeline'), replace: `#/p/${name}/pipeline`, openNeeds: view === 'inbox' && !extra.length };
  }
  const bare = h.replace(/^\//, '');
  if (h.startsWith('/') && isGlobalView(bare)) return { route: { scope: 'global', view: bare }, replace: null, openNeeds: false };
  const view: ViewId | undefined = bare === 'inbox' ? 'pipeline' : isView(bare) ? bare : RENAMED_VIEWS.get(bare);
  if (view !== undefined) {
    if (!validName(lastProject)) return toOverview;
    return { route: projectRoute(lastProject, view), replace: `#/p/${lastProject}/${view}`, openNeeds: bare === 'inbox' };
  }
  return toOverview;
}

/**
 * The URL a `?project=<name>[#/<view>]` link (what `forge dash`, the README and notify webhooks print) becomes before the
 * app mounts, or null with no `project` parameter. Every query parameter is dropped: the page reads none.
 */
export function entryRedirect(search: string, hash: string): string | null {
  const name = projectFromSearch(search);
  if (name === null) return null;
  if (!validName(name)) return `/${hash}`;
  const h = hash.replace(/^#/, '');
  if (h === '' || h === '/') return `/#/p/${name}/pipeline`;
  if (h.startsWith('/p/') || isGlobalView(h.slice(1))) return `/${hash}`;
  const bare = h.replace(/^\//, '');
  if (isView(bare) || bare === 'inbox') return `/#/p/${name}/${bare}`;
  const renamed = RENAMED_VIEWS.get(bare);
  if (renamed !== undefined) return `/#/p/${name}/${renamed}`;
  return `/#/p/${name}/pipeline`;
}

/** Where choosing project `name` goes: the same view from a project page, its Pipeline from a global page. */
export const switchHash = (name: string, route: Route): string => `#/p/${name}/${route.scope === 'project' ? route.view : 'pipeline'}`;

/** The route's selected project; null on a global page. */
export const routeProject = (route: Route): string | null => (route.scope === 'project' ? route.project : null);
