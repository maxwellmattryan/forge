// Appearance: <html>'s `data-theme`, `data-grain` and `data-screen` (index.html sets them before first paint) and
// their `theme`, `grain` and `screen` prefs. Per browser, never in config.yml.
// Touches `document` and `matchMedia` only inside functions so tests can import it under Node.
import { pref } from './prefs.ts';

/** The six themes: forge (the default), ash (light), and the dark temper, crucible, patina and obsidian. */
export const THEMES = ['forge', 'ash', 'temper', 'crucible', 'patina', 'obsidian'] as const;
export type Theme = (typeof THEMES)[number];

/** What Settings › General offers: the six themes, or follow the OS. */
export const THEME_CHOICES = [...THEMES, 'system'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

const LIGHT_QUERY = '(prefers-color-scheme: light)';

/** The themes System never picks: they show only when chosen, by their exact lower-case id. */
const CHOSEN_ONLY = ['temper', 'crucible', 'patina', 'obsidian'] as const;
const chosenOnly = (saved: string | null | undefined): saved is (typeof CHOSEN_ONLY)[number] => (CHOSEN_ONLY as readonly string[]).includes(saved ?? '');

/** What System shows on a dark OS (a light OS gets ash). System never picks temper, crucible, patina or obsidian. */
export const SYSTEM_DARK: Theme = 'forge';

/**
 * The theme to show for a saved `forge.theme` value. The ids of earlier looks still work: the Drafting
 * `cyanotype` and `nightprint` and the older `dark` load as forge, `vellum` and `light` as ash, and `temper`, `crucible`,
 * `patina` and `obsidian` are themselves; anything else (`Temper` or `PATINA` in the wrong case included) counts as unset
 * and follows the OS: light → ash, dark → forge. The saved value itself is never rewritten.
 * index.html's inline script duplicates this mapping because it runs before the bundle;
 * a test keeps the two in step (being rewritten from docs/test-rewrite/modules/dashboard.ui.md).
 */
export function normalizeTheme(saved: string | null | undefined, prefersLight: boolean): Theme {
  if (saved === 'forge' || saved === 'cyanotype' || saved === 'dark' || saved === 'nightprint') return 'forge';
  if (saved === 'ash' || saved === 'vellum' || saved === 'light') return 'ash';
  if (chosenOnly(saved)) return saved;
  return prefersLight ? 'ash' : SYSTEM_DARK;
}

/** The choice a saved value stands for: an unset or unknown value already follows the OS, so it shows as System. */
export function themeChoice(saved: string | null | undefined): ThemeChoice {
  if (saved === 'forge' || saved === 'cyanotype' || saved === 'dark' || saved === 'nightprint') return 'forge';
  if (saved === 'ash' || saved === 'vellum' || saved === 'light') return 'ash';
  if (chosenOnly(saved)) return saved;
  return 'system';
}

export function prefersLight(): boolean {
  try {
    return matchMedia(LIGHT_QUERY).matches;
  } catch {
    return false;
  }
}

/** The theme on <html>; a missing or unknown attribute is what the CSS shows then, the `:root` default. */
export function currentTheme(): Theme {
  const v = document.documentElement.dataset.theme;
  return (THEMES as readonly string[]).includes(v ?? '') ? (v as Theme) : 'forge';
}

export function setTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  pref.set('theme', t);
}

export function chooseTheme(c: ThemeChoice): void {
  pref.set('theme', c);
  document.documentElement.dataset.theme = normalizeTheme(c, prefersLight());
}

/** Re-applies the OS theme when it changes while the choice is System. Returns the unsubscribe. */
export function followSystemTheme(): () => void {
  let mq: MediaQueryList;
  try {
    mq = matchMedia(LIGHT_QUERY);
  } catch {
    return () => {};
  }
  const onChange = (e: MediaQueryListEvent): void => {
    if (themeChoice(pref.get('theme', '')) === 'system') document.documentElement.dataset.theme = normalizeTheme(null, e.matches);
  };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/**
 * Whether the film grain shows: on unless `forge.grain` says `off`. An unset grain takes the Drafting `forge.paper`
 * pref it replaces, so a ground someone turned plain stays plain; the old `forge.grid` has nothing to map to.
 */
export const grainOn = (grain: string | null | undefined, paper?: string | null): boolean => (grain === null || grain === undefined ? paper !== 'off' : grain !== 'off');

export const currentGrain = (): boolean => document.documentElement.dataset.grain !== 'off';

export function setGrain(on: boolean): void {
  const v = on ? 'on' : 'off';
  document.documentElement.dataset.grain = v;
  pref.set('grain', v);
}

/** Whether a session log's screen draws its scanlines and glow (`forge.screen`): on unless it says `off`. */
export const screenOn = (v: string | null | undefined): boolean => v !== 'off';

export const currentScreen = (): boolean => document.documentElement.dataset.screen !== 'off';

export function setScreen(on: boolean): void {
  const v = on ? 'on' : 'off';
  document.documentElement.dataset.screen = v;
  pref.set('screen', v);
}
