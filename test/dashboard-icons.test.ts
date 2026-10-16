// The dashboard's icons against smithy/assets/Icons, the source of the machined Smithy set: lib/icons.ts must mirror every
// file element for element, Icon.svelte must draw them in the Smithy line, and the call sites must use the set as specced.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tags } from './svelte-markup.ts';
import { ICONS } from '../dashboard/src/lib/icons.ts';
import { SETTINGS_TABS } from '../dashboard/src/lib/settings.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = path.join(ROOT, 'smithy', 'assets', 'Icons');
const SRC = path.join(ROOT, 'dashboard', 'src');
const readSrc = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const GEOMETRY = { path: ['d'], circle: ['cx', 'cy', 'r'], rect: ['x', 'y', 'width', 'height'] } as const;
/** Optional geometry: a rectangle's eased corner. */
const OPTIONAL: Record<string, readonly string[]> = { rect: ['rx'] };
const STYLE = ['fill'];

/** The child elements of a smithy/assets/Icons file, as the ICONS entry they must equal. Throws on anything outside the subset. */
function parseIconFile(name: string, text: string) {
  const body = /<svg\b[^<>]*>([\s\S]*)<\/svg>/.exec(text.replace(/<metadata>[\s\S]*?<\/metadata>/g, ''));
  assert.ok(body, `${name}.svg: no <svg> element`);
  const shapes: Record<string, string>[] = [];
  // [^<>]* cannot backtrack into the next tag, so a hostile file stays linear.
  const leftover = body[1].replace(/<([A-Za-z][\w:-]*)([^<>]*)>/g, (_, el: string, rest: string) => {
    assert.ok(el in GEOMETRY, `${name}.svg: unexpected <${el}>`);
    const attrs: Record<string, string> = {};
    const unparsed = rest.replace(/\s+([\w:-]+)="([^"]*)"/g, (_m, k: string, v: string) => {
      attrs[k] = v;
      return '';
    });
    assert.match(unparsed, /^\s*\/?$/, `${name}.svg: cannot parse <${el}${rest}>`);
    const geometry = GEOMETRY[el as keyof typeof GEOMETRY] as readonly string[];
    const optional = OPTIONAL[el] ?? [];
    // No construction marks: a dashed or faded element is the Drafting set.
    for (const k of Object.keys(attrs)) assert.ok(geometry.includes(k) || optional.includes(k) || STYLE.includes(k), `${name}.svg: <${el}> has unexpected attribute ${k}`);
    const shape: Record<string, string> = { el };
    for (const k of geometry) {
      assert.ok(k in attrs, `${name}.svg: <${el}> lacks ${k}`);
      shape[k] = attrs[k];
    }
    for (const k of optional) if (k in attrs) shape[k] = attrs[k];
    if ('fill' in attrs) {
      if (attrs.fill === 'currentColor') shape.fill = 'current';
      // smithy/assets/Icons/README.md: "The general icon's knobs are open in the files and masked with the ground colour
      // inline", so a knob's fill="none" in the file is the ground fill in the dashboard.
      else if (attrs.fill === 'none' && name === 'general' && el === 'circle') shape.fill = 'ground';
      else assert.fail(`${name}.svg: unexpected fill="${attrs.fill}" on <${el}>`);
    }
    shapes.push(shape);
    return '';
  });
  assert.match(leftover, /^\s*$/, `${name}.svg: unexpected content ${JSON.stringify(leftover.slice(0, 60))}`);
  return shapes;
}

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

test('ICONS matches smithy/assets/Icons file for file', () => {
  const names = fs.readdirSync(ICON_DIR).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)).sort();
  assert.equal(names.length, 27);
  assert.deepEqual(Object.keys(ICONS).sort(), names);
  for (const name of names) {
    const expected = parseIconFile(name, fs.readFileSync(path.join(ICON_DIR, `${name}.svg`), 'utf8'));
    assert.deepEqual(JSON.parse(JSON.stringify(ICONS[name as keyof typeof ICONS])), expected, name);
  }
  const grounds = Object.entries(ICONS).flatMap(([n, d]) => d.filter((s) => 'fill' in s && s.fill === 'ground').map(() => n));
  assert.deepEqual(grounds, ['general', 'general', 'general']);
  // Every file is drawn in the machined line, and none carries a construction mark.
  for (const name of names) {
    const svg = /<svg\b[^<>]*>/.exec(fs.readFileSync(path.join(ICON_DIR, `${name}.svg`), 'utf8'))?.[0] ?? '';
    for (const a of ['stroke-width="1.5"', 'stroke-linecap="round"', 'stroke-linejoin="round"', 'fill="none"']) assert.ok(svg.includes(a), `${name}.svg has ${a}`);
    assert.doesNotMatch(fs.readFileSync(path.join(ICON_DIR, `${name}.svg`), 'utf8'), /stroke-dasharray|opacity/, `${name}.svg has no construction marks`);
  }
  assert.ok(Object.values(ICONS).every((d) => Array.isArray(d)), 'an icon is a list of shapes: no cx group');
});

test('the icon file parser rejects what ICONS cannot hold', () => {
  const wrap = (inner: string) => `<svg viewBox="0 0 24 24">${inner}</svg>`;
  assert.throws(() => parseIconFile('x', wrap('<polyline points="1 2"/>')), /unexpected <polyline>/);
  assert.throws(() => parseIconFile('x', wrap('<path d="M0 0" transform="scale(2)"/>')), /unexpected attribute transform/);
  assert.throws(() => parseIconFile('x', wrap('<circle cx="1" cy="1" r="1" fill="none"/>')), /unexpected fill/);
  assert.throws(() => parseIconFile('x', wrap('<path d="M0 0" opacity=".6" stroke-dasharray="2 2"/>')), /unexpected attribute (opacity|stroke-dasharray)/);
  assert.throws(() => parseIconFile('x', wrap('<path d="M0 0" rx="1"/>')), /unexpected attribute rx/);
  assert.deepEqual(parseIconFile('x', wrap('<rect x="1" y="2" width="3" height="4" rx="1"/>')), [{ el: 'rect', x: '1', y: '2', width: '3', height: '4', rx: '1' }]);
  assert.throws(() => parseIconFile('x', wrap('<path d="M0 0"/>text')), /unexpected content/);
  assert.deepEqual(parseIconFile('x', wrap('<metadata><junk a="b"/></metadata><path d="M0 0"/>')), [{ el: 'path', d: 'M0 0' }]);
  const started = Date.now();
  assert.throws(() => parseIconFile('x', wrap(`<path d="M0 0"${' a'.repeat(10_000)}`)));
  assert.ok(Date.now() - started < 1000, 'a hostile file parses in linear time');
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
  // The built CSS sizes the icon in the same line: 1.5, round caps and joins, no construction class.
  const dist = path.join(ROOT, 'dashboard', 'dist', 'assets');
  const css = fs.readdirSync(dist).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(dist, f), 'utf8')).join('');
  assert.match(css, /\.ic\{[^}]*stroke-width:1\.5/, '.ic is 1.5');
  assert.doesNotMatch(css, /\.ic \.cx/, 'no .ic .cx rule');
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
    assert.ok(text.includes('<Icon name="play"'), `${file} has the play icon`);
    assert.ok(text.includes('<Icon name="stop"'), `${file} has the stop icon`);
  }
});

test('git icons mark branches, PRs and the tracker', () => {
  for (const name of ['branch', 'pull-request', 'github', 'bell']) assert.ok(name in ICONS, `${name} is in the set`);
  const readme = fs.readFileSync(path.join(ICON_DIR, 'README.md'), 'utf8');
  assert.match(readme, /^Twenty-seven machined icons/);
  for (const name of ['branch', 'pull-request', 'github', 'bell']) assert.ok(readme.includes(`\`${name}\``), `the README names ${name} and its use`);
  // A chip can carry an icon, sized to the slug.
  const chip = readSrc('components/Chip.svelte');
  assert.match(chip, /icon\?: IconName/);
  assert.match(chip, /\{#if icon\}<Icon name=\{icon\} \/>\{\/if\}\{text\}/);
  assert.match(readSrc('components/PrChip.svelte'), /<Chip tone=\{model\.tone\} text=\{model\.text\} icon="pull-request" \/>/, 'every PR chip');
  const dist = path.join(ROOT, 'dashboard', 'dist', 'assets');
  const css = fs.readdirSync(dist).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(dist, f), 'utf8')).join('');
  assert.match(css, /\.chip \.ic\{width:12px;height:12px\}/, '.chip .ic is 12px');
  assert.ok(fs.readFileSync(path.join(ROOT, 'smithy', 'smithy.css'), 'utf8').includes('.chip .ic { width: 12px; height: 12px; }'), 'smithy/smithy.css draws it');
  // The Pipeline header and the Backlog subtitle.
  const pipeline = readSrc('views/Pipeline.svelte');
  assert.match(pipeline, /<Icon name="branch" \/>\{\$t\('pipeline\.base'\)\}/, 'branch before the base');
  assert.match(pipeline, /<Icon name=\{data\.config\.tracker === 'github' \? 'github' : 'tracker'\} \/>\{\$t\('pipeline\.tracker'/, 'github or tracker before the tracker');
  assert.match(readSrc('views/Backlog.svelte'), /<Icon name=\{S\.data\?\.config\?\.tracker === 'github' \? 'github' : 'tracker'\} \/><b>\{b\.tracker\}<\/b>/);
  // The job pane: Branch and Base, the PR link, and a GitHub Source link.
  const drawer = readSrc('components/Drawer.svelte');
  assert.match(drawer, /fact\(\$t\('drawer\.branch'\), j\.branch \?\? '—', 'branch'\)\}\{@render fact\(\$t\('drawer\.base'\), j\.base \?\? '—', 'branch'\)/);
  assert.match(drawer, /href=\{prUrl\}[^>]*><Icon name="pull-request" /);
  assert.match(drawer, /const srcGitHub = \$derived\(srcUrl\?\.startsWith\('https:\/\/github\.com\/'\) \?\? false\);/, 'github only for a safeUrl on github.com');
  assert.match(drawer, /\{#if srcGitHub\}<Icon name="github" /);
  // Needs you: the Open PR button and the bell.
  assert.match(readSrc('components/statusbar/NeedsPanel.svelte'), /<a class="btn sm" href=\{u\}[^>]*><Icon name="pull-request" \/>\{\$t\('inbox\.openPr'\)\}<\/a>/);
  assert.match(readSrc('components/StatusBar.svelte'), /<Icon name="bell" \/>/);
});
