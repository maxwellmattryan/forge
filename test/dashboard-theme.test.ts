// Theme ids: cyanotype (default) and vellum, with the pre-Drafting ids still honoured. The inline
// bootstrap in index.html duplicates normalizeTheme (it runs before the bundle), so both are run
// over the same inputs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { THEMES, normalizeTheme, setTheme, currentTheme, themeChoice, chooseTheme, followSystemTheme, DRAWINGS, drawingOn, currentDrawing, setDrawing } from '../dashboard/src/lib/theme.ts';

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
  // System is stored explicitly and follows the OS, like an unset value.
  ['system', false, 'cyanotype'],
  ['system', true, 'vellum'],
];

test('normalizeTheme maps legacy and new ids', () => {
  assert.deepEqual([...THEMES], ['cyanotype', 'vellum']);
  for (const [saved, light, want] of CASES) assert.equal(normalizeTheme(saved, light), want, `(${saved}, ${light})`);
  assert.equal(normalizeTheme(undefined, false), 'cyanotype');
});

/** Runs the inline <script> of an index.html with stubbed storage, media query and document. */
function runBootstrap(html: string, store: Record<string, string | null>, light: boolean): { dataset: Record<string, string>; writes: string[] } {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, 'one inline script');
  const writes: string[] = [];
  const dataset: Record<string, string> = {};
  const context = vm.createContext({
    localStorage: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string) => writes.push(k),
      removeItem: (k: string) => writes.push(k),
    },
    matchMedia: (q: string) => ({ matches: q === '(prefers-color-scheme: light)' ? light : false }),
    document: { documentElement: { dataset } },
  });
  vm.runInContext(scripts[0], context);
  return { dataset, writes };
}

const DRAWING_VALUES = [null, 'on', 'off', 'bogus'];

test('index.html inline script agrees with normalizeTheme', () => {
  const sources = { 'dashboard/index.html': fs.readFileSync(path.join(ROOT, 'dashboard', 'index.html'), 'utf8'), 'dashboard/dist/index.html': fs.readFileSync(path.join(ROOT, 'dashboard', 'dist', 'index.html'), 'utf8') };
  for (const [name, html] of Object.entries(sources)) {
    assert.match(html, /<html lang="en" data-theme="cyanotype">/, `${name} defaults to cyanotype before the script runs`);
    for (const [saved, light, want] of CASES) {
      for (const grid of DRAWING_VALUES) {
        for (const paper of DRAWING_VALUES) {
          const { dataset, writes } = runBootstrap(html, { 'forge.theme': saved, 'forge.grid': grid, 'forge.paper': paper }, light);
          const at = `${name} (${saved}, ${light}, grid ${grid}, paper ${paper})`;
          assert.equal(dataset.theme, normalizeTheme(saved, light), at);
          assert.equal(dataset.theme, want, at);
          assert.equal(dataset.grid, drawingOn(grid) ? 'on' : 'off', at);
          assert.equal(dataset.paper, drawingOn(paper) ? 'on' : 'off', at);
          assert.deepEqual(writes, [], 'loading the page never rewrites a pref');
        }
      }
    }
    // Storage that throws (some private modes) sets nothing, so the CSS defaults apply: grid and paper on.
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const dataset: Record<string, string> = {};
    const boom = () => {
      throw new Error('denied');
    };
    vm.runInContext(scripts[0], vm.createContext({ localStorage: { getItem: boom }, matchMedia: () => ({ matches: false }), document: { documentElement: { dataset } } }));
    assert.deepEqual(dataset, {}, `${name}: throwing storage leaves <html> as shipped`);
  }
});

/** Swaps globals by descriptor (reading Node's own localStorage getter warns) and restores them after `fn`. */
function withGlobals(values: Record<string, unknown>, fn: () => void): void {
  const g = globalThis as any;
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]));
  for (const [k, value] of Object.entries(values)) Object.defineProperty(g, k, { value, configurable: true, writable: true });
  try {
    fn();
  } finally {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  }
}

/** A matchMedia stub whose light query can be flipped, recording its listeners. */
function fakeMedia(light: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const added: unknown[] = [];
  const removed: unknown[] = [];
  const mq = {
    get matches() {
      return light;
    },
    addEventListener: (type: string, fn: (e: { matches: boolean }) => void) => {
      assert.equal(type, 'change');
      added.push(fn);
      listeners.add(fn);
    },
    removeEventListener: (type: string, fn: (e: { matches: boolean }) => void) => {
      assert.equal(type, 'change');
      removed.push(fn);
      listeners.delete(fn);
    },
  };
  return {
    matchMedia: (q: string) => {
      assert.equal(q, '(prefers-color-scheme: light)');
      return mq;
    },
    flip(next: boolean) {
      light = next;
      for (const fn of [...listeners]) fn({ matches: next });
    },
    added,
    removed,
  };
}

test('themeChoice maps saved values to a choice', () => {
  for (const v of ['cyanotype', 'dark']) assert.equal(themeChoice(v), 'cyanotype', v);
  for (const v of ['vellum', 'light']) assert.equal(themeChoice(v), 'vellum', v);
  for (const v of [null, undefined, '', 'system', 'bogus', 'Cyanotype']) assert.equal(themeChoice(v), 'system', String(v));
  // System renders what an unset value always has: the OS theme.
  for (const light of [false, true]) assert.equal(normalizeTheme('system', light), normalizeTheme(null, light));
});

test('chooseTheme and followSystemTheme apply the choice', () => {
  const store = new Map<string, string>();
  const dataset: Record<string, string> = { theme: 'cyanotype' };
  const media = fakeMedia(true);
  withGlobals(
    {
      document: { documentElement: { dataset } },
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
      matchMedia: media.matchMedia,
    },
    () => {
      chooseTheme('system');
      assert.equal(store.get('forge.theme'), 'system', 'System is stored explicitly');
      assert.equal(dataset.theme, 'vellum', 'System renders the OS theme');
      chooseTheme('cyanotype');
      assert.equal(store.get('forge.theme'), 'cyanotype');
      assert.equal(dataset.theme, 'cyanotype');

      const stop = followSystemTheme();
      assert.equal(media.added.length, 1, 'one change listener');
      media.flip(false);
      assert.equal(dataset.theme, 'cyanotype', 'an explicit choice ignores the OS');
      media.flip(true);
      assert.equal(dataset.theme, 'cyanotype');

      chooseTheme('system');
      assert.equal(dataset.theme, 'vellum');
      media.flip(false);
      assert.equal(dataset.theme, 'cyanotype', 'System follows a live OS change to dark');
      media.flip(true);
      assert.equal(dataset.theme, 'vellum', 'and back to light');

      // A legacy or unknown saved value counts as System too.
      store.set('forge.theme', 'bogus');
      media.flip(false);
      assert.equal(dataset.theme, 'cyanotype');
      store.set('forge.theme', 'light');
      media.flip(false);
      assert.equal(dataset.theme, 'cyanotype', 'legacy light is an explicit vellum choice, so the listener leaves it');

      stop();
      assert.deepEqual(media.removed, media.added, 'the unsubscribe removes the same listener');
      store.set('forge.theme', 'system');
      media.flip(true);
      assert.equal(dataset.theme, 'cyanotype', 'nothing follows after unsubscribing');
    },
  );
  withGlobals(
    {
      matchMedia: () => {
        throw new Error('no media queries');
      },
    },
    () => {
      const stop = followSystemTheme();
      assert.equal(typeof stop, 'function', 'a throwing matchMedia still returns an unsubscribe');
      stop();
    },
  );
});

test('drawing prefs default on and write attribute and pref', () => {
  assert.deepEqual([...DRAWINGS], ['grid', 'paper']);
  assert.equal(drawingOn('off'), false);
  for (const v of [null, undefined, '', 'on', 'bogus', 'OFF']) assert.equal(drawingOn(v), true, String(v));
  const store = new Map<string, string>();
  const dataset: Record<string, string> = {};
  withGlobals(
    {
      document: { documentElement: { dataset } },
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
    },
    () => {
      for (const k of DRAWINGS) {
        assert.equal(currentDrawing(k), true, `${k}: an absent attribute counts as on`);
        setDrawing(k, false);
        assert.equal(dataset[k], 'off');
        assert.equal(store.get(`forge.${k}`), 'off');
        assert.equal(currentDrawing(k), false);
        setDrawing(k, true);
        assert.equal(dataset[k], 'on');
        assert.equal(store.get(`forge.${k}`), 'on');
        assert.equal(currentDrawing(k), true);
      }
      setDrawing('grid', false);
      assert.equal(dataset.paper, 'on', 'each drawing is its own key');
      assert.deepEqual([...store.keys()].sort(), ['forge.grid', 'forge.paper'], 'drawing prefs never touch the theme');
    },
  );
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
