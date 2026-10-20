// The dashboard's icons: lib/icons.ts holds the machined Smithy set in the subset Icon.svelte draws, Icon.svelte draws
// them in the Smithy line, and the call sites use the set as specced.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tags } from './svelte-markup.ts';
import { DIST, noDist } from './dist.ts';
import { ICONS } from '../dashboard/src/lib/icons.ts';
import { SETTINGS_TABS } from '../dashboard/src/lib/settings.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'dashboard', 'src');
const readSrc = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const GEOMETRY = { path: ['d'], circle: ['cx', 'cy', 'r'], rect: ['x', 'y', 'width', 'height'] } as const;
/** Optional keys: a rectangle's eased corner, and a fill (current, or the ground colour that masks the general icon's knobs). */
const OPTIONAL: Record<string, readonly string[]> = { path: ['fill'], circle: ['fill'], rect: ['rx', 'fill'] };

type Tag = ReturnType<typeof tags>[number];
/** An attribute's value with its quotes removed; undefined when absent, true when a bare attribute. */
function attr(tag: Tag, name: string): string | true | undefined {
  const a = tag.attrs.find((x) => x.name === name);
  if (!a) return undefined;
  if (a.value === undefined) return true;
  return a.value.replace(/^(["'])([\s\S]*)\1$/, '$2');
}

const svelteFiles = () =>
  fs
    .readdirSync(SRC, { recursive: true })
    .map((f) => String(f).split(path.sep).join('/'))
    .filter((f) => f.endsWith('.svelte'))
    .sort();

test('ICONS holds only the shapes Icon.svelte draws', () => {
  assert.equal(Object.keys(ICONS).length, 35);
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

test('Icon.svelte draws the machined line', () => {
  const text = readSrc('components/Icon.svelte');
  assert.ok(!text.includes('{@html'), 'Icon.svelte must not use {@html}');
  const all = tags('Icon.svelte', text);
  const svgs = all.filter((x) => x.name === 'svg');
  assert.equal(svgs.length, 1);
  const svg = svgs[0];
  const cls = attr(svg, 'class');
  assert.ok(typeof cls === 'string' && cls.split(/\s+/).includes('ic'), 'svg class contains ic');
  const want = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.5',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  };
  for (const [k, v] of Object.entries(want)) assert.equal(attr(svg, k), v, `svg ${k}`);
  assert.ok(!all.some((x) => x.name === 'g'), 'no construction group');
  assert.doesNotMatch(text, /stroke-dasharray|opacity|def\.cx|def\.main|class="cx"/, 'no dashed branch');
  assert.ok(text.includes('{#each def as s, i (i)}'), 'every shape in one list');
  for (const el of ['path', 'circle', 'rect']) assert.ok(all.some((x) => x.name === el), `renders <${el}>`);
  assert.equal(attr(all.find((x) => x.name === 'rect') as Tag, 'rx'), '{s.rx}', 'a rect keeps its eased corner');
});

/** Every stylesheet under the real build's assets/. */
const builtAssetsCss = () => {
  const dist = path.join(DIST, 'assets');
  return fs.readdirSync(dist).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(dist, f), 'utf8')).join('');
};

test('the built CSS draws icons in the machined line', { skip: noDist() }, () => {
  // The icon in the same line: 1.5, round caps and joins, no construction class; a chip's icon sized to the slug.
  const css = builtAssetsCss();
  assert.match(css, /\.ic\{[^}]*stroke-width:1\.5/, '.ic is 1.5');
  assert.doesNotMatch(css, /\.ic \.cx/, 'no .ic .cx rule');
  assert.match(css, /\.chip \.ic\{width:12px;height:12px\}/, '.chip .ic is 12px');
});

test('settings tabs, controls and call sites use the set', () => {
  for (const tab of SETTINGS_TABS) {
    assert.equal(tab.icon, tab.id);
    assert.ok(tab.icon in ICONS, `${tab.icon} is an icon`);
  }

  const settings = tags('Settings.svelte', readSrc('components/Settings.svelte'));
  const tabAt = settings.findIndex((x) => x.name === 'button' && attr(x, 'role') === 'tab');
  assert.ok(tabAt >= 0, 'Settings.svelte has a role="tab" button');
  const inside: Tag[] = [];
  for (const x of settings.slice(tabAt + 1)) {
    if (x.name === 'button' || x.name === 'div') break;
    inside.push(x);
  }
  assert.ok(inside.some((x) => x.name === 'Icon' && attr(x, 'name') === '{item.icon}'), 'the tab button renders <Icon name={item.icon} />');

  for (const file of svelteFiles()) {
    for (const x of tags(file, readSrc(file))) {
      if (x.name !== 'Icon') continue;
      const cls = attr(x, 'class');
      assert.ok(!(typeof cls === 'string' && cls.includes('size-')), `${file}: <Icon> sets a size class (${cls})`);
    }
  }

  for (const file of ['components/statusbar/DaemonPanel.svelte', 'components/SessionLog.svelte']) {
    const text = readSrc(file);
    // Through its one Start/Stop IconButton toggle.
    assert.match(text, /<IconButton icon=\{[^}]*'play'/, `${file} has the play icon`);
    assert.match(text, /<IconButton icon=\{[^}]*'stop'/, `${file} has the stop icon`);
  }
});

test('git icons mark branches, PRs and the tracker', () => {
  for (const name of ['branch', 'pull-request', 'github', 'bell']) assert.ok(name in ICONS, `${name} is in the set`);
  // A chip can carry an icon, sized to the slug.
  const chip = readSrc('components/Chip.svelte');
  assert.match(chip, /icon\?: IconName/);
  assert.match(chip, /\{#if icon\}<Icon name=\{icon\} \/>\{\/if\}\{text\}/);
  assert.match(readSrc('components/PrChip.svelte'), /<Chip tone=\{model\.tone\} text=\{model\.text\} icon="pull-request" \/>/, 'every PR chip');
  // The Pipeline header and the Backlog subtitle.
  const pipeline = readSrc('views/Pipeline.svelte');
  assert.match(pipeline, /<Icon name="branch" \/>\{\$t\('pipeline\.base'\)\}/, 'branch before the base');
  assert.match(pipeline, /<Icon name=\{data\.config\.tracker === 'github' \? 'github' : 'tracker'\} \/>\{\$t\('pipeline\.tracker'/, 'github or tracker before the tracker');
  assert.match(readSrc('views/Backlog.svelte'), /<Icon name=\{S\.data\?\.config\?\.tracker === 'github' \? 'github' : 'tracker'\} \/><b>\{b\.tracker\}<\/b>/);
  // The job pane: Branch and Base, the PR link, and a GitHub link per issue.
  const drawer = readSrc('components/Drawer.svelte');
  assert.match(drawer, /fact\(\$t\('drawer\.branch'\), j\.branch \?\? '—', 'branch'\)\}\{@render fact\(\$t\('drawer\.base'\), j\.base \?\? '—', 'branch'\)/);
  assert.match(drawer, /href=\{prUrl\}[^>]*><Icon name="pull-request" /);
  assert.match(drawer, /\{@const issueUrl = safeUrl\(issue\.url\)\}/, 'each issue url goes through safeUrl');
  assert.match(drawer, /\{#if issueUrl\.startsWith\('https:\/\/github\.com\/'\)\}<Icon name="github" /, 'github only for a safeUrl on github.com');
  // Needs you: the Open PR button and the bell.
  assert.match(readSrc('components/statusbar/NeedsPanel.svelte'), /<a class="btn sm" href=\{u\}[^>]*><Icon name="pull-request" \/>\{\$t\('inbox\.openPr'\)\}<\/a>/);
  assert.match(readSrc('components/StatusBar.svelte'), /<Icon name="bell" \/>/);
});
