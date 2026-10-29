// The selected project, which a project page's route sets (`#/p/<project>/…`, app.svelte.ts route()): every per-project
// request goes to `/api/p/<project>/…` through projectApi, while the machine's own `/api/about` and
// `/api/projects` never do. A global page keeps the selection.
import { PROJECT_NAME_SOURCE } from './types.ts';

const PROJECT_NAME = new RegExp(PROJECT_NAME_SOURCE);
/** The machine's own endpoints, which no project prefixes. */
const MACHINE_PATH = /^\/api\/(?:about|projects)(?:[/?#]|$)/;

let current: string | null = null;

/** `?project=` from a location search string, or null when it is absent or empty. */
export function projectFromSearch(search: string): string | null {
  const v = new URLSearchParams(search).get('project');
  return v ? v : null;
}

/** Sets the project every projectApi path names; a name failing PROJECT_NAME sets none. */
export function setProject(name: string | null): void {
  current = name !== null && PROJECT_NAME.test(name) ? name : null;
}

export const currentProject = (): string | null => current;

/**
 * `/api/<rest>` as the current project's `/api/p/<project>/<rest>`. The machine's paths, a path already
 * under `/api/p/` and anything outside `/api/` are returned as they are. Throws with no project set, so a
 * request can never reach a bare project path by accident.
 */
export function projectApi(path: string): string {
  if (!path.startsWith('/api/') || path.startsWith('/api/p/') || MACHINE_PATH.test(path)) return path;
  if (current === null) throw new Error('no project is selected');
  return `/api/p/${current}/${path.slice('/api/'.length)}`;
}

/** The server cuts a name it echoes to 64 characters; so does the page, since a `?project=` can be any text. */
const NAME_SHOWN = 64;

/** The page's line for a project name that is not registered on this machine. */
export const notRegistered = (name: string | null): string => `No registered project "${(name ?? '').slice(0, NAME_SHOWN)}" on this machine.`;

/** True for the error text (not the JSON body) of the server's 404 for a `/api/p/<name>/…` path whose project is not registered. */
export const isNotRegisteredError = (text: string): boolean => text.startsWith('no registered project "');
