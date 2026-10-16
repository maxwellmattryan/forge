// Theme ids: forge (default), ash and temper, with the Drafting and pre-Drafting ids still honoured (cyanotype, nightprint
// and dark load as forge; vellum and light as ash). System follows the OS: light → ash, dark → forge, and never picks temper. The inline
// bootstrap in index.html duplicates normalizeTheme (it runs before the bundle), so both are run
// over the same inputs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { THEMES, THEME_CHOICES, SYSTEM_DARK, normalizeTheme, setTheme, currentTheme, themeChoice, chooseTheme, followSystemTheme, grainOn, currentGrain, setGrain } from '../dashboard/src/lib/theme.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CASES: [string | null, boolean, string][] = [
  ['forge', false, 'forge'],
  ['forge', true, 'forge'],
  ['ash', false, 'ash'],
  ['ash', true, 'ash'],
  ['temper', false, 'temper'],
  ['temper', true, 'temper'],
  ['cyanotype', false, 'forge'],
  ['cyanotype', true, 'forge'],
  ['nightprint', false, 'forge'],
  ['nightprint', true, 'forge'],
  ['dark', false, 'forge'],
  ['dark', true, 'forge'],
  ['vellum', false, 'ash'],
  ['vellum', true, 'ash'],
  ['light', false, 'ash'],
  ['light', true, 'ash'],
  [null, false, 'forge'],
  [null, true, 'ash'],
  ['bogus', false, 'forge'],
  ['bogus', true, 'ash'],
  ['', false, 'forge'],
  ['', true, 'ash'],
  ['Forge', true, 'ash'],
  ['Temper', false, 'forge'],
  ['Temper', true, 'ash'],
  ['system', false, 'forge'],
  ['system', true, 'ash'],
];

test('normalizeTheme maps legacy and new ids', () => {
  assert.deepEqual([...THEMES], ['forge', 'ash', 'temper']);
  assert.deepEqual([...THEME_CHOICES], ['forge', 'ash', 'temper', 'system']);
  assert.equal(SYSTEM_DARK, 'forge');
  for (const [saved, light, want] of CASES) assert.equal(normalizeTheme(saved, light), want, `(${saved}, ${light})`);
  assert.equal(normalizeTheme(undefined, false), 'forge');
  for (const saved of [null, undefined, '', 'bogus', 'Temper', 'TEMPER', 'system']) for (const light of [false, true]) assert.notEqual(normalizeTheme(saved, light), 'temper', `System never resolves to temper (${saved}, ${light})`);
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
    assert.match(html, /<html lang="en" data-theme="forge">/, `${name} defaults to forge before the script runs`);
    assert.doesNotMatch(html, /data-(grid|paper)|dataset\.(grid|paper)/, `${name} sets no Drafting drawing attribute`);
    for (const [saved, light, want] of CASES) {
      for (const grain of DRAWING_VALUES) {
        for (const paper of DRAWING_VALUES) {
          const { dataset, writes } = runBootstrap(html, { 'forge.theme': saved, 'forge.grain': grain, 'forge.paper': paper, 'forge.grid': 'off' }, light);
          const at = `${name} (${saved}, ${light}, grain ${grain}, paper ${paper})`;
          assert.equal(dataset.theme, normalizeTheme(saved, light), at);
          assert.equal(dataset.theme, want, at);
          assert.equal(dataset.grain, grainOn(grain, paper) ? 'on' : 'off', at);
          assert.deepEqual(Object.keys(dataset).sort(), ['grain', 'theme'], `${at}: the old grid pref is ignored`);
          assert.deepEqual(writes, [], 'loading the page never rewrites or deletes a pref');
        }
      }
    }
    // Storage that throws (some private modes) sets nothing, so the CSS defaults apply: forge, grain on.
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
  for (const v of ['forge', 'cyanotype', 'dark', 'nightprint']) assert.equal(themeChoice(v), 'forge', v);
  for (const v of ['ash', 'vellum', 'light']) assert.equal(themeChoice(v), 'ash', v);
  assert.equal(themeChoice('temper'), 'temper');
  for (const v of [null, undefined, '', 'system', 'bogus', 'Forge', 'Ash', 'Temper', 'Cyanotype']) assert.equal(themeChoice(v), 'system', String(v));
  // System renders what an unset value always has: the OS theme.
  for (const light of [false, true]) assert.equal(normalizeTheme('system', light), normalizeTheme(null, light));
});

test('chooseTheme and followSystemTheme apply the choice', () => {
  const store = new Map<string, string>();
  const dataset: Record<string, string> = { theme: 'forge' };
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
      assert.equal(dataset.theme, 'ash', 'System renders the OS theme');
      chooseTheme('forge');
      assert.equal(store.get('forge.theme'), 'forge');
      assert.equal(dataset.theme, 'forge');

      const stop = followSystemTheme();
      assert.equal(media.added.length, 1, 'one change listener');
      media.flip(false);
      assert.equal(dataset.theme, 'forge', 'an explicit choice ignores the OS');
      media.flip(true);
      assert.equal(dataset.theme, 'forge');

      chooseTheme('system');
      assert.equal(dataset.theme, 'ash');
      media.flip(false);
      assert.equal(dataset.theme, 'forge', 'System follows a live OS change to dark');
      media.flip(true);
      assert.equal(dataset.theme, 'ash', 'and back to light');

      chooseTheme('ash');
      assert.equal(store.get('forge.theme'), 'ash');
      media.flip(false);
      assert.equal(dataset.theme, 'ash', 'an explicit ash on a dark OS');
      media.flip(true);
      assert.equal(dataset.theme, 'ash', 'an explicit ash ignores the OS');
      media.flip(false);
      chooseTheme('system');
      assert.equal(dataset.theme, 'forge', 'System on a dark OS renders forge');
      media.flip(true);
      assert.equal(dataset.theme, 'ash');

      chooseTheme('temper');
      assert.equal(store.get('forge.theme'), 'temper', 'Temper is stored');
      assert.equal(dataset.theme, 'temper', 'Temper applies at once');
      media.flip(false);
      assert.equal(dataset.theme, 'temper', 'an explicit temper on a dark OS');
      media.flip(true);
      assert.equal(dataset.theme, 'temper', 'an explicit temper ignores the OS');
      chooseTheme('system');
      assert.equal(dataset.theme, 'ash', 'System on a light OS leaves temper for ash');

      // A legacy or unknown saved value counts as System too.
      store.set('forge.theme', 'bogus');
      media.flip(false);
      assert.equal(dataset.theme, 'forge');
      store.set('forge.theme', 'light');
      media.flip(false);
      assert.equal(dataset.theme, 'forge', 'legacy light is an explicit ash choice, so the listener leaves it');

      stop();
      assert.deepEqual(media.removed, media.added, 'the unsubscribe removes the same listener');
      store.set('forge.theme', 'system');
      media.flip(true);
      assert.equal(dataset.theme, 'forge', 'nothing follows after unsubscribing');
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

test('grain pref defaults on, migrates paper and writes attribute and pref', () => {
  // Unset grain falls back to the Drafting paper pref; a set grain wins; only an exact off is off.
  assert.equal(grainOn('off'), false);
  assert.equal(grainOn('off', 'on'), false, 'a set grain wins over paper');
  assert.equal(grainOn(null, 'off'), false, 'a ground turned plain under Drafting stays plain');
  assert.equal(grainOn(undefined, 'off'), false);
  assert.equal(grainOn('on', 'off'), true, 'a set grain wins over paper');
  for (const v of [null, undefined, '', 'on', 'bogus', 'OFF']) assert.equal(grainOn(v), true, String(v));
  for (const p of [null, undefined, 'on', 'bogus']) assert.equal(grainOn(null, p), true, `paper ${p}`);
  const store = new Map<string, string>([['forge.paper', 'off'], ['forge.grid', 'off']]);
  const dataset: Record<string, string> = {};
  withGlobals(
    {
      document: { documentElement: { dataset } },
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
    },
    () => {
      assert.equal(currentGrain(), true, 'an absent attribute counts as on');
      setGrain(false);
      assert.equal(dataset.grain, 'off');
      assert.equal(store.get('forge.grain'), 'off');
      assert.equal(currentGrain(), false);
      setGrain(true);
      assert.equal(dataset.grain, 'on');
      assert.equal(store.get('forge.grain'), 'on');
      assert.equal(currentGrain(), true);
      assert.deepEqual(Object.keys(dataset), ['grain'], 'only data-grain is written');
      assert.deepEqual([...store.keys()].sort(), ['forge.grain', 'forge.grid', 'forge.paper'], 'the old prefs stay in localStorage, untouched');
      assert.equal(store.get('forge.paper'), 'off');
    },
  );
});

test('setTheme writes the new id', () => {
  const g = globalThis as any;
  // Swap the descriptors, not the values: reading Node's own localStorage getter warns.
  const saved = { document: Object.getOwnPropertyDescriptor(g, 'document'), localStorage: Object.getOwnPropertyDescriptor(g, 'localStorage') };
  const put = (k: string, value: unknown) => Object.defineProperty(g, k, { value, configurable: true, writable: true });
  const store = new Map<string, string>([['forge.theme', 'dark']]);
  const dataset: Record<string, string> = { theme: 'forge' };
  put('document', { documentElement: { dataset } });
  put('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
  try {
    assert.equal(currentTheme(), 'forge');
    setTheme('ash');
    assert.equal(store.get('forge.theme'), 'ash');
    assert.equal(dataset.theme, 'ash');
    assert.equal(currentTheme(), 'ash');
    setTheme('forge');
    assert.equal(store.get('forge.theme'), 'forge');
    assert.equal(dataset.theme, 'forge');
    // A missing or unknown attribute shows the :root default, so that is what currentTheme reports.
    delete dataset.theme;
    assert.equal(currentTheme(), 'forge');
    dataset.theme = 'bogus';
    assert.equal(currentTheme(), 'forge');
  } finally {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  }
});
