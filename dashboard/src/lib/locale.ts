/// <reference types="vite/client" />
// The locale store layer over src/lib/i18n.ts. `t` is a store because Svelte 5 reserves the `$` prefix
// for runes and store subscriptions: components import it and write $t('nav.pipeline'). The en catalog is
// every file in messages/en/, merged by mergeCatalogs, so a new area file needs no edit here.
import { derived, writable } from 'svelte/store';
import { mergeCatalogs, pickLocale, translate, type Catalog, type Params } from './i18n.ts';
import { pref } from './prefs.ts';

const EN = import.meta.glob<Catalog>('../messages/en/*.json', { eager: true, import: 'default' });
export const CATALOGS: Record<string, Catalog> = { en: mergeCatalogs(EN) };

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
