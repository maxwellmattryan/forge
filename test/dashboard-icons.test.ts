// The dashboard's icons against design/icons, the source of the Drafting set: lib/icons.ts must mirror every file
// element for element, Icon.svelte must draw them in the Drafting line, and the call sites must use the set as specced.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tags } from './svelte-markup.ts';
import { ICONS } from '../dashboard/src/lib/icons.ts';
import { SETTINGS_TABS } from '../dashboard/src/lib/settings.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = path.join(ROOT, 'design', 'icons');
const SRC = path.join(ROOT, 'dashboard', 'src');
const readSrc = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const GEOMETRY = { path: ['d'], circle: ['cx', 'cy', 'r'], rect: ['x', 'y', 'width', 'height'] } as const;
const STYLE = ['fill', 'stroke-dasharray', 'opacity'];

/** The child elements of a design/icons file, as the ICONS entry they must equal. Throws on anything outside the subset. */
function parseIconFile(name: string, text: string) {
  const body = /<svg\b[^<>]*>([\s\S]*)<\/svg>/.exec(text.replace(/<metadata>[\s\S]*?<\/metadata>/g, ''));
  assert.ok(body, `${name}.svg: no <svg> element`);
  const main: Record<string, string>[] = [];
  const cx: Record<string, string>[] = [];
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
    for (const k of Object.keys(attrs)) assert.ok(geometry.includes(k) || STYLE.includes(k), `${name}.svg: <${el}> has unexpected attribute ${k}`);
    const dashed = 'stroke-dasharray' in attrs || 'opacity' in attrs;
    if (dashed) assert.ok(attrs['stroke-dasharray'] === '2 2' && attrs.opacity === '.6', `${name}.svg: construction must be stroke-dasharray="2 2" opacity=".6"`);
    const shape: Record<string, string> = { el };
    for (const k of geometry) {
      assert.ok(k in attrs, `${name}.svg: <${el}> lacks ${k}`);
      shape[k] = attrs[k];
    }
    if ('fill' in attrs) {
      if (attrs.fill === 'currentColor') shape.fill = 'current';
      else if (attrs.fill === 'none' && name === 'general' && el === 'circle') shape.fill = 'ground';
      else assert.fail(`${name}.svg: unexpected fill="${attrs.fill}" on <${el}>`);
    }
    (dashed ? cx : main).push(shape);
    return '';
  });
  assert.match(leftover, /^\s*$/, `${name}.svg: unexpected content ${JSON.stringify(leftover.slice(0, 60))}`);
  return { main, cx };
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

test('ICONS matches design/icons file for file', () => {
  const names = fs.readdirSync(ICON_DIR).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)).sort();
  assert.equal(names.length, 23);
  assert.deepEqual(Object.keys(ICONS).sort(), names);
  for (const name of names) {
    const expected = parseIconFile(name, fs.readFileSync(path.join(ICON_DIR, `${name}.svg`), 'utf8'));
    assert.deepEqual(JSON.parse(JSON.stringify(ICONS[name as keyof typeof ICONS])), expected, name);
  }
  const grounds = Object.entries(ICONS).flatMap(([n, d]) => [...d.main, ...d.cx].filter((s) => 'fill' in s && s.fill === 'ground').map(() => n));
  assert.deepEqual(grounds, ['general', 'general', 'general']);
});

test('the icon file parser rejects what ICONS cannot hold', () => {
  const wrap = (inner: string) => `<svg viewBox="0 0 24 24">${inner}</svg>`;
  assert.throws(() => parseIconFile('x', wrap('<polyline points="1 2"/>')), /unexpected <polyline>/);
  assert.throws(() => parseIconFile('x', wrap('<path d="M0 0" transform="scale(2)"/>')), /unexpected attribute transform/);
  assert.throws(() => parseIconFile('x', wrap('<circle cx="1" cy="1" r="1" fill="none"/>')), /unexpected fill/);
  assert.throws(() => parseIconFile('x', wrap('<path d="M0 0" opacity=".5"/>')), /construction must be/);
  assert.throws(() => parseIconFile('x', wrap('<path d="M0 0"/>text')), /unexpected content/);
  assert.deepEqual(parseIconFile('x', wrap('<metadata><junk a="b"/></metadata><path d="M0 0"/>')), { main: [{ el: 'path', d: 'M0 0' }], cx: [] });
  const started = Date.now();
  assert.throws(() => parseIconFile('x', wrap(`<path d="M0 0"${' a'.repeat(10_000)}`)));
  assert.ok(Date.now() - started < 1000, 'a hostile file parses in linear time');
});

test('Icon.svelte draws the Drafting line', () => {
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
    'stroke-width': '1.25',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  };
  for (const [k, v] of Object.entries(want)) assert.equal(attr(svg, k), v, `svg ${k}`);
  const g = all.find((x) => x.name === 'g');
  assert.ok(g, 'a <g> wraps the construction shapes');
  assert.equal(attr(g, 'class'), 'cx');
  assert.equal(attr(g, 'stroke-dasharray'), '2 2');
  assert.equal(attr(g, 'opacity'), '.6');
  assert.ok(/<g\b[^>]*>\{#each def\.cx\b/.test(text), 'the <g> renders the cx list');
  for (const el of ['path', 'circle', 'rect']) assert.ok(all.some((x) => x.name === el), `renders <${el}>`);
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

  for (const file of ['components/DaemonBar.svelte', 'components/SessionLog.svelte']) {
    const text = readSrc(file);
    assert.ok(text.includes('<Icon name="play"'), `${file} has the play icon`);
    assert.ok(text.includes('<Icon name="stop"'), `${file} has the stop icon`);
  }
});
