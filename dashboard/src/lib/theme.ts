// The colour theme: `data-theme` on <html> (index.html sets it before first paint) and the `theme` pref.
import { pref } from './prefs.ts';

export type Theme = 'light' | 'dark';

export const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

export function setTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  pref.set('theme', t);
}
