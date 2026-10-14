// The Drafting utility set (design/drafting.css) ported into dashboard/style.css as @utility
// classes, the old class names kept as aliases, and the drawing rules: square corners, hard shadows.
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
const ALIASES = 'card btn-primary nav-item kpi kpi-label kpi-value tbl prose-md ember-bar brand-rule'.split(' ');
// Compound selectors as the build writes them (minified, attribute quotes dropped).
const MODIFIERS = [
  '.sheet.clickable', '.sheet.hover', '.sheet.redline', '.sheet.dashed', '.sheet.solid', '.ticks>.tk', '.ticks:before', '.ticks>.tk:after',
  '.h.display', '.h.page', '.h.sheet-title', '.h.section', '.h.card', '.callout:before', '.dim-line .end', '.prose h1', '.prose-md h3', '.prose-md pre code',
  '.btn.primary', '.btn.sel', '.btn.sm', '.btn.icon', '.btn.touch', '.btn.active', '.btn.focus', '.btn.disabled', '.btn[disabled]', '.btn .ic', '.seg .btn',
  '.chip.ok', '.chip.bad', '.chip.warn', '.chip.info', '.chip.ink', '.chip.muted', '.chip.live', '.chip.rev', '.chip.hl', '.chip:is(button)',
  '.nav a', '.nav button', '.nav a.active', '.nav .lbl', '.nav.row', '.nav.row a', '.nav.row button', '.nav-item.active', '.nav-item.active:before', '.btn-primary.btn',
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

test('old class names still apply', () => {
  const source = fs.readFileSync(path.join(DASHBOARD, 'style.css'), 'utf8');
  const css = builtCss();
  for (const name of ALIASES) assert.ok(hasClass(css, name), `the built CSS has a .${name} rule`);
  for (const name of ['card', 'btn-primary', 'nav-item', 'kpi-label', 'kpi-value', 'prose-md', 'ember-bar', 'brand-rule']) {
    const at = source.indexOf(`@utility ${name} {`);
    assert.ok(at > 0, `style.css declares @utility ${name}`);
    assert.ok(source.slice(Math.max(0, at - 200), at).includes('/* alias: removed in job 4'), `${name} is marked as an alias`);
  }
  // Mapped onto the new rules, not left with the old look.
  assert.match(ruleFor(css, '.card'), /border:1px solid var\(--line\);background-color:var\(--panel\)/);
  assert.match(ruleFor(css, '.kpi-label'), /font-family:var\(--font-mono\)/);
  assert.match(ruleFor(css, '.brand-rule'), /display:flex/);
  assert.match(ruleFor(css, '.btn-primary.btn'), /background:var\(--ink\)/);
  assert.match(ruleFor(css, '.text-accent'), /color:var\(--ink\)/);
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
