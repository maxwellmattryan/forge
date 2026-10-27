// The Add project dialog's logic: the body it posts to POST /api/projects, where the server's reply leads, and the POST.
import { post } from './focus.ts';
import { entryOf } from './switcher.ts';
import { PROJECT_NAME_SOURCE, type PostProjectBody, type PostProjectResponse } from './types.ts';

const PROJECT_NAME = new RegExp(PROJECT_NAME_SOURCE);
/** An absolute path on the machine running forge dash: POSIX, or a Windows drive or UNC path. */
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/** The message key of a field the server would refuse; each names the field it shows under. */
export type AddProjectError = 'pathRequired' | 'pathRelative' | 'nameInvalid';

/**
 * The POST body from the two fields, trimmed, or the first field's problem. Only an absolute path, `~` or `~/…` is sent,
 * since the server resolves nothing against its own cwd; a blank name is left out, so the server takes the default.
 */
export function addProjectBody(path: string, name: string): { body: PostProjectBody } | { error: AddProjectError } {
  const p = path.trim();
  const n = name.trim();
  if (!p) return { error: 'pathRequired' };
  if (!ABSOLUTE.test(p) && p !== '~' && !p.startsWith('~/')) return { error: 'pathRelative' };
  if (n && !PROJECT_NAME.test(n)) return { error: 'nameInvalid' };
  return { body: n ? { path: p, name: n } : { path: p } };
}

export type AddProjectOutcome = { kind: 'open'; hash: string; added: boolean } | { kind: 'unavailable'; name: string };

/** Where a registration leads: the project's Project page when the dashboard can open it, else the unavailable notice. */
export function addProjectOutcome(r: PostProjectResponse): AddProjectOutcome {
  const p = r.project;
  if (p && entryOf(p).openable) return { kind: 'open', hash: `#/p/${p.name}/project`, added: r.added };
  return { kind: 'unavailable', name: typeof p?.name === 'string' ? p.name : '' };
}

/** POST /api/projects, the machine's own path (projectApi leaves it bare). */
export const postProject = (body: PostProjectBody, fetchImpl: typeof fetch = fetch): Promise<PostProjectResponse> =>
  post<PostProjectResponse>('/api/projects', body, fetchImpl);
