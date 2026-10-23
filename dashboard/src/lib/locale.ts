// The locale store layer over src/lib/i18n.ts. `t` is a store because Svelte 5 reserves the `$` prefix
// for runes and store subscriptions: components import it and write $t('nav.pipeline').
import { derived, writable } from 'svelte/store';
import en from '../messages/en.json';
import { pickLocale, translate, type Catalog, type Params } from './i18n.ts';
import { pref } from './prefs.ts';

export const CATALOGS: Record<string, Catalog> = { en };

const languages = (): readonly string[] => (typeof navigator === 'undefined' ? [] : (navigator.languages ?? []));

export const locale = writable(pickLocale(pref.get('locale', ''), languages(), Object.keys(CATALOGS)));

export const t = derived(locale, (l) => (key: string, params?: Params) => translate(l, CATALOGS, key, params));

export function setLocale(l: string): void {
  locale.set(l);
  pref.set('locale', l);
}

locale.subscribe((l) => {
  if (typeof document !== 'undefined') document.documentElement.lang = l;
});
