// The dashboard's icons: lib/icons.ts holds the machined Smithy set in the subset Icon.svelte draws, and the settings tabs
// and git marks use the set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ICONS } from '../dashboard/src/lib/icons.ts';
import { SETTINGS_TABS } from '../dashboard/src/lib/settings.ts';

const GEOMETRY = { path: ['d'], circle: ['cx', 'cy', 'r'], rect: ['x', 'y', 'width', 'height'] } as const;
/** Optional keys: a rectangle's eased corner, and a fill (current, or the ground colour that masks the general icon's knobs). */
const OPTIONAL: Record<string, readonly string[]> = { path: ['fill'], circle: ['fill'], rect: ['rx', 'fill'] };

test('ICONS holds only the shapes Icon.svelte draws', () => {
  assert.equal(Object.keys(ICONS).length, 36);
  for (const [name, def] of Object.entries(ICONS)) {
    assert.ok(Array.isArray(def) && def.length > 0, `${name} is a list of shapes: no cx group`);
    for (const shape of def as readonly Record<string, string>[]) {
      assert.ok(shape.el in GEOMETRY, `${name}: unexpected <${shape.el}>`);
      const geometry = GEOMETRY[shape.el as keyof typeof GEOMETRY] as readonly string[];
      for (const k of geometry) assert.match(shape[k] ?? '', /\S/, `${name}: <${shape.el}> lacks ${k}`);
      // No construction marks: a dashed or faded element is the Drafting set.
      for (const k of Object.keys(shape)) assert.ok(k === 'el' || geometry.includes(k) || OPTIONAL[shape.el].includes(k), `${name}: <${shape.el}> has unexpected key ${k}`);
      if ('fill' in shape) assert.ok(['current', 'ground'].includes(shape.fill), `${name}: unexpected fill ${shape.fill}`);
    }
  }
  const grounds = Object.entries(ICONS).flatMap(([n, d]) => d.filter((s) => 'fill' in s && s.fill === 'ground').map(() => n));
  assert.deepEqual(grounds, ['general', 'general', 'general']);
});

test('settings tabs use the set', () => {
  for (const tab of SETTINGS_TABS) {
    assert.equal(tab.icon, tab.id);
    assert.ok(tab.icon in ICONS, `${tab.icon} is an icon`);
  }
});

test('git icons mark branches, PRs and the tracker', () => {
  for (const name of ['branch', 'pull-request', 'github', 'bell']) assert.ok(name in ICONS, `${name} is in the set`);
});
