// The project this page serves, from `?project=` (read once before the app mounts): every per-project
// request goes to `/api/p/<project>/…` through projectApi, while the machine's own `/api/about` and
// `/api/projects` never do. pickProject decides what a page without a usable project does until the
// Overview (#402) and the project routes (#401) replace this.
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

export type ProjectPick = { use: string } | { redirect: string } | { error: 'none' | 'invalid' };

/**
 * What a page does with `?project=` (`fromUrl`) and the loaded projects' names: keep a valid name, go
 * to the first loaded project by name when there is none, or report that nothing is loaded (`none`) or
 * that the name can't be a project (`invalid`).
 */
export function pickProject(fromUrl: string | null, loaded: readonly string[]): ProjectPick {
  if (fromUrl !== null) return PROJECT_NAME.test(fromUrl) ? { use: fromUrl } : { error: 'invalid' };
  const first = [...loaded].sort()[0];
  return first === undefined ? { error: 'none' } : { redirect: first };
}
