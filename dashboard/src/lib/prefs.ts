// UI preferences in localStorage: the machine's as `forge.<key>`, every other one per project as `forge.p/<project>/<key>`.
// A project pref with no value of its own reads the old unscoped `forge.<key>`. Storage can be absent or throw (private mode).
import { currentProject } from './project.ts';
import { PROJECT_NAME_SOURCE } from './types.ts';

const PROJECT_NAME = new RegExp(PROJECT_NAME_SOURCE);

/**
 * Shared by every project: the appearance, the shell's own layout, and the route's memory. index.html's inline theme
 * script reads `forge.theme`, `forge.grain` and `forge.screen` directly. The Rendered/Raw choices (`mdView.*`) are read
 * once at load, before any project is selected, so they are the machine's too.
 */
export const MACHINE_PREFS: ReadonlySet<string> = new Set([
  'theme',
  'grain',
  'screen',
  'locale',
  'sidebarWidth',
  'sidebarCompact',
  'paneWidth',
  'settingsTab',
  'lastProject',
  'overviewWindow',
  'mdView.files',
  'mdView.thread',
  'mdView.session',
  'mdView.chat',
]);

/** The storage key for `key` under `project`; null for a project pref with no valid project selected. */
export function prefKey(key: string, project: string | null): string | null {
  if (MACHINE_PREFS.has(key)) return `forge.${key}`;
  return project !== null && PROJECT_NAME.test(project) ? `forge.p/${project}/${key}` : null;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export const pref = {
  get(k: string, d: string): string {
    const key = prefKey(k, currentProject());
    return (key === null ? null : read(key)) ?? read(`forge.${k}`) ?? d;
  },
  /** Writes only the selected project's key for a project pref; with no project selected, nothing. */
  set(k: string, v: string): void {
    const key = prefKey(k, currentProject());
    if (key === null) return;
    try {
      localStorage.setItem(key, v);
    } catch {}
  },
  /** Writes `project`'s key for a project pref, whichever project is selected (the Overview's waiting link); an invalid name writes nothing. */
  setFor(project: string, k: string, v: string): void {
    const key = prefKey(k, project);
    if (key === null) return;
    try {
      localStorage.setItem(key, v);
    } catch {}
  },
};
