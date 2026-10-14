// Theme ids: cyanotype (default) and vellum, with the pre-Drafting ids still honoured. The inline
// bootstrap in index.html duplicates normalizeTheme (it runs before the bundle), so both are run
// over the same inputs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { THEMES, normalizeTheme, setTheme, currentTheme } from '../dashboard/src/lib/theme.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CASES: [string | null, boolean, string][] = [
  ['cyanotype', false, 'cyanotype'],
  ['cyanotype', true, 'cyanotype'],
  ['dark', false, 'cyanotype'],
  ['dark', true, 'cyanotype'],
  [null, false, 'cyanotype'],
  ['bogus', false, 'cyanotype'],
  ['vellum', false, 'vellum'],
  ['vellum', true, 'vellum'],
  ['light', false, 'vellum'],
  ['light', true, 'vellum'],
  [null, true, 'vellum'],
  ['bogus', true, 'vellum'],
  ['', false, 'cyanotype'],
  ['', true, 'vellum'],
];

test('normalizeTheme maps legacy and new ids', () => {
  assert.deepEqual([...THEMES], ['cyanotype', 'vellum']);
  for (const [saved, light, want] of CASES) assert.equal(normalizeTheme(saved, light), want, `(${saved}, ${light})`);
  assert.equal(normalizeTheme(undefined, false), 'cyanotype');
});

/** Runs the inline <script> of an index.html with stubbed storage, media query and document. */
function runBootstrap(html: string, saved: string | null, light: boolean): { theme: string | undefined; writes: string[] } {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, 'one inline script');
  const writes: string[] = [];
  const dataset: Record<string, string> = {};
  const context = vm.createContext({
    localStorage: {
      getItem: (k: string) => (k === 'forge.theme' ? saved : null),
      setItem: (k: string) => writes.push(k),
      removeItem: (k: string) => writes.push(k),
    },
    matchMedia: (q: string) => ({ matches: q === '(prefers-color-scheme: light)' ? light : false }),
    document: { documentElement: { dataset } },
  });
  vm.runInContext(scripts[0], context);
  return { theme: dataset.theme, writes };
}

test('index.html inline script agrees with normalizeTheme', () => {
  const sources = { 'dashboard/index.html': fs.readFileSync(path.join(ROOT, 'dashboard', 'index.html'), 'utf8'), 'dashboard/dist/index.html': fs.readFileSync(path.join(ROOT, 'dashboard', 'dist', 'index.html'), 'utf8') };
  for (const [name, html] of Object.entries(sources)) {
    assert.match(html, /<html lang="en" data-theme="cyanotype">/, `${name} defaults to cyanotype before the script runs`);
    for (const [saved, light, want] of CASES) {
      const { theme, writes } = runBootstrap(html, saved, light);
      assert.equal(theme, normalizeTheme(saved, light), `${name} (${saved}, ${light})`);
      assert.equal(theme, want);
      assert.deepEqual(writes, [], 'loading the page never rewrites the pref');
    }
  }
});

test('setTheme writes the new id', () => {
  const g = globalThis as any;
  // Swap the descriptors, not the values: reading Node's own localStorage getter warns.
  const saved = { document: Object.getOwnPropertyDescriptor(g, 'document'), localStorage: Object.getOwnPropertyDescriptor(g, 'localStorage') };
  const put = (k: string, value: unknown) => Object.defineProperty(g, k, { value, configurable: true, writable: true });
  const store = new Map<string, string>([['forge.theme', 'dark']]);
  const dataset: Record<string, string> = { theme: 'cyanotype' };
  put('document', { documentElement: { dataset } });
  put('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
  try {
    assert.equal(currentTheme(), 'cyanotype');
    setTheme('vellum');
    assert.equal(store.get('forge.theme'), 'vellum');
    assert.equal(dataset.theme, 'vellum');
    assert.equal(currentTheme(), 'vellum');
    setTheme('cyanotype');
    assert.equal(store.get('forge.theme'), 'cyanotype');
    assert.equal(dataset.theme, 'cyanotype');
  } finally {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  }
});
