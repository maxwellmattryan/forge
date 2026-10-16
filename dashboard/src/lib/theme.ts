// Appearance: <html>'s `data-theme` and `data-grain` (index.html sets them before first paint) and their `theme`
// and `grain` prefs. Per browser, never in config.yml.
// Touches `document` and `matchMedia` only inside functions so tests can import it under Node.
import { pref } from './prefs.ts';

export const THEMES = ['forge', 'ash'] as const;
export type Theme = (typeof THEMES)[number];

/** What Settings › General offers: the two themes, or follow the OS. */
export const THEME_CHOICES = [...THEMES, 'system'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

const LIGHT_QUERY = '(prefers-color-scheme: light)';

/** What System shows on a dark OS (a light OS gets ash). */
export const SYSTEM_DARK: Theme = 'forge';

/**
 * The theme to show for a saved `forge.theme` value. The ids of earlier looks still work: the Drafting
 * `cyanotype` and `nightprint` and the older `dark` load as forge, `vellum` and `light` as ash; anything else
 * counts as unset and follows the OS: light → ash, dark → forge. The saved value itself is never rewritten.
 * index.html's inline script duplicates this mapping because it runs before the bundle;
 * test/dashboard-theme.test.ts keeps the two in step.
 */
export function normalizeTheme(saved: string | null | undefined, prefersLight: boolean): Theme {
  if (saved === 'forge' || saved === 'cyanotype' || saved === 'dark' || saved === 'nightprint') return 'forge';
  if (saved === 'ash' || saved === 'vellum' || saved === 'light') return 'ash';
  return prefersLight ? 'ash' : SYSTEM_DARK;
}

/** The choice a saved value stands for: an unset or unknown value already follows the OS, so it shows as System. */
export function themeChoice(saved: string | null | undefined): ThemeChoice {
  if (saved === 'forge' || saved === 'cyanotype' || saved === 'dark' || saved === 'nightprint') return 'forge';
  if (saved === 'ash' || saved === 'vellum' || saved === 'light') return 'ash';
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
