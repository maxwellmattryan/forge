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
  'ground falloff plain chrome hatch hatch-dense crosshatch sheet ticks redline dashed solid clickable h label callout mono num muted dimmed caption ' +
  'dim-line prose btn seg chip nav input check radio field track fill tabs tab tbl tblock kpi ic dot backdrop mark'
).split(' ');
// Compound selectors as the build writes them (minified, attribute quotes dropped).
const MODIFIERS = [
  '.sheet.clickable', '.sheet.hover', '.sheet.redline', '.sheet.dashed', '.sheet.solid', '.ticks>.tk', '.ticks:before', '.ticks>.tk:after',
  '.h.display', '.h.page', '.h.sheet-title', '.h.section', '.h.card', '.callout:before', '.dim-line .end', '.prose h1', '.prose h3', '.prose pre code', '.prose.compact',
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
  assert.ok(fs.readFileSync(path.join(ROOT, 'design', 'drafting.css'), 'utf8').includes('.prose.compact {'), 'design/drafting.css has the .prose.compact rules');
  assert.ok(!hasClass('.hatch{}.h-4{}', 'h') && hasClass('.h.card{}', 'h') && hasClass('.x .h{', 'h'), 'the class matcher');
  // A sheet sets only its background colour, so `sheet clickable` keeps its sketch.
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

const ROUND_OK = /^(0|0px|50%|9999px|calc\(infinity\s*\*\s*1px\)|3\.40282e\+?38px|var\(--radius-dot\))$/;

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

/** The body of the first `@media` block whose prelude matches, braces balanced. */
function mediaBody(css: string, prelude: RegExp): string {
  const m = new RegExp(`@media\\s*${prelude.source}\\s*\\{`).exec(css);
  assert.ok(m, `the built CSS has an @media ${prelude.source} block`);
  let depth = 1;
  let i = m.index + m[0].length;
  for (; i < css.length && depth; i++) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0;
  return css.slice(m.index + m[0].length, i - 1);
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
    draftingCss().includes('@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; } }'),
    'design/drafting.css has the same block',
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
    const body = mediaBody(rest.slice(m.index), prelude);
    inside.push(body);
    outside += rest.slice(0, m.index);
    rest = rest.slice(m.index + m[0].length + body.length + 1);
  }
  return { inside: inside.join('\n'), outside };
}
const HOVER_MEDIA = /\(\s*hover\s*:\s*hover\s*\)/;

// The sketch, as the build writes it. `transparent` leads the mix: Tailwind's color-mix fallback keeps the
// first colour, so a browser without color-mix draws no sketch rather than a full-strength one.
const SKETCH_IMAGE = 'background-image:repeating-linear-gradient(45deg,color-mix(in srgb,transparent,var(--sketch-line)var(--sketch))0 1px,transparent 1px var(--hatch-pitch))';
const SKETCH_AT_REST = 'background-position:calc(-1*var(--hatch-pitch))0';
const SKETCH_ON = /--sketch:100%;background-position:0 0(;|$)/;
const SKETCHED = ['.sheet.clickable', '.btn', '.nav a', '.tab', '.chip:is(button)'];
/** The hover rule of each sketched control, and its `.hover` twin for the previews (chips have none). */
const HOVER: Record<string, [string, string | null]> = {
  '.sheet.clickable': ['.sheet.clickable:hover', '.sheet.hover'],
  '.btn': ['.btn:hover', '.btn.hover'],
  '.nav a': ['.nav a:hover', '.nav a.hover'],
  '.tab': ['.tab:hover', '.tab.hover'],
  '.chip:is(button)': ['.chip:is(button):hover', null],
};

test('the sketch hover is one registered property', () => {
  const css = builtCss();
  const property = /@property --sketch\{([^}]*)\}/.exec(css)?.[1];
  assert.equal(property, 'syntax:"<percentage>";inherits:false;initial-value:0%', 'the built CSS registers --sketch, not inherited');
  const sketch = ruleFor(css, '.sketch');
  assert.ok(sketch.includes(SKETCH_IMAGE), `.sketch draws var(--sketch-line) at var(--sketch) (${sketch})`);
  assert.ok(sketch.includes(SKETCH_AT_REST), '.sketch starts one pitch off');

  const { inside: hover, outside: ungated } = mediaSplit(css, HOVER_MEDIA);
  const split = mediaSplit('.a{x:1}@media (hover:hover){.b:hover{y:2}}.c{z:3}', HOVER_MEDIA);
  assert.deepEqual([split.inside, split.outside], ['.b:hover{y:2}', '.a{x:1}.c{z:3}'], 'self-check: the media splitter');
  for (const sel of ['.sketch', ...SKETCHED]) {
    const rest = ruleFor(css, sel);
    assert.ok(rest.includes(SKETCH_IMAGE), `${sel} declares the sketch at rest`);
    assert.ok(rest.includes(SKETCH_AT_REST), `${sel} starts the sketch one pitch off`);
    assert.match(rest, /transition:--sketch \.16s ease-out,background-position \.16s ease-out/, `${sel} transitions the registered --sketch`);
    const [on, twin] = HOVER[sel] ?? ['.sketch:hover', '.sketch.hover'];
    assert.match(ruleFor(hover, on), SKETCH_ON, `${on} sketches, inside @media (hover:hover)`);
    if (twin) assert.match(ruleFor(css, twin), SKETCH_ON, `${twin} sketches (previews)`);
    // Ungated, a tap on a touch screen would leave the lines on.
    assert.doesNotMatch(ruleFor(ungated, on), /--sketch:/, `${on} sets --sketch only inside @media (hover:hover)`);
  }
  assert.match(ruleFor(hover, '.sheet.clickable:hover'), /background-color:var\(--panel\)/, 'a hovered card keeps its panel');
  assert.match(ruleFor(css, '.sheet.hover'), /background-color:var\(--panel\)/);
  assert.match(ruleFor(hover, '.btn:hover .muted'), /color:inherit/, 'muted text in a hovered button takes its fg');
  assert.match(ruleFor(css, '.btn.hover .muted'), /color:inherit/);
  // Selected, primary, pressed and disabled buttons, the active nav item and the active tab drop the image.
  for (const sel of ['.btn.sel', '.btn.primary', '.btn:active']) assert.match(ruleFor(css, sel), /background:var\(--ink\)/, `${sel} resets the background`);
  for (const sel of ['.btn[disabled]', '.nav a.active', '.tab.active']) assert.match(ruleFor(css, sel), /background-image:none/, `${sel} drops the sketch`);

  for (const m of css.matchAll(/animation(-name)?:([^;}]*)/g)) assert.doesNotMatch(m[2], /sketch/, 'the sketch is a transition, not an animation');
  assert.doesNotMatch(css, /@keyframes[^{]*sketch/);
  assert.equal(css.match(/prefers-reduced-motion/g)?.length, 1, 'one reduced-motion block covers the sketch');

  const drafting = draftingCss();
  const S = 'background-image: repeating-linear-gradient(45deg, color-mix(in srgb, transparent, var(--sketch-line) var(--sketch)) 0 1px, transparent 1px var(--hatch-pitch)); background-position: calc(-1 * var(--hatch-pitch)) 0;';
  const H = '--sketch: 100%; background-position: 0 0;';
  for (const line of [
    '@property --sketch { syntax: "<percentage>"; inherits: false; initial-value: 0%; }',
    `.sketch { ${S} transition: --sketch .16s ease-out, background-position .16s ease-out, border-color .12s ease, color .12s ease; }`,
    `@media (hover: hover) { .sketch:hover { ${H} } }`,
    `.sketch.hover { ${H} }`,
    '.chrome { background-color: var(--chrome); }',
    `.sheet.clickable { cursor: pointer; ${S} transition: --sketch .16s ease-out, background-position .16s ease-out, border-color .12s ease; }`,
    `@media (hover: hover) { .sheet.clickable:hover { border-color: var(--line-strong); background-color: var(--panel); ${H} } }`,
    `.sheet.hover { border-color: var(--line-strong); background-color: var(--panel); ${H} }`,
    `@media (hover: hover) { .btn:hover { ${H} } .btn:hover .muted { color: inherit; } }`,
    `.btn.hover { ${H} }`,
    `@media (hover: hover) { button.chip:hover { ${H} } }`,
    `@media (hover: hover) { .nav a:hover, .nav button:hover { ${H} } }`,
    `.nav a.hover { ${H} }`,
    `@media (hover: hover) { .tab:hover { ${H} } }`,
    `.tab.hover { ${H} }`,
  ])
    assert.ok(drafting.includes(line), `design/drafting.css mirrors ${line}`);
  for (const sel of ['.btn {', 'button.chip {', '.nav a, .nav button {', '.tab {']) {
    const rule = drafting.slice(drafting.indexOf(sel)).split('\n')[0];
    assert.ok(rule.includes(S) && rule.includes('transition: --sketch .16s ease-out'), `design/drafting.css ${sel} declares the sketch at rest`);
  }
});

test('surfaces are opaque and dashed strips nothing', () => {
  const css = builtCss();
  assert.doesNotMatch(ruleFor(css, '.dashed'), /background/, '.dashed sets only the border, so the ⌘K btn dashed keeps its sketch');
  for (const sel of ['.solid', '.plain', '.sheet.solid', '.chrome']) {
    const rule = ruleFor(css, sel);
    assert.match(rule, /background-color:var\(--(panel|chrome)\)/, `${sel} fills with an opaque token`);
    assert.doesNotMatch(rule, /(^|;)background:/, `${sel} uses background-color, never the shorthand`);
  }
  for (const sel of ['.solid', '.plain', '.sheet.solid', '.tab.active']) assert.match(ruleFor(css, sel), /background-color:var\(--panel\)/, `${sel} is panel`);
  assert.match(ruleFor(css, 'select option'), /background:var\(--panel\)/, 'the open list is panel');
  assert.match(ruleFor(css, '.sheet.dashed'), /background-color:#0000|background-color:transparent/, 'a board column stays a container drawn on the ground');
  const drafting = draftingCss();
  for (const line of ['.solid { background-color: var(--panel); }', '.plain { background-color: var(--panel); }', '.sheet.solid { background-color: var(--panel); }', '.dashed { border-style: dashed; }'])
    assert.ok(drafting.includes(line), `design/drafting.css has ${line}`);
});

test('every control has the drafting focus ring', () => {
  const css = builtCss();
  assert.match(ruleFor(css, ':focus-visible'), /outline:1px dashed var\(--line-strong\)/, 'a base ring for every focusable element');
  const check = ruleFor(css, '.check');
  assert.match(check, /appearance:none/, 'the checkbox is drawn, not the OS one');
  assert.match(ruleFor(css, '.check:checked:after'), /background:var\(--ink\)/, 'a checked box fills with ink');
  assert.match(ruleFor(css, '.check:disabled'), /border-style:dashed/);
  assert.match(ruleFor(css, 'input[type=checkbox]:focus-visible'), /outline:1px dashed var\(--line-strong\)/, 'a drawn checkbox keeps the ring');
  assert.match(ruleFor(css, '.seg label:has(input:focus-visible)'), /outline:1px dashed var\(--line-strong\)/, 'a radio seg rings the focused label');
  for (const sel of ['.btn:focus-visible', '.nav a:focus-visible', '.clickable:focus-visible']) assert.match(ruleFor(css, sel), /outline:1px dashed var\(--line-strong\)/, sel);
  assert.doesNotMatch(css, /:focus(-visible)?\{[^}]*box-shadow/, 'no glow on focus');
  const drafting = draftingCss();
  for (const line of [
    ':focus-visible { outline: 1px dashed var(--line-strong); outline-offset: 2px; }',
    'appearance: none; margin: 0; background: transparent; cursor: pointer; vertical-align: middle; }',
    '.check:disabled { opacity: .4; border-style: dashed; cursor: not-allowed; }',
    '.check.on::after, .check:checked::after {',
    '.seg label:has(input:focus-visible) { outline: 1px dashed var(--line-strong); outline-offset: 3px; z-index: 1; }',
  ])
    assert.ok(drafting.includes(line), `design/drafting.css mirrors ${line}`);
});

test('phone targets are 44px', () => {
  // `width < 48rem` is built as `not all and (min-width:48rem)`; accept either.
  const body = mediaBody(builtCss(), /(\(\s*width\s*<\s*48rem\s*\)|not all and \(min-width:48rem\))/);
  const TARGETS = ['button:not(.chip)', 'a.btn', '.nav a', '[role=tab]', '[role=option]', 'summary', 'select', 'input:not([type=checkbox],[type=radio])', 'label:has(>input[type=checkbox])', 'label:has(>input[type=radio])'];
  // Split on top-level commas only: `input:not([type=checkbox],[type=radio])` holds one.
  const tall = [...body.matchAll(/([^{}]*)\{([^{}]*)\}/g)].filter((m) => /min-height:44px/.test(m[2])).flatMap((m) => splitTop(m[1], /,/));
  for (const sel of TARGETS) assert.ok(tall.includes(sel), `${sel} is 44px tall on phones (${tall.join(" | ")})`);
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

test('the REV chip is the same rectangle as every chip', () => {
  const css = builtCss();
  const drafting = fs.readFileSync(path.join(ROOT, 'design', 'drafting.css'), 'utf8');
  const built = ruleFor(css, '.chip.rev');
  const drawn = /^\.chip\.rev \{([^}]*)\}/m.exec(drafting)?.[1] ?? '';
  for (const [where, rule] of [['the built CSS', built], ['design/drafting.css', drawn]]) {
    assert.match(rule, /color:\s*var\(--redline\)/, `${where}: .chip.rev is redline`);
    assert.doesNotMatch(rule, /border-radius/, `${where}: .chip.rev has square corners`);
    assert.doesNotMatch(rule, /(^|[;\s])padding/, `${where}: .chip.rev keeps the chip padding`);
  }
  for (const [where, text] of [
    ['design/tokens.css', fs.readFileSync(path.join(ROOT, 'design', 'tokens.css'), 'utf8')],
    ['design/tokens.json', fs.readFileSync(path.join(ROOT, 'design', 'tokens.json'), 'utf8')],
    ['dashboard/style.css', fs.readFileSync(path.join(DASHBOARD, 'style.css'), 'utf8')],
    ['the built CSS', css],
  ])
    assert.ok(!text.includes('radius-tag'), `${where} has no radius-tag`);
  assert.ok(!ROUND_OK.test('10px') && !ROUND_OK.test('var(--radius-tag)'), 'no rounded-tag exception is left');
});
