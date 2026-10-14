// The colour theme: `data-theme` on <html> (index.html sets it before first paint) and the `theme` pref.
// Touches `document` only inside functions so tests can import it under Node.
import { pref } from './prefs.ts';

export const THEMES = ['cyanotype', 'vellum'] as const;
export type Theme = (typeof THEMES)[number];

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

export const currentTheme = (): Theme => normalizeTheme(document.documentElement.dataset.theme ?? null, false);

export function setTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  pref.set('theme', t);
}
