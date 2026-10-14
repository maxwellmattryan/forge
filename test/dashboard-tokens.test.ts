// The Drafting tokens: design/tokens.css is the drawing, the built dashboard CSS must carry every
// variable of it in the same scope with the same value, and the text colours must stay readable.
// Reads files only; a small regex-based declaration reader stands in for a CSS parser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TONE_CLASS } from '../dashboard/src/lib/util.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dashboard', 'dist');

function builtCss(): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  const files = new Set<string>();
  for (const e of Object.values<any>(manifest)) for (const f of [e.file, ...(e.css ?? [])]) if (String(f).endsWith('.css')) files.add(f);
  return [...files].map((f) => fs.readFileSync(path.join(DIST, f), 'utf8')).join('\n');
}

const normSelector = (s: string) => s.replace(/["'\s]/g, '');

/** Top-level (unlayered, outside any at-rule) rule blocks, with their custom properties. */
function topLevelVars(css: string): { selector: string; vars: Map<string, string> }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: { selector: string; vars: Map<string, string> }[] = [];
  let depth = 0;
  let start = 0;
  let head = '';
  let bodyStart = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {
      if (depth === 0) {
        head = text.slice(start, i).trim();
        bodyStart = i + 1;
      }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        if (!head.startsWith('@')) {
          const vars = new Map<string, string>();
          for (const m of text.slice(bodyStart, i).matchAll(/(--(?:[\w-]|\\.)+)\s*:([^;]*)/g)) vars.set(m[1], m[2].trim());
          out.push({ selector: normSelector(head), vars });
        }
        start = i + 1;
      }
    } else if (c === ';' && depth === 0) start = i + 1;
  }
  return out;
}

function scope(css: string, selector: string): Map<string, string> {
  const merged = new Map<string, string>();
  for (const b of topLevelVars(css)) if (b.selector === normSelector(selector)) for (const [k, v] of b.vars) merged.set(k, v);
  return merged;
}

type Rgba = [number, number, number, number];

function parseColor(s: string): Rgba | null {
  const t = s.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(t);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(([^)]*)\)$/.exec(t);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  if (t === 'white') return [255, 255, 255, 1];
  if (t === 'black') return [0, 0, 0, 1];
  return null;
}

const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;

/** A value as a shape string with its colours pulled out, so colours compare with a tolerance. */
function normValue(v: string): { shape: string; colors: Rgba[] } {
  const colors: Rgba[] = [];
  const shape = v
    .replace(COLOR, (c) => {
      colors.push(parseColor(c) ?? [NaN, NaN, NaN, NaN]);
      return 'C';
    })
    .replace(/["']/g, '')
    .replace(/\s*([,()])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/(^|[^\w.])0+(\.\d)/g, '$1$2')
    .replace(/(^|[^\w.])0(px|rem|em)\b/g, '$10')
    .trim()
    .toLowerCase();
  return { shape, colors };
}

function sameValue(a: string, b: string): boolean {
  const x = normValue(a);
  const y = normValue(b);
  if (x.shape !== y.shape || x.colors.length !== y.colors.length) return false;
  return x.colors.every((c, i) => {
    const d = y.colors[i];
    return c[0] === d[0] && c[1] === d[1] && c[2] === d[2] && Math.abs(c[3] - d[3]) <= 1 / 255 + 1e-9;
  });
}

const SCOPES = [':root, [data-theme="cyanotype"]', '[data-theme="vellum"]', ':root'];
const EXTRAS: Record<string, string[]> = {
  [SCOPES[0]]: ['--paper-blend', '--fall'],
  [SCOPES[1]]: ['--paper-opacity', '--paper-blend', '--fall'],
  [SCOPES[2]]: [],
};

test('the token value reader normalises the way the build rewrites values', () => {
  assert.ok(sameValue('rgba(255,255,255,0.035)', '#ffffff09'));
  assert.ok(sameValue('#ffffff', '#fff'));
  assert.ok(sameValue('0.18', '.18'));
  assert.ok(sameValue('0px', '0'));
  assert.ok(sameValue('"IBM Plex Sans", system-ui', 'IBM Plex Sans,system-ui'));
  assert.ok(sameValue('3px 3px 0 0 rgba(226,238,255,0.28)', '3px 3px 0 0 #e2eeff47'));
  assert.ok(!sameValue('rgba(255,255,255,0.035)', '#ffffff0c'), 'alpha off by more than 1/255');
  assert.ok(!sameValue('#15427a', '#15427b'));
  assert.ok(!sameValue('8px', '9px'));
  const vars = scope(':root{--space-0\\.5:2px;--a:1}[data-theme=x]{--b:2}@layer t{:root{--c:3}}', ':root');
  assert.deepEqual([...vars.keys()], ['--space-0\\.5', '--a']);
});

test('built CSS carries every design token in both themes', () => {
  const design = fs.readFileSync(path.join(ROOT, 'design', 'tokens.css'), 'utf8');
  const css = builtCss();
  let count = 0;
  for (const sel of SCOPES) {
    const want = scope(design, sel);
    const got = scope(css, sel);
    assert.ok(want.size > 0, `design/tokens.css has a ${sel} block`);
    for (const [name, value] of want) {
      count++;
      assert.ok(got.has(name), `${sel} › ${name} is missing from the built CSS`);
      assert.ok(sameValue(value, got.get(name) ?? ''), `${sel} › ${name}: design ${value}, built ${got.get(name)}`);
    }
    const extra = [...got.keys()].filter((k) => !want.has(k)).sort();
    assert.deepEqual(extra, [...EXTRAS[sel]].sort(), `${sel}: only the drafting extras are added`);
  }
  assert.ok(count >= 80, `checked ${count} tokens`);
  for (const m of css.matchAll(/(--(?:[\w-]|\\.)+)\s*:([^;}]*)/g)) {
    const name = m[1].replace(/[\\.]/g, (c) => '\\' + c);
    assert.doesNotMatch(m[2], new RegExp(`var\\(\\s*${name}\\s*[,)]`), `${m[1]} references itself`);
  }
});

// WCAG 2.x relative luminance and contrast ratio.
const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgba) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a: Rgba, b: Rgba) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const over = ([r, g, b, a]: Rgba, [R, G, B]: Rgba): Rgba => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];

// --dim is for placeholders and title-block keys only and fails 4.5:1 by design (design/README.md
// › Colour). On vellum --highlight is only ever a fill under dark text, never text itself.
const TEXT = ['fg', 'muted', 'ink', 'redline', 'ok', 'warn', 'bad', 'info'];
const TEXT_BY_THEME: Record<string, string[]> = { cyanotype: [...TEXT, 'highlight'], vellum: TEXT };
// Empty: job 4 lifted --redline/--bad (both themes) and vellum --warn until every text token
// cleared 4.5:1 on the translucent surfaces too. A new failure is a token to fix, not an entry here.
const EXCEPTIONS: string[] = [];

test('text tokens meet 4.5:1 except the documented exceptions', () => {
  const design = fs.readFileSync(path.join(ROOT, 'design', 'tokens.css'), 'utf8');
  const themes: Record<string, Map<string, string>> = { cyanotype: scope(design, SCOPES[0]), vellum: scope(design, SCOPES[1]) };
  const failing: string[] = [];
  for (const [theme, vars] of Object.entries(themes)) {
    const color = (k: string): Rgba => {
      const c = parseColor(vars.get(`--${k}`) ?? '');
      assert.ok(c, `${theme} --${k} is a colour`);
      return c;
    };
    const bg = color('bg');
    const surfaces: Record<string, Rgba> = { bg, panel: over(color('panel'), bg), raised: over(color('raised'), bg) };
    for (const k of TEXT_BY_THEME[theme]) {
      const ratio = contrast(color(k), surfaces.bg);
      assert.ok(ratio >= 4.5, `${theme} --${k} on --bg is ${ratio.toFixed(2)}:1`);
      for (const s of ['panel', 'raised']) if (contrast(color(k), surfaces[s]) < 4.5) failing.push(`${theme} ${k}/${s}`);
    }
    const onInk = contrast(color('on-ink'), color('ink'));
    assert.ok(onInk >= 4.5, `${theme} --on-ink on --ink is ${onInk.toFixed(2)}:1`);
    const onHighlight = contrast(parseColor('#14355f') as Rgba, color('highlight'));
    assert.ok(onHighlight >= 4.5, `${theme} #14355f on --highlight is ${onHighlight.toFixed(2)}:1`);
  }
  assert.deepEqual(failing.sort(), [...EXCEPTIONS].sort(), 'the exception list equals the measured failures');
});

/** The two theme scopes of design/tokens.css, as a colour reader per theme. */
function themeColors(): Record<string, (k: string) => Rgba> {
  const design = fs.readFileSync(path.join(ROOT, 'design', 'tokens.css'), 'utf8');
  const out: Record<string, (k: string) => Rgba> = {};
  for (const [theme, sel] of [['cyanotype', SCOPES[0]], ['vellum', SCOPES[1]]]) {
    const vars = scope(design, sel);
    out[theme] = (k: string): Rgba => {
      const c = parseColor(vars.get(`--${k}`) ?? '');
      assert.ok(c, `${theme} --${k} is a colour`);
      return c;
    };
  }
  return out;
}

// Each level steps away from the ground toward the theme's highest-contrast colour: ground (bg + grid
// + paper), sheets and overlays (panel), the sidebar (chrome). The sketch and the active wash are
// translucent and land on those opaque fills, so text is measured on each combination.
test('sheets, chrome and sketch keep text at 4.5:1', (t) => {
  const lowest: Record<string, [number, string]> = {};
  for (const [theme, color] of Object.entries(themeColors())) {
    for (const k of ['panel', 'chrome']) assert.equal(color(k)[3], 1, `${theme} --${k} is opaque`);
    const bg = color('bg');
    const panel = color('panel');
    const chrome = color('chrome');
    const surfaces: Record<string, Rgba> = {
      panel,
      'panel+raised': over(color('raised'), panel),
      'panel+sketch': over(color('sketch-line'), panel),
      chrome,
      'chrome+raised': over(color('raised'), chrome),
      'chrome+sketch': over(color('sketch-line'), chrome),
    };
    for (const [s, surface] of Object.entries(surfaces)) {
      for (const k of TEXT_BY_THEME[theme]) {
        const ratio = contrast(color(k), surface);
        assert.ok(ratio >= 4.5, `${theme} --${k} on ${s} is ${ratio.toFixed(2)}:1`);
        const key = `${theme} ${s}`;
        if (!lowest[key] || ratio < lowest[key][0]) lowest[key] = [ratio, k];
      }
    }
    // A hovered control on the ground (board columns, page headers) draws the sketch over bg.
    const onGround = contrast(color('fg'), over(color('sketch-line'), bg));
    assert.ok(onGround >= 4.5, `${theme} --fg on bg + sketch is ${onGround.toFixed(2)}:1`);
    const fg = color('fg');
    const ladder = [bg, panel, chrome].map((s) => contrast(fg, s));
    assert.ok(ladder[0] < ladder[1] && ladder[1] < ladder[2], `${theme} fg steps up from the ground: ${ladder.map((r) => r.toFixed(2)).join(' → ')}`);
    const step = contrast(panel, bg);
    assert.ok(step >= 1.1, `${theme} a sheet stands off the ground (${step.toFixed(3)}:1)`);
  }
  for (const [key, [ratio, k]] of Object.entries(lowest)) t.diagnostic(`lowest ${key}: --${k} ${ratio.toFixed(2)}:1`);
});

/** The bodies of every rule whose selector list names exactly `selector` (the build merges equal rules). */
function ruleFor(css: string, selector: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) if (m[1].split(',').some((x) => x.trim() === selector)) out.push(m[2]);
  return out.join(';');
}

/** Channel-wise sRGB interpolation, what `color-mix(in srgb, a p, b)` computes for opaque colours. */
const mix = (a: Rgba, p: number, b: Rgba): Rgba => [a[0] * p + b[0] * (1 - p), a[1] * p + b[1] * (1 - p), a[2] * p + b[2] * (1 - p), 1];

// The token each chip tone writes its text in (.chip.<tone> in dashboard/style.css).
const CHIP_TOKEN: Record<string, string> = { ok: 'ok', bad: 'bad', warn: 'warn', info: 'info', ink: 'ink', muted: 'muted', live: 'ink', rev: 'redline' };
// The live chip's fill as the build writes it. The surface leads: Tailwind's color-mix fallback keeps the first
// colour, so a browser without color-mix gets a plain chip rather than ink text on an ink fill.
const LIVE_FILL = 'background-color:color-mix(in srgb,var(--surface,var(--bg)),var(--ink)12%)';

test('chip tones meet 4.5:1 on bg, panel and chrome', () => {
  assert.deepEqual(mix([255, 0, 100, 1], 0.5, [0, 255, 0, 1]), [127.5, 127.5, 50, 1], 'self-check: mix');
  const css = builtCss();
  for (const tone of Object.keys(TONE_CLASS)) {
    const token = CHIP_TOKEN[tone];
    assert.ok(token, `TONE_CLASS.${tone} has a token mapping in this test`);
    assert.match(ruleFor(css, `.chip.${TONE_CLASS[tone]}`), new RegExp(`color:var\\(--${token}\\)`), `.chip.${TONE_CLASS[tone]} colours its text with --${token}`);
    for (const [theme, color] of Object.entries(themeColors())) {
      // A chip fills with the surface it sits on; the live chip with 12% ink over that surface.
      const fill = (s: Rgba) => (tone === 'live' ? mix(color('ink'), 0.12, s) : s);
      const surfaces: Record<string, Rgba> = { bg: fill(color('bg')), panel: fill(color('panel')), chrome: fill(color('chrome')) };
      // Button chips (DaemonBar) sketch over their fill inside a sheet.
      surfaces['panel+sketch'] = over(color('sketch-line'), fill(color('panel')));
      for (const [k, surface] of Object.entries(surfaces)) {
        const ratio = contrast(color(token), surface);
        assert.ok(ratio >= 4.5, `${theme} chip ${tone} (--${token}) on ${k} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
  const live = ruleFor(css, '.chip.live');
  assert.ok(live.includes(LIVE_FILL), `.chip.live is an opaque ink tint of its surface (${live})`);
  assert.doesNotMatch(live, /background-image|gradient/, 'the live chip has no hatch');
  assert.match(ruleFor(css, '.chip'), /background-color:var\(--surface,var\(--bg\)\)/, 'a chip fills with its surface');
});

// ---------- fills: what each background resolves to, measured on the built CSS ----------

/** The value of every custom property the built CSS declares, for vars that aren't design tokens (Tailwind's own). */
function builtVars(css: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of css.matchAll(/(?<=[{;])\s*(--[\w-]+)\s*:([^;{}]*)/g)) out.set(m[1], [...(out.get(m[1]) ?? []), m[2].trim()]);
  return out;
}

/** Splits on commas outside parentheses. */
function args(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of value) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const VAR = /^var\((--[\w-]+)\s*(?:,(.*))?\)$/;

/** Every value a var() can take: its token value in each theme, else what the built CSS declares, else its fallback. */
function varValues(name: string, fallback: string | undefined, themes: Map<string, string>[], built: Map<string, string[]>): string[] {
  const fromTokens = themes.map((t) => t.get(name)).filter((v): v is string => v !== undefined);
  if (fromTokens.length) return fromTokens;
  if (name !== '--surface' && built.has(name)) return built.get(name) ?? [];
  assert.ok(fallback, `${name} resolves to nothing`);
  return [fallback];
}

/** Whether a background colour is opaque in both themes: an opaque token, the surface, or a mix of opaque colours. */
function opaque(value: string, themes: Map<string, string>[], built: Map<string, string[]>): boolean {
  const v = value.trim();
  if (v === 'var(--surface,var(--bg))') return true;
  const mixed = /^color-mix\((.*)\)$/.exec(v);
  if (mixed) {
    const [space, ...colors] = args(mixed[1]);
    return space === 'in srgb' && colors.length === 2 && colors.every((c) => opaque(c.replace(/\s*\d+(\.\d+)?%$/, '').replace(/\)\d+(\.\d+)?%$/, ')'), themes, built));
  }
  const ref = VAR.exec(v);
  if (ref) return varValues(ref[1], ref[2], themes, built).every((x) => opaque(x, themes, built));
  const c = parseColor(v);
  return c !== null && c[3] === 1;
}

// The unlayered rule that draws every native field (its selector list holds a comma inside :not()).
const NATIVE = 'input:not([type=checkbox],[type=radio]),textarea,select';
const FILLED = [
  '.chip', '.chip.live', '.chip.hl', '.btn', '.btn.sel', '.btn.primary', '.btn.primary[disabled]', '.btn:active', '.nav a', '.nav button', '.tab', '.tab.active',
  '.input', '.check', '.radio', '.track', '.fill', '.fill.ok', '.fill.warn', '.fill.bad', NATIVE, 'select option', '.sheet', '.sheet.clickable:hover',
  '.solid', '.plain', '.chrome',
];
const SKETCH_VALUE = 'repeating-linear-gradient(45deg,color-mix(in srgb,transparent,var(--sketch-line)var(--sketch))0 1px,transparent 1px var(--hatch-pitch))';
// Tailwind's fallback for browsers without color-mix: no sketch at all.
const SKETCH_FALLBACK = 'repeating-linear-gradient(45deg,transparent 0 1px,transparent 1px var(--hatch-pitch))';
const SELECT_ARROW = 'linear-gradient(45deg,transparent 50%,var(--fg)50%),linear-gradient(135deg,var(--fg)50%,transparent 50%)';

/** The bodies of every rule whose selector list names `selector` or is exactly it. */
function rulesOf(css: string, selector: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) if (m[1].trim() === selector || m[1].split(',').some((x) => x.trim() === selector)) out.push(m[2]);
  return out.join(';');
}

/** background, background-color and background-image declarations of every rule (at any depth) of a selector. */
const backgrounds = (css: string, selector: string) =>
  [...rulesOf(css, selector).matchAll(/(?:^|;)\s*(background(?:-color|-image)?)\s*:([^;]*)/g)].map((m) => [m[1], m[2].trim()] as const);

test('filled elements are opaque', () => {
  const css = builtCss();
  const design = fs.readFileSync(path.join(ROOT, 'design', 'tokens.css'), 'utf8');
  const themes = [scope(design, SCOPES[0]), scope(design, SCOPES[1]), scope(design, SCOPES[2])];
  const built = builtVars(css);
  assert.ok(opaque('color-mix(in srgb,var(--surface,var(--bg)),var(--ink)12%)', themes, built), 'self-check: the live mix');
  assert.ok(!opaque('#0000', themes, built) && !opaque('transparent', themes, built) && !opaque('var(--raised)', themes, built), 'self-check: see-through values');
  assert.ok(!opaque('color-mix(in srgb,var(--ink) 12%,transparent)', themes, built), 'self-check: a mix with transparent');
  for (const sel of FILLED) {
    const decls = backgrounds(css, sel);
    assert.ok(decls.length > 0, `${sel} has a background`);
    for (const [prop, value] of decls) {
      if (prop === 'background-image') {
        assert.ok(['none', SKETCH_VALUE, SKETCH_FALLBACK, SELECT_ARROW].includes(value), `${sel} draws ${value}: only the sketch and the select arrow`);
        continue;
      }
      assert.ok(opaque(value, themes, built), `${sel} › ${prop}:${value} is see-through`);
    }
  }
  const surfaces = [...css.matchAll(/(?<=[{;])\s*--surface\s*:([^;{}]*)/g)].map((m) => m[1].trim());
  assert.ok(surfaces.length >= 4, `checked ${surfaces.length} --surface declarations`);
  for (const s of surfaces) assert.ok(['var(--bg)', 'var(--panel)', 'var(--chrome)'].includes(s), `--surface:${s} is not an opaque surface`);
  assert.ok(!themes.some((t) => t.has('--surface')), '--surface is never a token');
});

// Every see-through fill in the built CSS, with why it is allowed. Nothing a person reads text on is here except
// the raised wash, which only ever lands on a plain opaque fill.
const ALPHA_ALLOWED: Record<string, string> = {
  '.ground › --grid-major': 'the 64px grid, drawn only on the ground',
  '.ground › --grid-minor': 'the 8px grid, drawn only on the ground',
  '.falloff:after › --fall': 'the exposure falloff on the ground behind main',
  '* › sketch gradient': 'the hover sketch, at var(--sketch) strength over the control’s own opaque fill',
  '.backdrop › literal': 'the modal scrim under the drawer and dialogs',
  '[data-theme=vellum] .backdrop › literal': 'the vellum modal scrim',
  '.scrim › literal': 'the palette’s lighter modal scrim',
  '[data-theme=vellum] .scrim › literal': 'the vellum palette scrim',
  '.dim-line:before,.dim-line:after › --line': 'a 1px dimension rule, not a fill',
  '.clickable:hover › --raised': 'a hovered table row over its sheet’s panel',
  '.nav a.active,.nav button.active › --raised': 'the active nav item over chrome or panel; it never sketches',
  '.prose code › --raised': 'inline code in markdown, which renders only in the drawer and dialogs (panel)',
  '.bg-raised › --raised': 'the command bar’s active option and the drawer’s selected file and file view, all on panel',
};

/** The alpha sources of one background value: translucent literals, mixes with transparent, translucent tokens. */
function alphaSources(value: string, themes: Map<string, string>[], built: Map<string, string[]>): string[] {
  const v = value.replace(/url\([^)]*\)/g, '');
  const out = new Set<string>();
  for (const m of v.matchAll(/#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?)\([^)]*\)/g)) {
    const lit = m[0].startsWith('hsl') ? /[\s,/]([\d.]+%?)\s*\)$/.exec(m[0]) : null;
    const alpha = lit ? parseFloat(lit[1]) / (lit[1].endsWith('%') ? 100 : 1) : (parseColor(m[0])?.[3] ?? 1);
    // Fully transparent draws nothing: that is no fill, not a see-through one ('filled elements are opaque' bans it on fills).
    if (alpha < 1 && alpha > 0) out.add('literal');
  }
  for (const m of v.matchAll(/color-mix\(([^()]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\)[^()]*)*)\)/g)) if (args(m[1]).some((a) => /^transparent\b/.test(a))) out.add('color-mix(…, transparent)');
  for (const m of v.matchAll(/var\((--[\w-]+)/g)) {
    if (m[1] === '--surface') continue;
    const values = varValues(m[1], 'transparent', themes, built);
    if (values.some((x) => {
      const c = parseColor(x);
      return c !== null && c[3] < 1 && c[3] > 0;
    }))
      out.add(m[1]);
  }
  return [...out];
}

test('no fill is see-through: alpha only on the ground, the sketch and the allowlist', () => {
  const css = builtCss();
  const design = fs.readFileSync(path.join(ROOT, 'design', 'tokens.css'), 'utf8');
  const themes = [scope(design, SCOPES[0]), scope(design, SCOPES[1]), scope(design, SCOPES[2])];
  const built = builtVars(css);
  assert.deepEqual(alphaSources('rgba(0,0,0,.5) #0000 var(--panel) var(--raised) rgb(0 0 0/.2)', themes, built).sort(), ['--raised', 'literal'], 'self-check: literal and token alpha');
  assert.deepEqual(alphaSources('color-mix(in srgb,var(--ink) 12%,transparent)', themes, built), ['color-mix(…, transparent)'], 'self-check: a mix with transparent');
  assert.deepEqual(alphaSources('hsla(0,0%,0%,.3)', themes, built), ['literal'], 'self-check: hsla');
  const measured = new Set<string>();
  let decls = 0;
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    for (const d of m[2].matchAll(/(?:^|;)\s*(background(?:-color|-image)?)\s*:([^;]*)/g)) {
      decls++;
      const value = d[2].trim();
      if (value === SKETCH_VALUE) {
        measured.add('* › sketch gradient');
        continue;
      }
      for (const source of alphaSources(value, themes, built)) measured.add(`${selector} › ${source}`);
    }
  }
  assert.ok(decls >= 60, `checked ${decls} background declarations`);
  assert.deepEqual([...measured].sort(), Object.keys(ALPHA_ALLOWED).sort(), 'the see-through fills equal the allowlist');
  // The active nav item's raised wash is the one control state allowed (over chrome or panel, and it never sketches).
  for (const key of Object.keys(ALPHA_ALLOWED).filter((k) => k !== '.nav a.active,.nav button.active › --raised'))
    assert.doesNotMatch(key.split(' › ')[0], /\.(chip|btn|nav|tab|fill|track|toast)\b/, `${key}: no control is allowed to be see-through`);
});

// The sidebar and the phone header are opaque --chrome (App.svelte), the furthest step from the ground; the
// active nav item lays --raised over it, and the Inbox tag fills with the chrome under it.
test('chrome sidebar keeps text at 4.5:1', () => {
  const design = fs.readFileSync(path.join(ROOT, 'design', 'tokens.css'), 'utf8');
  const themes: Record<string, Map<string, string>> = { cyanotype: scope(design, SCOPES[0]), vellum: scope(design, SCOPES[1]) };
  for (const [theme, color] of Object.entries(themeColors())) {
    const chrome = color('chrome');
    const active = over(color('raised'), chrome);
    const at = (k: string, surface: Rgba) => contrast(color(k), surface);
    // Labels, the repo line and nav counts are --muted; the active label and its count are --fg on --raised.
    for (const k of ['muted', 'fg']) {
      for (const [s, surface] of [['chrome', chrome], ['chrome+raised', active]] as const)
        assert.ok(at(k, surface) >= 4.5, `${theme} --${k} on ${s} is ${at(k, surface).toFixed(2)}:1`);
    }
    assert.ok(at('redline', chrome) >= 4.5, `${theme} the Inbox tag is ${at('redline', chrome).toFixed(2)}:1`);
  }

  const app = fs.readFileSync(path.join(ROOT, 'dashboard', 'src', 'App.svelte'), 'utf8');
  assert.ok(/<aside id="sidebar" class="[^"]*\bchrome z-10 border-line-strong shadow-\(--shadow-chrome\)[^"]*"/.test(app), 'the sidebar is chrome, above main, with a hard right shadow');
  assert.ok(/<header class="[^"]*\bchrome border-line-strong[^"]*"/.test(app), 'the phone header is chrome');
  assert.ok(!app.includes('bg-black/'), 'no translucent shade is left');
  const nav = fs.readFileSync(path.join(ROOT, 'dashboard', 'src', 'components', 'Nav.svelte'), 'utf8');
  assert.match(nav, /<span class="mono num \{on \? '' : 'muted'\}">/);
  assert.match(nav, /<span class="chip rev">/, 'the Inbox tag fills with the chrome under it, active or not');
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'dashboard', 'src', 'views', 'Pipeline.svelte'), 'utf8'), /opacity-70/, 'a selected filter count is full --on-ink');

  // --highlight is about 1.6:1 on vellum paper, so a hovered link turns --fg there.
  const css = builtCss();
  assert.match(ruleFor(css, '[data-theme=vellum] a:hover'), /color:var\(--fg\)/);
  const vellum = themes.vellum;
  const vbg = parseColor(vellum.get('--bg') ?? '') as Rgba;
  assert.ok(contrast(parseColor(vellum.get('--highlight') ?? '') as Rgba, vbg) < 4.5, 'the measurement that motivates the rule');
  assert.ok(contrast(parseColor(vellum.get('--fg') ?? '') as Rgba, vbg) >= 4.5);
});
