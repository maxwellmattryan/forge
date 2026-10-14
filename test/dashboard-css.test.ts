// The Drafting utility set (design/drafting.css) ported into dashboard/style.css as @utility
// classes, the old class names gone, and the drawing rules: square corners, hard shadows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD = path.join(ROOT, 'dashboard');
const DIST = path.join(DASHBOARD, 'dist');

function builtCss(): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  const files = new Set<string>();
  for (const e of Object.values<any>(manifest)) for (const f of [e.file, ...(e.css ?? [])]) if (String(f).endsWith('.css')) files.add(f);
  return [...files].map((f) => fs.readFileSync(path.join(DIST, f), 'utf8')).join('\n');
}

const UTILITIES = (
  'ground falloff plain hatch hatch-dense crosshatch sheet ticks redline dashed solid clickable h label callout mono num muted dimmed caption ' +
  'dim-line prose btn seg chip nav input check radio field track fill tabs tab tbl tblock kpi ic dot backdrop mark'
).split(' ');
// Compound selectors as the build writes them (minified, attribute quotes dropped).
const MODIFIERS = [
  '.sheet.clickable', '.sheet.hover', '.sheet.redline', '.sheet.dashed', '.sheet.solid', '.ticks>.tk', '.ticks:before', '.ticks>.tk:after',
  '.h.display', '.h.page', '.h.sheet-title', '.h.section', '.h.card', '.callout:before', '.dim-line .end', '.prose h1', '.prose h3', '.prose pre code',
  '.btn.primary', '.btn.sel', '.btn.sm', '.btn.icon', '.btn.touch', '.btn.active', '.btn.focus', '.btn.disabled', '.btn[disabled]', '.btn .ic', '.seg .btn',
  '.chip.ok', '.chip.bad', '.chip.warn', '.chip.info', '.chip.ink', '.chip.muted', '.chip.live', '.chip.rev', '.chip.hl', '.chip:is(button)',
  '.nav a', '.nav button', '.nav a.active', '.nav .lbl', '.nav.row', '.nav.row a', '.nav.row button',
  '.input:focus', '.input:is(textarea)', '.input:is(select)', '.check.on:after', '.radio.on:after', '.fill.ok', '.fill.warn', '.fill.bad', '[data-theme=vellum] .fill',
  '.tab.active', '.tbl th', '.tbl tr.clickable', '.tbl .r', '.tblock>div.wide', '.tblock .k', '.kpi .v', '.ic .cx',
  '.dot.ok', '.dot.ink', '.dot.hl', '.dot.red', '.dot.hollow', '[data-theme=vellum] .backdrop', '[data-theme=vellum] .mark', '.ground:before', '.falloff:after',
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The bodies of every rule whose selector list names exactly `selector` (the build merges equal rules). */
function ruleFor(css: string, selector: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) if (m[1].split(',').some((s) => s.trim() === selector)) out.push(m[2]);
  return out.join(';');
}

/** A class selector that ends there: `.h` matches `.h{` or `.h.card`, never `.h-4` or `.hatch`. */
const hasClass = (css: string, name: string) => new RegExp(`(?<!\\\\)\\.${escapeRe(name)}(?![\\w\\\\-])`).test(css);

test('every drafting utility is ported', () => {
  const source = fs.readFileSync(path.join(DASHBOARD, 'style.css'), 'utf8');
  const css = builtCss();
  for (const name of UTILITIES) {
    assert.match(source, new RegExp(`@utility ${escapeRe(name)}\\s*\\{`), `style.css declares @utility ${name}`);
    assert.ok(hasClass(css, name), `the built CSS has a .${name} rule`);
  }
  // The layout helpers stay Tailwind's: a custom `grow` would emit next to flex-grow.
  for (const name of ['row', 'wrap', 'col', 'grow']) assert.doesNotMatch(source, new RegExp(`@utility ${name}\\s*\\{`), `${name} is not ported`);
  for (const sel of MODIFIERS) assert.ok(css.includes(sel), `the built CSS has ${sel}`);
  // A .nav.row item keeps its natural width (the column rule sets width: 100%), in the build and in the drawing.
  assert.match(ruleFor(css, '.nav.row a'), /width:auto/);
  assert.ok(fs.readFileSync(path.join(ROOT, 'design', 'drafting.css'), 'utf8').includes('.nav.row a, .nav.row button { width: auto;'), 'design/drafting.css has the .nav.row item rule');
  assert.ok(!hasClass('.hatch{}.h-4{}', 'h') && hasClass('.h.card{}', 'h') && hasClass('.x .h{', 'h'), 'the class matcher');
  // A sheet sets only its background colour, so `sheet hatch` and `sheet crosshatch` keep their image (Empty).
  const sheet = ruleFor(css, '.sheet');
  assert.match(sheet, /background-color:var\(--panel\)/);
  assert.doesNotMatch(sheet, /(^|[;{])background:/, 'no background shorthand on .sheet');
  const drafting = fs.readFileSync(path.join(ROOT, 'design', 'drafting.css'), 'utf8');
  const sheetRule = /^\.sheet \{([^}]*)\}/m.exec(drafting)?.[1] ?? '';
  assert.match(sheetRule, /background-color: var\(--panel\)/, 'design/drafting.css .sheet sets background-color');
  assert.doesNotMatch(sheetRule, /(^|;)\s*background:/, 'design/drafting.css .sheet has no background shorthand');
});

test('old class names are gone', () => {
  const source = fs.readFileSync(path.join(DASHBOARD, 'style.css'), 'utf8');
  const css = builtCss();
  const OLD = ['card', 'btn-primary', 'nav-item', 'kpi-label', 'kpi-value', 'prose-md', 'ember-bar', 'brand-rule'];
  for (const name of OLD) assert.doesNotMatch(source, new RegExp(`@utility ${escapeRe(name)}\\s*\\{`), `style.css declares no @utility ${name}`);
  assert.ok(!source.includes('alias: removed in job 4'), 'no alias comments are left');
  const inline = /@source inline\("([^"]*)"\)/.exec(source)?.[1].split(/\s+/) ?? [];
  assert.ok(inline.includes('sheet'), 'the @source inline list is read');
  assert.deepEqual(inline.filter((n) => OLD.includes(n)), [], 'no old names in @source inline');
  for (const name of [...OLD.slice(1), 'text-accent']) assert.ok(!hasClass(css, name), `the built CSS has no .${name} rule`);
  // `.card` survives only as the Drafting title style, `.h.card`.
  const cards = [...css.matchAll(/[^{}]*\{/g)].flatMap((m) => m[0].slice(0, -1).split(',')).filter((sel) => hasClass(sel, 'card'));
  assert.ok(cards.length > 0 && cards.every((sel) => sel.trim() === '.h.card'), `.card appears only as .h.card (${cards.join(' | ')})`);
  for (const v of ['--accent', '--on-accent', '--color-accent', '--color-on-accent']) {
    assert.ok(!new RegExp(`${escapeRe(v)}(?![\\w-])`).test(source), `style.css has no ${v}`);
    assert.ok(!new RegExp(`${escapeRe(v)}(?![\\w-])`).test(css), `the built CSS has no ${v}`);
  }
  // kpi is the reference rule now: the sheet outline comes from `sheet ticks kpi` markup.
  assert.doesNotMatch(ruleFor(css, '.kpi'), /border|background/);
  for (const gone of ['--ember-hot', '--color-ember-hot', 'Inter', 'JetBrains Mono']) assert.ok(!css.includes(gone), `${gone} is gone`);
});

/** name: value pairs of every declaration in the stylesheet, at any depth. */
const declarations = (css: string) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?<=[{;])\s*([\w-]+|--(?:[\w-]|\\.)+)\s*:\s*([^;{}]*)/g)].map((m) => [m[1], m[2].trim()]);

/** Splits on separators outside parentheses. */
function splitTop(value: string, sep: RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of value) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (depth === 0 && sep.test(c)) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const ROUND_OK = /^(0|0px|50%|9999px|10px|calc\(infinity\s*\*\s*1px\)|3\.40282e\+?38px|var\(--radius-(dot|tag)\))$/;

/** Shadow parts that blur; a part that is only a var() is checked where that variable is declared. */
function blurred(value: string): string[] {
  const bad: string[] = [];
  for (const part of splitTop(value, /,/)) {
    if (/^(none|initial|inherit|unset)$/.test(part) || /^var\([^()]*(\([^()]*\))?[^()]*\)$/.test(part)) continue;
    const tokens = splitTop(part.replace(/\)(?=[^\s,)])/g, ') '), /\s/).filter((t) => t !== 'inset');
    const lengths = tokens.filter((t) => /^-?(\d*\.)?\d+(px|rem|em)?$/.test(t) || t.startsWith('calc('));
    const blur = lengths[2];
    if (blur !== undefined && !/^-?0*\.?0+(px|rem|em)?$/.test(blur)) bad.push(part);
  }
  return bad;
}

test('no rounded corners or blurred shadows', () => {
  const css = builtCss();
  const decls = declarations(css);
  const vars = new Map<string, string[]>();
  for (const [k, v] of decls) if (k.startsWith('--')) vars.set(k, [...(vars.get(k) ?? []), v]);
  const resolve = (v: string): string[] => {
    const m = /^var\((--[\w-]+)\)$/.exec(v);
    if (!m || ROUND_OK.test(v)) return [v];
    const defs = vars.get(m[1]);
    assert.ok(defs?.length, `${m[1]} is declared`);
    return defs.flatMap(resolve);
  };
  let radii = 0;
  for (const [k, v] of decls) {
    if (!/^border(-[a-z]+)*-radius$/.test(k)) continue;
    for (const one of splitTop(v, /\s/).flatMap(resolve)) {
      radii++;
      assert.match(one, ROUND_OK, `${k}: ${v} resolves to ${one}`);
    }
  }
  assert.ok(radii >= 8, `checked ${radii} radii`);
  let shadows = 0;
  for (const [k, v] of decls) {
    if (!(k === 'box-shadow' || /^--tw-(inset-|ring-|inset-ring-|ring-offset-)?shadow$/.test(k) || /^--shadow-/.test(k))) continue;
    shadows++;
    assert.deepEqual(blurred(v), [], `${k}: ${v} has a blur radius`);
  }
  assert.ok(shadows >= 8, `checked ${shadows} shadows`);
  assert.deepEqual(blurred('0 10px 15px -3px rgb(0 0 0/.1)'), ['0 10px 15px -3px rgb(0 0 0/.1)'], 'the blur check');
  assert.deepEqual(blurred('var(--tw-ring-inset,)0 0 0 calc(1px + var(--x))var(--c,currentcolor)'), []);

  const src = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? src(path.join(dir, e.name)) : /\.(svelte|ts)$/.test(e.name) ? [path.join(dir, e.name)] : []));
  for (const f of src(path.join(DASHBOARD, 'src'))) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /(?<![\w-])rounded(?![\w-])/, `${path.relative(ROOT, f)} uses a bare rounded class (Tailwind's literal .25rem)`);
  }
});

const draftingCss = () => fs.readFileSync(path.join(ROOT, 'design', 'drafting.css'), 'utf8');

test('appearance prefs turn the grid and paper off', () => {
  const css = builtCss();
  assert.match(ruleFor(css, 'html[data-grid=off] .ground'), /background-image:none/);
  assert.match(ruleFor(css, 'html[data-paper=off] .ground:before'), /display:none/);
  assert.match(ruleFor(css, 'html[data-paper=off] .falloff:after'), /display:none/);
  // On by default: nothing hides them unless the attribute says off.
  assert.doesNotMatch(css, /data-(grid|paper)=on/);
  const drafting = draftingCss();
  assert.ok(drafting.includes('html[data-grid="off"] .ground { background-image: none; }'), 'design/drafting.css drops the grid');
  assert.ok(drafting.includes('html[data-paper="off"] .ground::before, html[data-paper="off"] .ground.falloff::after { display: none; }'), 'design/drafting.css drops the fibre and the falloff');
});
