// Appearance: <html>'s `data-theme`, `data-grid` and `data-paper` (index.html sets them before first
// paint) and their `theme`, `grid` and `paper` prefs. Per browser, never in config.yml.
// Touches `document` and `matchMedia` only inside functions so tests can import it under Node.
import { pref } from './prefs.ts';

export const THEMES = ['cyanotype', 'vellum'] as const;
export type Theme = (typeof THEMES)[number];

/** What Settings › General offers: the two themes, or follow the OS. */
export const THEME_CHOICES = ['cyanotype', 'vellum', 'system'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

const LIGHT_QUERY = '(prefers-color-scheme: light)';

/**
 * The theme to show for a saved `forge.theme` value. The legacy ids from before the Drafting
 * themes still work (`dark` → cyanotype, `light` → vellum); anything else counts as unset and
 * falls back to the OS preference. index.html's inline script duplicates this mapping because it
 * runs before the bundle; test/dashboard-theme.test.ts keeps the two in step.
 */
export function normalizeTheme(saved: string | null | undefined, prefersLight: boolean): Theme {
  if (saved === 'cyanotype' || saved === 'dark') return 'cyanotype';
  if (saved === 'vellum' || saved === 'light') return 'vellum';
  return prefersLight ? 'vellum' : 'cyanotype';
}

/** The choice a saved value stands for: an unset or unknown value already follows the OS, so it shows as System. */
export function themeChoice(saved: string | null | undefined): ThemeChoice {
  if (saved === 'cyanotype' || saved === 'dark') return 'cyanotype';
  if (saved === 'vellum' || saved === 'light') return 'vellum';
  return 'system';
}

export function prefersLight(): boolean {
  try {
    return matchMedia(LIGHT_QUERY).matches;
  } catch {
    return false;
  }
}

export const currentTheme = (): Theme => normalizeTheme(document.documentElement.dataset.theme ?? null, false);

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

/** The ground's two drawing layers, each on unless its pref says `off`. */
export const DRAWINGS = ['grid', 'paper'] as const;
export type Drawing = (typeof DRAWINGS)[number];

export const drawingOn = (saved: string | null | undefined): boolean => saved !== 'off';

export const currentDrawing = (k: Drawing): boolean => drawingOn(document.documentElement.dataset[k]);

export function setDrawing(k: Drawing, on: boolean): void {
  const v = on ? 'on' : 'off';
  document.documentElement.dataset[k] = v;
  pref.set(k, v);
}
