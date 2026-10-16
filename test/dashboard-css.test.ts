// The Smithy utility set (smithy/smithy.css) ported into dashboard/style.css as @utility classes, the Drafting class
// names gone, and the drawing rules: plates cut at two corners and clipped to them, the grain on its own layer, sheen
// on hover, token shadows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtCss } from './built-css.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD = path.join(ROOT, 'dashboard');
const SMITHY = path.join(ROOT, 'smithy');
const smithyCss = () => fs.readFileSync(path.join(SMITHY, 'smithy.css'), 'utf8');
const styleCss = () => fs.readFileSync(path.join(DASHBOARD, 'style.css'), 'utf8');

const UTILITIES = (
  'ground falloff plain solid chrome plate clickable h label callout mono num muted dimmed caption stamp-line prose btn seg chip ' +
  'navlist input check radio field cmd-field track fill tabs tab tbl facts kpi ic dot halo backdrop scrim mark'
).split(' ');
// Compound selectors as the build writes them (minified, attribute quotes dropped).
const MODIFIERS = [
  '.plate:after', '.plate.flat:after', '.plate.open', '.plate.cold', '.plate.ember', '.plate.riveted', '.plate.riveted:before', '.plate.clickable', '.plate.hover', '.plate.solid',
  '.h.display', '.h.page', '.h.sheet-title', '.h.section', '.h.card', '.callout:before', '.stamp-line:before', '.stamp-line.wide:before', '.prose h1', '.prose h3', '.prose pre code', '.prose.compact',
  '.btn.primary', '.btn.sel', '.btn.sm', '.btn.icon', '.btn.sm.icon', '.btn.ghost', '.btn.touch', '.btn.active', '.btn.focus', '.btn.disabled', '.btn[disabled]', '.btn .ic', '.seg .btn',
  '.chip.ok', '.chip.bad', '.chip.warn', '.chip.info', '.chip.gleam', '.chip.muted', '.chip.live', '.chip.you', '.chip.spark', '.chip.sm', '.chip:is(button)',
  '.navlist a', '.navlist button', '.navlist a.active', '.navlist .lbl', '.navlist.row', '.navlist.row a', '.navlist.row button',
  '.input:focus', '.input.sm', '.input:is(textarea)', '.input:is(select)', '.check:checked:after', '.radio.on:after', '.cmd-field input', '.cmd-field:focus-within', '.fill.ok', '.fill.warn', '.fill.bad',
  '.tab.active', '.tbl th', '.tbl tr.clickable', '.tbl .r', '.facts .k', '.facts .sep', '.kpi .v',
  '.dot.ok', '.dot.gleam', '.dot.spark', '.dot.ember', '.dot.hollow', '.dot.plain', '[data-theme=ash] .backdrop', '[data-theme=ash] .scrim', '.ground:before', '.falloff:after',
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The bodies of every rule whose selector list names exactly `selector` (the build merges equal rules). The list splits
 * on top-level commas, so `input:not([type=checkbox],[type=radio])` is one selector. */
function ruleFor(css: string, selector: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) if (splitTop(m[1], /,/).some((s) => s.trim() === selector)) out.push(m[2]);
  return out.join(';');
}

/** A class selector that ends there: `.h` matches `.h{` or `.h.card`, never `.h-4` or `.hatch`. */
const hasClass = (css: string, name: string) => new RegExp(`(?<!\\\\)\\.${escapeRe(name)}(?![\\w\\\\-])`).test(css);

/** The class names smithy/smithy.css draws: every `.name` in a selector, comments dropped. */
function smithyClasses(): Set<string> {
  const text = smithyCss().replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Set<string>();
  for (const m of text.matchAll(/([^{}]*)\{/g)) for (const c of m[1].matchAll(/\.([a-z][\w-]*)/g)) out.add(c[1]);
  return out;
}

test('every smithy utility is ported', () => {
  const source = styleCss();
  const css = builtCss();
  for (const name of UTILITIES) {
    assert.match(source, new RegExp(`@utility ${escapeRe(name)}\\s*\\{`), `style.css declares @utility ${name}`);
    assert.ok(hasClass(css, name), `the built CSS has a .${name} rule`);
  }
  // Every class smithy.css draws is a utility or a modifier inside one; the type styles of tokens.css and the layout
  // helpers stay Tailwind's (a custom `grow` would emit next to flex-grow).
  const drawn = smithyClasses();
  assert.ok(drawn.has('plate') && drawn.has('riveted') && drawn.has('facts'), `smithy.css is read (${drawn.size} classes)`);
  const LAYOUT = ['row', 'wrap', 'col', 'grow'];
  for (const name of LAYOUT) assert.doesNotMatch(source, new RegExp(`@utility ${name}\\s*\\{`), `${name} is not ported`);
  // `rv` is the old rivet span smithy.css hides; nothing renders it.
  const missing = [...drawn].filter((c) => !LAYOUT.includes(c) && c !== 'rv' && !hasClass(css, c));
  assert.deepEqual(missing, [], 'every smithy class the dashboard can use is in the build');
  for (const sel of MODIFIERS) assert.ok(css.includes(sel), `the built CSS has ${sel}`);
  // A .navlist.row item keeps its natural width (the column rule sets width: 100%), in the build and in the drawing.
  assert.match(ruleFor(css, '.navlist.row a'), /width:auto/);
  assert.ok(smithyCss().includes('.navlist.row a, .navlist.row button { width: auto;'), 'smithy/smithy.css has the .navlist.row item rule');
  assert.ok(smithyCss().includes('.prose.compact {'), 'smithy/smithy.css has the .prose.compact rules');
  assert.ok(!hasClass('.hatch{}.h-4{}', 'h') && hasClass('.h.card{}', 'h') && hasClass('.x .h{', 'h'), 'the class matcher');
  // A plate sets only its background colour, never the shorthand, so nothing composed with it paints past its cut.
  const plate = ruleFor(css, '.plate');
  assert.match(plate, /background-color:var\(--panel\)/);
  assert.doesNotMatch(plate, /(^|[;{])background(-image)?:/, 'no background shorthand or image on .plate');
});

test('plates clip and keep the grain on ::after', () => {
  const css = builtCss();
  const plate = ruleFor(css, '.plate');
  assert.match(plate, /overflow:clip/, 'a plate clips its overflow to its cut shape');
  assert.match(plate, /corner-shape:bevel/, 'the cut is a chisel line');
  assert.match(plate, /border-radius:var\(--radius-cut\)\s*var\(--radius-1\)\s*var\(--radius-cut\)\s*var\(--radius-1\)/, 'cut at top-left and bottom-right');
  assert.match(plate, /isolation:isolate/, 'the grain layer stays behind the content');
  const grain = ruleFor(css, '.plate:after');
  assert.match(grain, /background-image:var\(--hammer\)/, 'the grain is a layer of its own');
  assert.match(grain, /border-radius:inherit/);
  assert.match(grain, /corner-shape:inherit/);
  assert.match(grain, /z-index:-1/);
  assert.match(grain, /pointer-events:none/);
  // Nothing puts a background image on a plate itself, at any depth (a hovered or ember plate included).
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sels = splitTop(m[1], /,/).filter((s) => /\.plate(?![\w-])/.test(s) && !/:(after|before)/.test(s));
    if (sels.length) assert.doesNotMatch(m[2], /background-image|(^|;)background:/, `${sels.join(',')} paints a background image on the plate`);
  }
  for (const sel of ['.plate.flat:after', '.plate.open:after', '.plate.cold:after']) assert.match(ruleFor(css, sel), /display:none/, `${sel}: no grain`);
  const smithy = smithyCss();
  assert.ok(smithy.includes('.plate::after { content: ""; position: absolute; inset: 0; border-radius: inherit; corner-shape: inherit; background-image: var(--hammer);'), 'smithy/smithy.css draws the same layer');
  assert.match(/^\.plate \{([^}]*)\}/m.exec(smithy)?.[1] ?? '', /overflow: clip;/, 'and clips the plate');
});

test('button plates and controls set appearance: none', () => {
  const css = builtCss();
  for (const sel of ['.plate', '.btn', '.tab', '.chip', '.navlist a', '.navlist button', '.check', '.cmd-field input']) assert.match(ruleFor(css, sel), /appearance:none/, `${sel} sets appearance: none`);
  // The sources render plates, buttons, tabs and chips as <button>s, and every one carries one of those classes.
  const src = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? src(path.join(dir, e.name)) : e.name.endsWith('.svelte') ? [path.join(dir, e.name)] : []));
  let plates = 0;
  for (const f of src(path.join(DASHBOARD, 'src'))) for (const m of fs.readFileSync(f, 'utf8').matchAll(/<button\b[^>]*class="[^"]*\bplate\b/g)) plates += m ? 1 : 0;
  assert.ok(plates >= 2, `found ${plates} button plates (job cards, the Agents cards)`);
});

test('palette scrim and stable scrollbar gutter', () => {
  const source = styleCss();
  const scrim = /@utility scrim\s*\{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
  assert.match(scrim, /^\s*background: rgba\(5,7,10,\.35\);/, 'forge scrim is .35');
  assert.match(scrim, /\[data-theme="ash"\] & \{ background: rgba\(40,28,18,\.2\); \}/, 'ash scrim is .2');
  const css = builtCss();
  assert.match(ruleFor(css, '.scrim'), /background:(rgba\(5,7,10,\.35\)|#05070a59)/);
  assert.match(ruleFor(css, '[data-theme=ash] .scrim'), /background:(rgba\(40,28,18,\.2\)|#281c1233)/);
  assert.match(ruleFor(css, 'html'), /scrollbar-gutter:stable/, 'the built html rule keeps a stable gutter');
  const smithy = smithyCss();
  assert.match(/^html \{([^}]*)\}/m.exec(smithy)?.[1] ?? '', /scrollbar-gutter: stable;/, 'smithy/smithy.css html has it too');
  assert.ok(smithy.includes('.scrim { background: rgba(5,7,10,.35); }'), 'smithy/smithy.css .scrim');
  assert.ok(smithy.includes('[data-theme="ash"] .scrim { background: rgba(40,28,18,.2); }'), 'smithy/smithy.css ash .scrim');
  const root = (rel: string) => /class="([^"]*)"/.exec(fs.readFileSync(path.join(DASHBOARD, 'src', 'components', rel), 'utf8').replace(/<script\b[\s\S]*?<\/script>|<!--[\s\S]*?-->/g, ''))?.[1].split(/\s+/) ?? [];
  const bar = root('CommandBar.svelte');
  assert.ok(bar.includes('scrim') && !bar.includes('backdrop'), `the palette's root uses scrim (${bar.join(' ')})`);
  for (const rel of ['Settings.svelte', 'Drawer.svelte']) assert.match(fs.readFileSync(path.join(DASHBOARD, 'src', 'components', rel), 'utf8'), /class="[^"]*\bbackdrop\b/, `${rel} keeps backdrop`);
});

/** Every file under dashboard/src that holds markup or builds class strings. */
const srcFiles = (dir = path.join(DASHBOARD, 'src')): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? srcFiles(path.join(dir, e.name)) : /\.(svelte|ts)$/.test(e.name) ? [path.join(dir, e.name)] : []));

/** The class tokens a file can apply: the static part of every `class=` value and every quoted literal inside one, plus
 *  the whole literals of TS maps (TONE_CLASS, DOT, CONN_DOT) and class strings built in TS. */
function classTokensOf(text: string): string[] {
  const out: string[] = [];
  const s = text.replace(/<!--[\s\S]*?-->/g, '');
  for (const m of s.matchAll(/class=("([^"]*)"|\{([^}]*)\})/g)) {
    const v = m[2] ?? m[3] ?? '';
    const literals = [...v.matchAll(/'([^']*)'|`([^`]*)`/g)].map((x) => x[1] ?? x[2]);
    const statics = m[2] !== undefined ? v.replace(/\{[^}]*\}/g, ' ') : '';
    out.push(...statics.split(/\s+/), ...literals.flatMap((l) => l.split(/\s+/)));
  }
  for (const m of s.matchAll(/:\s*'([a-z][\w\s:.-]*)'/g)) out.push(...m[1].split(/\s+/));
  return out.filter(Boolean);
}

// The Drafting vocabulary (smithy/MIGRATION.md §2): each name has a Smithy replacement and none is left in a source.
const DRAFTING_CLASSES = ['sheet', 'ticks', 'tk', 'dashed', 'redline', 'tblock', 'dim-line', 'sketch', 'hatch', 'nav'];
const DRAFTING_PAIRS: [string, string][] = [['chip', 'rev'], ['chip', 'ink'], ['chip', 'hl'], ['dot', 'ink'], ['dot', 'red'], ['dot', 'hl']];

test('old class names are gone', () => {
  const source = styleCss();
  const css = builtCss();
  const OLD = ['card', 'btn-primary', 'nav-item', 'kpi-label', 'kpi-value', 'prose-md', 'ember-bar', 'brand-rule', ...DRAFTING_CLASSES];
  for (const name of OLD) assert.doesNotMatch(source, new RegExp(`@utility ${escapeRe(name)}\\s*\\{`), `style.css declares no @utility ${name}`);
  assert.ok(!source.includes('alias: removed in job 4'), 'no alias comments are left');
  const inline = /@source inline\("([^"]*)"\)/.exec(source)?.[1].split(/\s+/) ?? [];
  assert.ok(inline.includes('plate'), 'the @source inline list is read');
  assert.deepEqual(inline.filter((n) => OLD.includes(n)), [], 'no old names in @source inline');
  for (const name of [...OLD.slice(1), 'text-accent', 'text-ink', 'bg-ink', 'text-redline', 'bg-highlight']) assert.ok(!hasClass(css, name), `the built CSS has no .${name} rule`);
  for (const [a, b] of DRAFTING_PAIRS) assert.ok(!css.includes(`.${a}.${b}`), `the built CSS has no .${a}.${b}`);
  assert.doesNotMatch(css, /@property --sketch/, 'the sketch property is gone');
  // `.card` survives only as the title style, `.h.card`.
  const cards = [...css.matchAll(/[^{}]*\{/g)].flatMap((m) => m[0].slice(0, -1).split(',')).filter((sel) => hasClass(sel, 'card'));
  assert.ok(cards.length > 0 && cards.every((sel) => sel.trim() === '.h.card'), `.card appears only as .h.card (${cards.join(' | ')})`);
  for (const v of ['--accent', '--on-accent', '--color-accent', '--color-on-accent', '--color-ink', '--color-redline', '--color-highlight']) {
    assert.ok(!new RegExp(`${escapeRe(v)}(?![\\w-])`).test(source), `style.css has no ${v}`);
    assert.ok(!new RegExp(`${escapeRe(v)}(?![\\w-])`).test(css), `the built CSS has no ${v}`);
  }
  // kpi is the reference rule: the plate comes from `plate kpi` markup.
  assert.doesNotMatch(ruleFor(css, '.kpi'), /border|background/);
  for (const gone of ['--ember-hot', '--color-ember-hot', 'Inter', 'JetBrains Mono', 'Space Grotesk', 'IBM Plex']) assert.ok(!css.includes(gone), `${gone} is gone`);

  // No source applies a Drafting class: `dashed` survives only as Tailwind's border-dashed, `nav` only as the element.
  assert.deepEqual(classTokensOf(`<a class="sheet {x ? 'redline' : ''}"><b class={on ? 'dot hl' : 'dot'}>`), ['sheet', 'redline', 'dot', 'hl', 'dot', 'dot'], 'self-check: the class reader');
  const files = [...srcFiles(), path.join(DASHBOARD, 'index.html')];
  assert.ok(files.length > 60, `checked ${files.length} files`);
  for (const f of files) {
    const tokens = classTokensOf(fs.readFileSync(f, 'utf8'));
    const rel = path.relative(ROOT, f);
    for (const name of DRAFTING_CLASSES) assert.ok(!tokens.includes(name), `${rel} applies the Drafting class ${name}`);
    const text = fs.readFileSync(f, 'utf8');
    for (const [a, b] of DRAFTING_PAIRS) assert.doesNotMatch(text, new RegExp(`(?<![\\w-])${a} ${b}(?![\\w-])`), `${rel} applies ${a} ${b}`);
  }
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

// Corners resolve to the radius tokens (0, the 2px chamfer, the 5px nick, the 10px cut, a dot) or a small literal
// chamfer smithy.css writes (the 1px callout tick, the 3px track, the 4px check); `inherit` passes the plate's cut to its grain layer.
const ROUND_OK = /^(0|0px|1px|2px|3px|4px|5px|10px|50%|9999px|inherit|calc\(infinity\s*\*\s*1px\)|3\.40282e\+?38px|var\(--radius-(0|1|nick|cut|dot)\))$/;
// The shadows that may blur: the overlay, drawer and chrome shadows and the gleam's glow. Everything else is hard.
const BLURRED_TOKENS = ['--shadow-overlay', '--shadow-drawer', '--shadow-chrome', '--shadow-glow'];

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

test('corners are the token cuts and only the token shadows blur', () => {
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
    for (const one of splitTop(v.replace(/\)(?=[^\s,)])/g, ') '), /\s/).flatMap(resolve)) {
      radii++;
      assert.match(one, ROUND_OK, `${k}: ${v} resolves to ${one}`);
    }
  }
  assert.ok(radii >= 20, `checked ${radii} radii`);
  // Every Tailwind rounded-* is the 2px chamfer and every shadow-* the overlay, so a stray utility can never round a
  // corner or cast a soft shadow of its own (Tailwind emits them only once a source uses one).
  const source = styleCss();
  for (const k of ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl']) assert.ok(source.includes(`--radius-${k}: var(--radius-1);`), `--radius-${k} is the chamfer`);
  for (const k of ['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl']) assert.ok(source.includes(`--shadow-${k}: var(--shadow-overlay);`), `--shadow-${k} is the overlay shadow`);
  let shadows = 0;
  for (const [k, v] of decls) {
    if (!(k === 'box-shadow' || /^--tw-(inset-|ring-|inset-ring-|ring-offset-)?shadow$/.test(k) || /^--shadow-/.test(k))) continue;
    shadows++;
    if (BLURRED_TOKENS.includes(k)) continue;
    assert.deepEqual(blurred(v), [], `${k}: ${v} has a blur radius`);
  }
  assert.ok(shadows >= 8, `checked ${shadows} shadows`);
  assert.deepEqual(blurred('0 10px 15px -3px rgb(0 0 0/.1)'), ['0 10px 15px -3px rgb(0 0 0/.1)'], 'the blur check');
  assert.deepEqual(blurred('var(--tw-ring-inset,)0 0 0 calc(1px + var(--x))var(--c,currentcolor)'), []);

  for (const f of srcFiles()) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /(?<![\w-])rounded(?![\w-])/, `${path.relative(ROOT, f)} uses a bare rounded class (Tailwind's literal .25rem)`);
  }
});

test('grain off hides the ground and plate grain', () => {
  const css = builtCss();
  assert.match(ruleFor(css, 'html[data-grain=off] .ground:before'), /display:none/);
  assert.match(ruleFor(css, 'html[data-grain=off] .plate:after'), /display:none/);
  // The corner falloff is shade, not texture: it stays.
  assert.doesNotMatch(css, /html\[data-grain=off\] \.(falloff|ground\.falloff):after/, 'the falloff stays with the grain off');
  // On by default: nothing hides the grain unless the attribute says off, and the Drafting attributes are gone.
  assert.doesNotMatch(css, /data-grain=on/);
  for (const [where, text] of [['the built CSS', css], ['dashboard/style.css', styleCss()], ['dashboard/index.html', fs.readFileSync(path.join(DASHBOARD, 'index.html'), 'utf8')], ...srcFiles().map((f) => [path.relative(ROOT, f), fs.readFileSync(f, 'utf8')])])
    assert.doesNotMatch(text, /data-(grid|paper)\b|dataset\.(grid|paper)\b/, `${where} names data-grid or data-paper`);
  const smithy = smithyCss();
  assert.ok(smithy.includes('html[data-grain="off"] .ground::before'), 'smithy/smithy.css drops the ground grain');
  assert.ok(smithy.includes('html[data-grain="off"] .plate::after { display: none; }'), 'smithy/smithy.css drops the plate grain');
});

/** One declaration's value in a rule body, or undefined. */
const decl = (body: string, prop: string) => new RegExp(`(?:^|;)\\s*${escapeRe(prop)}\\s*:\\s*([^;]*)`).exec(body)?.[1].trim();
/** The quoted inline SVG a custom property holds: the first `--name: url("data:image/svg+xml…")`. */
const grainUri = (text: string, name: string) => new RegExp(`${escapeRe(name)}\\s*:\\s*url\\(\\s*"(data:image\\/svg\\+xml[^"]*)"\\s*\\)`).exec(text)?.[1];

// The grain sits on a fixed layer the size of the viewport, drawn once (no tile, so no seam), and never moves:
// no animation, no transition, no scroll. smithy/smithy.css draws the same grain at the same size.
test('the grain is fixed, static and mirrored in smithy/', () => {
  assert.equal(decl('a:1;background-size:100% 100%', 'background-size'), '100% 100%', 'self-check: decl');
  assert.equal(grainUri('x{--grain:url("data:image/svg+xml,%3Csvg%3E")}', '--grain'), 'data:image/svg+xml,%3Csvg%3E', 'self-check: grainUri');

  const css = builtCss();
  const rule = ruleFor(css, '.ground:before');
  assert.equal(decl(rule, 'position'), 'fixed', 'the grain is fixed to the viewport');
  assert.equal(decl(rule, 'background-image'), 'var(--grain)');
  assert.equal(decl(rule, 'opacity'), 'var(--grain-opacity)');
  assert.equal(decl(rule, 'mix-blend-mode'), 'var(--grain-blend)');
  assert.doesNotMatch(rule, /(^|;)\s*(animation|transition)[\w-]*\s*:/, 'the grain never animates');
  assert.equal(decl(rule, 'background-repeat'), 'no-repeat', 'the grain is drawn once');
  assert.equal(decl(rule, 'background-size'), '100% 100%', 'the grain is the size of the layer');
  for (const name of ['--grain', '--hammer']) {
    const uri = grainUri(styleCss(), name);
    assert.ok(uri, `dashboard/style.css writes ${name} inline`);
    assert.equal(grainUri(css, name), uri, `the build keeps ${name} as written`);
    assert.equal(grainUri(smithyCss(), name), uri, `smithy/smithy.css declares the same ${name}`);
    assert.doesNotMatch(decodeURIComponent(uri), /<svg[^>]*\s(width|height|viewBox)=/, `${name}: the SVG has no size of its own, so 100% 100% never stretches it`);
  }
  const before = smithyCss().slice(smithyCss().indexOf('.ground::before {')).split('\n')[0];
  assert.ok(before.includes('background-image: var(--grain); background-repeat: no-repeat; background-size: 100% 100%;'), 'smithy/smithy.css mirrors the sizing');
  assert.doesNotMatch(before, /animation|transition/, 'smithy/smithy.css never animates the grain');
});

/** The body of the first `@media` block whose prelude matches, braces balanced. */
function mediaBody(css: string, prelude: RegExp): string {
  // Every block with that prelude: Tailwind's own variants (`max-md:hidden`) emit their own block with the same query.
  const blocks = [...css.matchAll(new RegExp(`@media\\s*${prelude.source}\\s*\\{`, 'g'))];
  assert.ok(blocks.length, `the built CSS has an @media ${prelude.source} block`);
  return blocks
    .map((m) => {
      let depth = 1;
      let i = (m.index ?? 0) + m[0].length;
      for (; i < css.length && depth; i++) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0;
      return css.slice((m.index ?? 0) + m[0].length, i - 1);
    })
    .join('');
}

test('reduced motion disables transitions and animations', () => {
  const body = mediaBody(builtCss(), /\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/);
  const rule = ruleFor(body, '*');
  assert.ok(ruleFor(body, ':before') === rule && ruleFor(body, ':after') === rule, '*, ::before and ::after share the rule');
  assert.match(rule, /transition:none!important/);
  assert.match(rule, /animation:none!important/);
  // Unlayered, so the !important beats every utility's transition (the drawer's slide included).
  assert.ok(builtCss().lastIndexOf('@media(prefers-reduced-motion:reduce)') > builtCss().indexOf('.transition'), 'the block comes after the utilities');
  assert.ok(
    smithyCss().includes('@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; } }'),
    'smithy/smithy.css has the same block',
  );
});

/** Every `@media` block whose prelude matches (Tailwind's `hover:` variants emit their own): the bodies joined, and the CSS without them. */
function mediaSplit(css: string, prelude: RegExp): { inside: string; outside: string } {
  const inside: string[] = [];
  let outside = '';
  for (let rest = css; ; ) {
    const m = new RegExp(`@media\\s*${prelude.source}\\s*\\{`).exec(rest);
    if (!m) {
      outside += rest;
      break;
    }
    // This block only: mediaBody joins every block with the prelude, which would skip the rules between them.
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < rest.length && depth; i++) depth += rest[i] === '{' ? 1 : rest[i] === '}' ? -1 : 0;
    const body = rest.slice(m.index + m[0].length, i - 1);
    inside.push(body);
    outside += rest.slice(0, m.index);
    rest = rest.slice(m.index + m[0].length + body.length + 1);
  }
  return { inside: inside.join('\n'), outside };
}
const HOVER_MEDIA = /\(\s*hover\s*:\s*hover\s*\)/;

// Sheen: a hovered control's seam turns gleam and its own opaque fill takes a 10–12% gleam tint. Only where the pointer can
// hover, so a tap leaves nothing behind; the `.hover` twin is for the previews.
const SHEENED: Record<string, [string, string]> = {
  '.btn': ['.btn:hover', '.btn.hover'],
  '.navlist a': ['.navlist a:hover', '.navlist a.hover'],
  '.tab': ['.tab:hover', '.tab.hover'],
};
const SHEEN = /background-color:color-mix\(in srgb,var\(--surface,var\(--bg\)\),var\(--gleam\)1[02]%\)/;

test('hover is sheen, with no registered property', () => {
  const css = builtCss();
  assert.doesNotMatch(css, /@property --(sketch|sheen)\b/, 'no registered property drives the hover');
  assert.doesNotMatch(css, /--sketch|repeating-linear-gradient\(45deg/, 'no sketch and no hatch');
  const { inside: hover, outside: ungated } = mediaSplit(css, HOVER_MEDIA);
  const split = mediaSplit('.a{x:1}@media (hover:hover){.b:hover{y:2}}.c{z:3}', HOVER_MEDIA);
  assert.deepEqual([split.inside, split.outside], ['.b:hover{y:2}', '.a{x:1}.c{z:3}'], 'self-check: the media splitter');
  for (const [sel, [on, twin]] of Object.entries(SHEENED)) {
    assert.match(ruleFor(hover, on), SHEEN, `${on} takes the sheen, inside @media (hover:hover)`);
    assert.match(ruleFor(css, twin), SHEEN, `${twin} takes the sheen (previews)`);
    assert.doesNotMatch(ruleFor(ungated, on), /color-mix\(in srgb,var\(--surface,var\(--bg\)\),var\(--gleam\)/, `${on} sheens only inside @media (hover:hover)`);
    assert.doesNotMatch(ruleFor(css, sel), /background-image/, `${sel} draws no image at rest`);
  }
  assert.match(ruleFor(hover, '.btn:hover'), /border-color:var\(--gleam\)/, 'the seam turns gleam');
  assert.match(ruleFor(hover, '.btn:hover .muted'), /color:inherit/, 'muted text in a hovered button takes its fg');
  assert.match(ruleFor(css, '.btn.hover .muted'), /color:inherit/);
  // Selected, primary, pressed and disabled buttons, the active nav item and the active tab never take the sheen tint.
  for (const sel of ['.btn.sel', '.btn.primary', '.btn.primary:active']) assert.match(ruleFor(css, sel), /background:var\(--gleam-fill\)/, `${sel} is the brushed gleam`);
  assert.match(ruleFor(hover, '.btn.primary:hover'), /background:var\(--gleam-fill-hot\)/, 'a hovered primary goes gleam-hot');
  assert.match(ruleFor(hover, '.btn.primary:hover'), /var\(--shadow-glow\)/, 'and glows');
  for (const sel of ['.navlist a.active', '.tab.active']) assert.doesNotMatch(ruleFor(css, sel), SHEEN, `${sel} takes no sheen`);
  // A button chip only lights its seam: a chip inside a hovered control stays plain.
  assert.match(ruleFor(hover, '.chip:is(button):hover'), /^border-color:currentColor$/i);
  for (const m of css.matchAll(/animation(-name)?:([^;}]*)/g)) assert.doesNotMatch(m[2], /sketch|sheen/, 'hover is a transition, never an animation');
  assert.equal(css.match(/prefers-reduced-motion\s*:\s*reduce/g)?.length, 1, 'one reduced-motion block covers every transition (the live halo is the separate no-preference query)');
  const smithy = smithyCss();
  for (const line of [
    '@media (hover: hover) { .btn:hover { border-color: var(--gleam); background-color: color-mix(in srgb, var(--surface, var(--bg)), var(--gleam) 12%); } .btn:hover .muted { color: inherit; } }',
    '.tab:hover, .tab.hover { color: var(--fg); background-color: color-mix(in srgb, var(--surface, var(--bg)), var(--gleam) 10%); }',
    '@media (hover: hover) { button.chip:hover { border-color: currentColor; } }',
  ])
    assert.ok(smithy.includes(line), `smithy/smithy.css draws ${line}`);
});

/** Every `selector { body }` whose selector list has the `plate` class, at any nesting (@media, @supports). */
const plateRules = (css: string) =>
  [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].filter((m) => m[1].split(',').some((s) => hasClass(s, 'plate'))).map((m) => [m[1].trim(), m[2]] as const);

// A card is the dashboard's most-hovered surface: its seam hardens to line-strong at once, nothing fills, fades or glows.
test('a card hovers at once, with no sheen', () => {
  const css = builtCss();
  const { inside: hover, outside: ungated } = mediaSplit(css, HOVER_MEDIA);
  const plates = plateRules(css);
  assert.ok(plates.length >= 10, `the built CSS has the plate rules (${plates.length})`);
  for (const [sel, body] of plates) assert.doesNotMatch(body, /transition|--gleam\)1[02]%/, `${sel} sets no transition and no sheen`);
  assert.deepEqual(plateRules('.plate-title{transition:x}.x .plate.y{a:b}@supports (c:d){.plate.clickable{e:f}}').map(([s]) => s), ['.x .plate.y', '.plate.clickable'], 'self-check: the plate rule finder');

  const card = ruleFor(css, '.plate.clickable');
  assert.match(card, /cursor:pointer/);
  assert.doesNotMatch(card, /background-image|transition/, `.plate.clickable draws nothing at rest (${card})`);
  for (const [sel, body] of [['.plate.clickable:hover', ruleFor(hover, '.plate.clickable:hover')], ['.plate.hover', ruleFor(css, '.plate.hover')]]) {
    assert.match(body, /border-color:var\(--line-strong\)/, `${sel} hardens the seam`);
    assert.match(body, /background-color:var\(--panel\)/, `${sel} keeps its panel`);
    assert.doesNotMatch(body, /box-shadow|background-image/, `${sel} neither glows nor draws (${body})`);
  }
  assert.equal(ruleFor(ungated, '.plate.clickable:hover'), '', '.plate.clickable:hover only inside @media (hover:hover)');
  // A card waiting on you keeps its ember seam and bar when hovered.
  assert.match(ruleFor(hover, '.plate.ember.clickable:hover'), /border-color:var\(--ember\)/);
  assert.match(ruleFor(css, '.plate.ember'), /box-shadow:inset var\(--bar-rule\)0 0 0 var\(--ember\),var\(--shadow-bevel\)/, 'an ember plate has its 3px bar');

  // The utility a table row uses: it changes at once and washes with raised.
  const clickable = ruleFor(css, '.clickable');
  assert.match(clickable, /cursor:pointer/);
  assert.doesNotMatch(clickable, /transition/, `.clickable changes at once (${clickable})`);
  const washed = ruleFor(css, '.clickable:hover');
  assert.match(washed, /background-color:var\(--raised\)/, 'a clickable row still washes with raised');
  assert.match(washed, /border-color:var\(--line-strong\)/);
});

test('the grain lives only on the ground and plates', () => {
  const css = builtCss();
  let urls = 0;
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const [selector, body] = [m[1].trim(), m[2]];
    if (body.includes('url(') && !selector.startsWith('@font-face')) {
      urls++;
      assert.equal(selector, ':root', `${selector} carries a texture outside the :root grain tokens`);
    }
    if (/var\(--grain\)/.test(body) && !/^--grain/.test(body)) assert.equal(selector, '.ground:before', `${selector} draws the ground grain`);
    if (/var\(--hammer\)/.test(body)) assert.equal(selector, '.plate:after', `${selector} draws the plate grain`);
  }
  assert.equal(urls, 1, 'one :root block holds the two grain URIs');
  const sources: [string, string][] = [
    ['the built CSS', css],
    ['dashboard/style.css', styleCss()],
  ];
  for (const name of ['hatch', 'hatch-dense', 'crosshatch', 'sketch', 'ticks']) {
    for (const [where, text] of sources) {
      const rules = [...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{};]*)\{/g)].map((x) => x[1]);
      assert.ok(!rules.some((sel) => hasClass(sel, name) || new RegExp(`@utility ${name}\\s*$`).test(sel.trim())), `${where} has no .${name} rule`);
    }
  }
});

test('surfaces are opaque and open plates are see-through', () => {
  const css = builtCss();
  for (const sel of ['.solid', '.plain', '.plate', '.plate.solid', '.chrome']) {
    const rule = ruleFor(css, sel);
    assert.match(rule, /background-color:var\(--(panel|chrome)\)/, `${sel} fills with an opaque token`);
    assert.doesNotMatch(rule, /(^|;)background:/, `${sel} uses background-color, never the shorthand`);
  }
  for (const sel of ['.solid', '.plain', '.plate', '.plate.solid']) assert.match(ruleFor(css, sel), /background-color:var\(--panel\)/, `${sel} is panel`);
  assert.match(ruleFor(css, 'select option'), /background:var\(--panel\)/, 'the open list is panel');
  const open = ruleFor(css, '.plate.open');
  assert.match(open, /background-color:#0000|background-color:transparent/, 'a board column stays a container drawn on the ground');
  assert.match(open, /--surface:var\(--bg\)/, 'what sits in it fills with bg');
  assert.match(open, /border-color:var\(--line-soft\)/);
  assert.match(ruleFor(css, '.plate.cold'), /border-style:dashed/, 'the empty state is a dashed plate');
  const smithy = smithyCss();
  for (const line of ['.solid { background-color: var(--panel); --surface: var(--panel); }', '.plain { background-color: var(--panel); --surface: var(--panel); }', '.plate.solid { background-color: var(--panel); }', '.plate.cold { border-style: dashed; box-shadow: none; }'])
    assert.ok(smithy.includes(line), `smithy/smithy.css has ${line}`);
});

test('every control has the solid focus ring', () => {
  const css = builtCss();
  const RING = /outline:2px solid var\(--line-strong\)/;
  assert.match(ruleFor(css, ':focus-visible'), RING, 'a base ring for every focusable element');
  const check = ruleFor(css, '.check');
  assert.match(check, /appearance:none/, 'the checkbox is drawn, not the OS one');
  assert.match(ruleFor(css, '.check:checked'), /background:var\(--gleam-fill\)/, 'a checked box is brushed gleam');
  assert.match(ruleFor(css, '.check:checked:after'), /border:solid var\(--on-gleam\)/, 'with an on-gleam tick');
  assert.match(ruleFor(css, '.check:disabled'), /border-style:dashed/);
  assert.match(ruleFor(css, 'input[type=checkbox]:focus-visible'), RING, 'a drawn checkbox keeps the ring');
  assert.match(ruleFor(css, '.seg label:has(input:focus-visible)'), RING, 'a radio seg rings the focused label');
  for (const sel of ['.btn:focus-visible', '.navlist a:focus-visible', '.clickable:focus-visible', '.plate.clickable:focus-visible', '.input:focus', '.cmd-field:focus-within']) assert.match(ruleFor(css, sel), RING, sel);
  assert.doesNotMatch(css, /:focus(-visible)?\{[^}]*box-shadow/, 'no glow on focus');
  assert.doesNotMatch(css, /outline:1px dashed/, 'the Drafting dashed ring is gone');
  const smithy = smithyCss();
  for (const line of [
    ':focus-visible { outline: 2px solid var(--line-strong); outline-offset: 2px; }',
    '.check:disabled { opacity: .4; border-style: dashed; cursor: not-allowed; }',
    '.check.on::after, .check:checked::after {',
    '.seg label:has(input:focus-visible) { outline: 2px solid var(--line-strong); outline-offset: 2px; z-index: 1; }',
  ])
    assert.ok(smithy.includes(line), `smithy/smithy.css mirrors ${line}`);
});

test('phone targets are 44px', () => {
  // `width < 48rem` is built as `not all and (min-width:48rem)` or `not all and (width>=48rem)`; accept any.
  const body = mediaBody(builtCss(), /(\(\s*width\s*<\s*48rem\s*\)|not all and \((min-width:|width>=)48rem\))/);
  const TARGETS = ['button:not(.chip)', 'a.btn', '.navlist a', '[role=tab]', '[role=option]', 'summary', 'select', 'input:not([type=checkbox],[type=radio])', 'label:has(>input[type=checkbox])', 'label:has(>input[type=radio])'];
  // Split on top-level commas only: `input:not([type=checkbox],[type=radio])` holds one.
  const tall = [...body.matchAll(/([^{}]*)\{([^{}]*)\}/g)].filter((m) => /min-height:44px/.test(m[2])).flatMap((m) => splitTop(m[1], /,/));
  for (const sel of TARGETS) assert.ok(tall.includes(sel), `${sel} is 44px tall on phones (${tall.join(' | ')})`);
  assert.match(ruleFor(body, '.btn.icon'), /min-width:44px/, 'icon buttons are 44px wide too');
  assert.match(ruleFor(body, '.chip:is(button)'), /position:relative/);
  const hit = ruleFor(body, '.chip:is(button):after');
  assert.match(hit, /content:""/);
  assert.match(hit, /width:max\(100%,\s*44px\)/);
  assert.match(hit, /height:max\(100%,\s*44px\)/);
  assert.match(hit, /position:absolute/);
  // The chip's hit area sits under its neighbours (a tap just outside a chip reaches the control there).
  assert.match(hit, /z-index:-1/);
  assert.match(ruleFor(body, ':has(>.chip:is(button))'), /isolation:isolate/);
  // A checkbox without a label around it (a config boolean) gets a 44px hit area too.
  const box = ruleFor(body, '.check:not(label>.check):before');
  assert.match(box, /width:44px/);
  assert.match(box, /height:44px/);
  assert.match(box, /position:absolute/);
});

test('the YOU chip is the same rectangle as every chip', () => {
  const css = builtCss();
  const built = ruleFor(css, '.chip.you');
  const drawn = /^\.chip\.you \{([^}]*)\}/m.exec(smithyCss())?.[1] ?? /\.chip\.you \{([^}]*)\}/.exec(smithyCss())?.[1] ?? '';
  assert.ok(drawn, 'smithy/smithy.css draws .chip.you');
  for (const [where, rule] of [['the built CSS', built], ['smithy/smithy.css', drawn]]) {
    assert.match(rule, /color:\s*var\(--ember\)/, `${where}: .chip.you is ember`);
    assert.match(rule, /border-color:\s*var\(--ember\)/, `${where}: with an ember seam`);
    assert.doesNotMatch(rule, /border-radius|corner-shape/, `${where}: .chip.you keeps the chip's nicked corners`);
    assert.doesNotMatch(rule, /(^|[;\s])padding/, `${where}: .chip.you keeps the chip padding`);
  }
  // The tint is 10%, like every tone: 12% puts ash's ember under 4.5:1 on the ground (dashboard-tokens.test.ts).
  assert.match(built, /var\(--ember\)\s*10%/);
  for (const [where, text] of [
    ['smithy/tokens.css', fs.readFileSync(path.join(SMITHY, 'tokens.css'), 'utf8')],
    ['smithy/tokens.json', fs.readFileSync(path.join(SMITHY, 'tokens.json'), 'utf8')],
    ['dashboard/style.css', styleCss()],
    ['the built CSS', css],
  ])
    assert.ok(!text.includes('radius-tag'), `${where} has no radius-tag`);
});

// ---------- control sizing: four height tokens, one per variant ----------
const CONTROL_TOKENS: [string, string][] = [['control-xs', '20px'], ['control-sm', '28px'], ['control-md', '32px'], ['control-lg', '40px']];
/** The scalar `:root {` block of a source stylesheet (the theme blocks start `:root, [data-theme…`). */
const scalarRoot = (text: string) => /^:root \{([^}]*)\}/m.exec(text)?.[1] ?? '';
/** A one-line rule body in smithy/smithy.css, by its exact selector at the start of a line. */
const drawn = (selector: string) => new RegExp(`^${escapeRe(selector)} \\{([^}]*)\\}`, 'm').exec(smithyCss())?.[1] ?? '';
/** The scalar tokens of smithy/tokens.json (spacing, sizes, controls, strokes). */
const scalarTokens = (): { name: string; value: string; usage: string }[] => JSON.parse(fs.readFileSync(path.join(SMITHY, 'tokens.json'), 'utf8')).spacing.tokens;
/** The vertical padding each declaration sets: the first value of `padding`, `padding-block`, `padding-top` and `padding-bottom`. */
function verticalPadding(rule: string): string[] {
  const out: string[] = [];
  for (const m of rule.matchAll(/(?:^|;)\s*(padding(?:-block|-top|-bottom)?)\s*:\s*([^;]*)/g)) out.push(splitTop(m[2].replace(/\)(?=[^\s,)])/g, ') '), /\s/)[0]);
  return out;
}
const MIN_MD = /(\(\s*width\s*>=\s*48rem\s*\)|\(min-width:48rem\))/;

test('control heights are tokens in the drawing, the source and the build', () => {
  const tokensCss = scalarRoot(fs.readFileSync(path.join(SMITHY, 'tokens.css'), 'utf8'));
  const source = scalarRoot(styleCss());
  const sizes = scalarTokens();
  const built = ruleFor(builtCss(), ':root');
  assert.ok(tokensCss.includes('--size-dialog') && source.includes('--size-dialog'), 'the scalar :root blocks are read');
  for (const [name, value] of CONTROL_TOKENS) {
    assert.ok(tokensCss.includes(`--${name}: ${value};`), `smithy/tokens.css :root declares --${name}: ${value}`);
    assert.ok(source.includes(`--${name}: ${value};`), `dashboard/style.css :root declares --${name}: ${value}`);
    assert.ok(built.includes(`--${name}:${value}`), `the built :root carries --${name}:${value}`);
    const entry = sizes.find((t) => t.name === name);
    assert.equal(entry?.value, value, `smithy/tokens.json has ${name} = ${value}`);
    assert.ok(entry?.usage?.trim(), `smithy/tokens.json ${name} has a usage`);
  }
});

test('the status bar height is a token in the drawing, the source and the build', () => {
  const tokensCss = scalarRoot(fs.readFileSync(path.join(SMITHY, 'tokens.css'), 'utf8'));
  const source = scalarRoot(styleCss());
  assert.ok(tokensCss.includes('--size-dialog') && source.includes('--size-dialog'), 'the scalar :root blocks are read');
  assert.ok(tokensCss.includes('--size-statusbar: 36px;'), 'smithy/tokens.css :root declares --size-statusbar: 36px');
  assert.ok(source.includes('--size-statusbar: 36px;'), 'dashboard/style.css :root declares --size-statusbar: 36px');
  const css = builtCss();
  const { outside } = mediaSplit(css, /[^{]*/);
  assert.ok(ruleFor(outside, ':root').includes('--size-statusbar:36px'), 'the built :root carries --size-statusbar:36px');
  // Below md the bar holds 44px targets, so it grows to --space-11 there; everything that clears it reads the token.
  const phone = mediaBody(css, /(\(\s*width\s*<\s*48rem\s*\)|not all and \((min-width:|width>=)48rem\))/);
  assert.match(ruleFor(phone, ':root'), /--size-statusbar:var\(--space-11\)/, 'below md the bar is 44px tall');
  const entry = scalarTokens().find((t) => t.name === 'size-statusbar');
  assert.equal(entry?.value, '36px', 'smithy/tokens.json has size-statusbar = 36px');
  assert.ok(entry?.usage?.trim(), 'with a usage');
});

test('focus scrolls clear of the status bar, and an open indicator keeps its edge', () => {
  const css = builtCss();
  // WCAG 2.4.11: the bar is fixed over the viewport's bottom, so focus and scroll-into-view stop above it.
  assert.match(ruleFor(css, 'html'), /scroll-padding-bottom:calc\(var\(--size-statusbar\) \+ env\(safe-area-inset-bottom\) \+ var\(--space-2\)\)/, 'html pads its scroll by the bar, the inset and a gap');
  assert.match(ruleFor(css, '.btn.ghost[aria-expanded=true]'), /border-color:var\(--line-strong\)/, 'the built CSS draws an open indicator with the strong edge');
  assert.ok(smithyCss().includes('.btn.ghost[aria-expanded="true"] { border-color: var(--line-strong);'), 'smithy/smithy.css draws it too');
  assert.ok(css.indexOf('.btn.ghost[aria-expanded=true]') > css.indexOf('.btn.ghost:hover'), 'after the ghost hover, so hovering an open indicator keeps it');
});

test('every control variant resolves to one control height', () => {
  const css = builtCss();
  const { inside: md, outside } = mediaSplit(css, MIN_MD);
  const INPUT = 'input:not([type=checkbox],[type=radio])';
  const SIZE: [string, string, string][] = [
    ['.btn', 'height', 'control-md'],
    ['.btn.sm', 'height', 'control-sm'],
    ['.chip', 'min-height', 'control-xs'],
    ['.chip.sm', 'min-height', 'control-sm'],
    ['.input', 'min-height', 'control-md'],
    ['.input.sm', 'min-height', 'control-sm'],
    ['.tab', 'height', 'control-lg'],
  ];
  for (const [sel, prop, token] of SIZE) {
    const rule = ruleFor(outside, sel);
    assert.ok(new RegExp(`(^|;)${prop}:var\\(--${token}\\)(;|$)`).test(rule), `${sel} sets ${prop}:var(--${token}) (${rule})`);
    for (const other of CONTROL_TOKENS.map(([n]) => n).filter((n) => n !== token)) assert.ok(!rule.includes(`var(--${other})`), `${sel} names only --${token}`);
  }
  for (const sel of ['.btn', '.btn.sm', '.tab']) assert.deepEqual(verticalPadding(ruleFor(outside, sel)).filter((v) => v !== '0'), [], `${sel} has no vertical padding`);
  for (const [sel, token] of [['.input', 'control-md'], ['.input.sm', 'control-sm']]) {
    const pads = verticalPadding(ruleFor(outside, sel));
    assert.ok(pads.length > 0 && pads.every((v) => v.startsWith(`calc((var(--${token})`)), `${sel} pads with a calc() of --${token} (${pads.join(' | ')})`);
  }
  // The unlayered native rules: md everywhere, sm only from 48rem up (more specific, they would beat the phone 44px).
  for (const sel of [INPUT, 'select']) {
    const rule = ruleFor(outside, sel);
    assert.match(rule, /(^|;)min-height:var\(--control-md\)/, `${sel} is md`);
    assert.ok(verticalPadding(rule).some((v) => v.startsWith('calc((var(--control-md)')), `${sel} pads with a calc() of --control-md`);
  }
  assert.match(ruleFor(outside, 'textarea'), /min-height:var\(--control-md\)/, 'a textarea is at least md');
  for (const sel of ['input.sm:not([type=checkbox],[type=radio])', 'select.sm']) {
    assert.match(ruleFor(md, sel), /min-height:var\(--control-sm\)/, `${sel} is sm inside @media (width >= 48rem)`);
    assert.ok(verticalPadding(ruleFor(md, sel)).every((v) => v.startsWith('calc((var(--control-sm)')), `${sel} pads with a calc() of --control-sm`);
    assert.doesNotMatch(ruleFor(outside, sel), /min-height/, `${sel} sets no height outside the md block`);
  }
  const source = styleCss();
  assert.match(source, /@media \(width >= 48rem\) \{\n\s*input\.sm:not\(\[type=checkbox\], \[type=radio\]\), select\.sm \{/, 'style.css keeps native sm inside the md block');

  // The drawing.
  const D: [string, RegExp][] = [
    ['.btn', /height: var\(--control-md\); padding: 0 12px;/],
    ['.btn.sm', /height: var\(--control-sm\); padding: 0 9px;/],
    ['.chip', /min-height: var\(--control-xs\);/],
    ['.chip.sm', /min-height: var\(--control-sm\);/],
    ['.input', /min-height: var\(--control-md\); padding: calc\(\(var\(--control-md\) - 20px\) \/ 2\) 10px;/],
    ['.input.sm', /min-height: var\(--control-sm\); padding-block: calc\(\(var\(--control-sm\) - 20px\) \/ 2\);/],
    ['.tab', /height: var\(--control-lg\);.*padding: 0 14px;/],
  ];
  for (const [sel, want] of D) assert.match(drawn(sel), want, `smithy/smithy.css ${sel}`);
});

test("icon buttons are square at their text siblings' height", () => {
  const css = builtCss();
  const icon = ruleFor(css, '.btn.icon');
  assert.match(icon, /(^|;)width:var\(--control-md\)/);
  assert.match(icon, /(^|;)padding:0(;|$)/);
  assert.match(icon, /justify-content:center/);
  const sm = ruleFor(css, '.btn.sm.icon');
  assert.match(sm, /(^|;)width:var\(--control-sm\)/);
  assert.match(sm, /(^|;)padding:0(;|$)/, "beats .btn.sm's horizontal padding");
  assert.match(ruleFor(css, '.btn'), /align-items:center/, 'the icon is centred vertically');
  assert.match(drawn('.btn.icon'), /width: var\(--control-md\); padding: 0; justify-content: center;/);
  assert.match(drawn('.btn.sm.icon'), /width: var\(--control-sm\); padding: 0;/);
});

test('the ghost close keeps the sheen and a light border', () => {
  const css = builtCss();
  const { inside: hover } = mediaSplit(css, HOVER_MEDIA);
  assert.match(ruleFor(css, '.btn.ghost'), /border-color:(transparent|#0000)/, 'no border at rest');
  assert.match(ruleFor(css, '.btn.ghost'), /box-shadow:none/, 'and no bevel');
  assert.match(ruleFor(hover, '.btn.ghost:hover'), /border-color:var\(--line\)/, 'hover draws --line, inside @media (hover:hover)');
  assert.match(ruleFor(css, '.btn.ghost.hover'), /border-color:var\(--line\)/);
  const ghosts = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].filter((m) => hasClass(m[1], 'ghost'));
  assert.ok(ghosts.length >= 3, `found ${ghosts.length} ghost rules`);
  for (const [, sel, body] of ghosts.filter(([, s]) => !/aria-expanded/.test(s))) assert.doesNotMatch(body, /background/, `${sel.trim()} leaves the fill (and the sheen) to btn`);
  const smithy = smithyCss();
  for (const line of ['.btn.ghost { border-color: transparent; box-shadow: none; }', '@media (hover: hover) { .btn.ghost:hover { border-color: var(--line); } }', '.btn.ghost.hover { border-color: var(--line); }'])
    assert.ok(smithy.includes(line), `smithy/smithy.css has ${line}`);
});

test('the control sizes are documented in the tokens and drawn in the previews', () => {
  const sizes = scalarTokens();
  const usage = (name: string) => sizes.find((t) => t.name === name)?.usage ?? '';
  assert.match(usage('control-xs'), /chip/i, 'xs is the chip');
  assert.match(usage('control-sm'), /small button, input or chip/i, 'sm is the small control');
  assert.match(usage('control-md'), /button and input/i, 'md is the standard control');
  assert.match(usage('control-lg'), /tab/i, 'lg is the tab');
  // The previews draw the close as the same quiet control the dashboard renders (CloseButton.svelte: btn icon ghost).
  const preview = (name: string) => fs.readFileSync(path.join(SMITHY, 'components', name, 'preview.html'), 'utf8');
  for (const name of ['Button', 'Drawer', 'SettingsDialog']) assert.match(preview(name), /<button class="btn icon ghost" aria-label="Close">/, `${name} preview draws btn icon ghost`);
  assert.match(preview('CommandBar'), /<button class="btn icon sm ghost" aria-label="Remove the job scope">/, 'CommandBar preview: the clear-scope close is sm ghost beside chip sm');
  assert.match(preview('CommandBar'), /class="chip gleam sm"/);
  assert.match(fs.readFileSync(path.join(DASHBOARD, 'src', 'components', 'CloseButton.svelte'), 'utf8'), /class="btn icon ghost /);
});
