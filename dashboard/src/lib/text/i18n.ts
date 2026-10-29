// The dashboard's message lookup: plain functions over JSON catalogs, so node:test can pin them.
// No svelte import; locale.ts wraps translate in the `t` store components read as $t.

/** The catalog every other locale falls back to. */
export const SOURCE_LOCALE = 'en';

/** A message with plural forms, picked by Intl.PluralRules on `params.count`. */
export interface Plural {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

/** A nested message catalog: messages/<locale>/*.json, merged by mergeCatalogs. */
export interface Catalog {
  [key: string]: string | Plural | Catalog;
}

/** One catalog from per-area parts keyed by file name. A top-level key in two parts throws, naming both. */
export function mergeCatalogs(parts: Record<string, Catalog>): Catalog {
  const out: Catalog = {};
  const owner = new Map<string, string>();
  for (const name of Object.keys(parts).sort()) {
    for (const [key, value] of Object.entries(parts[name])) {
      const first = owner.get(key);
      if (first !== undefined) throw new Error(`message key "${key}" is in both ${first} and ${name}`);
      owner.set(key, name);
      out[key] = value;
    }
  }
  return out;
}

export type Params = Record<string, string | number | null | undefined>;

const CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

/** A plural object: `other` and only plural categories, all strings. */
export function isPlural(v: unknown): v is Plural {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const entries = Object.entries(v);
  return typeof (v as Plural).other === 'string' && entries.every(([k, x]) => CATEGORIES.has(k) && typeof x === 'string');
}

function lookup(catalog: Catalog | undefined, key: string): string | Plural | undefined {
  let v: unknown = catalog;
  for (const part of key.split('.')) {
    if (!v || typeof v !== 'object' || isPlural(v) || !Object.hasOwn(v, part)) return undefined;
    v = (v as Catalog)[part];
  }
  return typeof v === 'string' || isPlural(v) ? v : undefined;
}

/**
 * The message for `key` in `locale`, else in the source catalog, else the key itself. `{name}`
 * placeholders are filled from `params`; unknown ones stay as written.
 */
export function translate(locale: string, catalogs: Record<string, Catalog>, key: string, params?: Params): string {
  let found = lookup(catalogs[locale], key);
  let lang = locale;
  if (found === undefined) {
    found = lookup(catalogs[SOURCE_LOCALE], key);
    lang = SOURCE_LOCALE;
  }
  if (found === undefined) return key;
  let text: string;
  if (typeof found === 'string') text = found;
  else {
    let cat = 'other';
    try {
      cat = new Intl.PluralRules(lang).select(Number(params?.count));
    } catch {}
    text = found[cat as keyof Plural] ?? found.other;
  }
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (params && Object.hasOwn(params, name) ? String(params[name]) : m));
}

/** The saved locale when it has a catalog, else the first preferred one whose base language does, else the source. */
export function pickLocale(saved: string | null | undefined, preferred: readonly string[], available: readonly string[]): string {
  if (saved && available.includes(saved)) return saved;
  for (const p of preferred) {
    if (available.includes(p)) return p;
    const base = p.split('-')[0].toLowerCase();
    if (available.includes(base)) return base;
  }
  return SOURCE_LOCALE;
}
