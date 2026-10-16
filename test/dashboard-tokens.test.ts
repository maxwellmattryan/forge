// The Smithy tokens: the token blocks of dashboard/style.css are the source, the built dashboard CSS must carry every
// variable of them in the same scope with the same value, and the text colours must stay readable in both themes (forge, ash).
// Reads files only; a small regex-based declaration reader stands in for a CSS parser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtCss } from './built-css.ts';
import { TONE_CLASS } from '../dashboard/src/lib/util.ts';
import { THEMES } from '../dashboard/src/lib/theme.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const SCOPES = [':root, [data-theme="forge"]', '[data-theme="ash"]', ':root'];
// style.css declares these after the tokens: the brushed gleam fills, the grain and the falloff (ash overrides four of
// them). They ride in the same scopes in the build.
const SMITHY_EXTRAS = ['--gleam-fill', '--gleam-fill-hot', '--gleam-fill-bar', '--gleam-spec', '--grain-opacity', '--grain-blend', '--fall', '--hammer', '--grain'];
const EXTRAS: Record<string, string[]> = {
  [SCOPES[0]]: [],
  [SCOPES[1]]: ['--gleam-spec', '--grain-opacity', '--grain-blend', '--fall'],
  [SCOPES[2]]: SMITHY_EXTRAS,
};
/** Each theme's own token block in style.css (the scalar `:root` block is shared). */
const THEME_SCOPE: Record<string, string> = { forge: SCOPES[0], ash: SCOPES[1] };
const STYLE = path.join(ROOT, 'dashboard', 'style.css');
/** A section of style.css, from its `/* ---------- <name>` marker to the next marker. */
function styleSection(name: string): string {
  const text = fs.readFileSync(STYLE, 'utf8');
  const start = text.indexOf(`/* ---------- ${name}`);
  assert.ok(start >= 0, `style.css has a ${name} section`);
  const end = text.indexOf('/* ----------', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}
const tokensCss = () => styleSection('tokens');
const extrasCss = () => styleSection('extras');

test('the token value reader normalises the way the build rewrites values', () => {
  assert.ok(sameValue('rgba(255,255,255,0.035)', '#ffffff09'));
  assert.ok(sameValue('#ffffff', '#fff'));
  assert.ok(sameValue('0.18', '.18'));
  assert.ok(sameValue('0px', '0'));
  assert.ok(sameValue('"Barlow", system-ui', 'Barlow,system-ui'));
  assert.ok(sameValue('inset 0 1px 0 0 rgba(220,232,250,0.08)', 'inset 0 1px 0 0 #dce8fa14'));
  assert.ok(!sameValue('rgba(255,255,255,0.035)', '#ffffff0c'), 'alpha off by more than 1/255');
  assert.ok(!sameValue('#15427a', '#15427b'));
  assert.ok(!sameValue('8px', '9px'));
  const vars = scope(':root{--space-0\\.5:2px;--a:1}[data-theme=x]{--b:2}@layer t{:root{--c:3}}', ':root');
  assert.deepEqual([...vars.keys()], ['--space-0\\.5', '--a']);
});

test('built CSS carries every design token in every theme', () => {
  const design = tokensCss();
  const css = builtCss();
  let count = 0;
  for (const sel of SCOPES) {
    const want = scope(design, sel);
    const got = scope(css, sel);
    assert.ok(want.size > 0, `style.css tokens have a ${sel} block`);
    for (const [name, value] of want) {
      count++;
      assert.ok(got.has(name), `${sel} › ${name} is missing from the built CSS`);
      assert.ok(sameValue(value, got.get(name) ?? ''), `${sel} › ${name}: source ${value}, built ${got.get(name)}`);
    }
    // lightningcss adds --lightningcss-light/-dark beside every color-scheme, for its light-dark() fallback.
    const extra = [...got.keys()].filter((k) => !want.has(k) && !k.startsWith('--lightningcss-')).sort();
    assert.deepEqual(extra, [...EXTRAS[sel]].sort(), `${sel}: only the extras are added`);
  }
  assert.ok(count >= 90, `checked ${count} tokens`);
  for (const m of css.matchAll(/(--(?:[\w-]|\\.)+)\s*:([^;}]*)/g)) {
    const name = m[1].replace(/[\\.]/g, (c) => '\\' + c);
    assert.doesNotMatch(m[2], new RegExp(`var\\(\\s*${name}\\s*[,)]`), `${m[1]} references itself`);
  }
});

// The Drafting palette and its theme ids are gone from every stylesheet the dashboard ships. (The JS bundle and
// index.html still name the old theme ids: lib/theme.ts maps saved values from earlier versions onto forge and ash.)
const DRAFTING = ['cyanotype', 'vellum', 'nightprint', '--ink', '--redline', '--highlight', '--sketch-line', '--grid-minor', '--grid-major', '--paper-opacity', '--hatch-pitch', '--tick', '--dash'];
test('no Drafting token or theme id remains', () => {
  const name = (n: string) => new RegExp(`${n.replace(/[-]/g, '\\-')}(?![\\w-])`);
  assert.ok(name('--ink').test('var(--ink)') && !name('--ink').test('--inky') && !name('--tick').test('--ticker'), 'self-check: whole names only');
  const dist = path.join(ROOT, 'dashboard', 'dist');
  const stylesheets = (fs.readdirSync(dist, { recursive: true }) as string[]).filter((f) => f.endsWith('.css')).map((f) => path.join(dist, f));
  assert.ok(stylesheets.length > 0, 'the build has a stylesheet');
  const sources: [string, string][] = [['dashboard/style.css', fs.readFileSync(path.join(ROOT, 'dashboard', 'style.css'), 'utf8')], ...stylesheets.map((f) => [path.relative(ROOT, f), fs.readFileSync(f, 'utf8')] as [string, string])];
  for (const [where, text] of sources) for (const n of DRAFTING) assert.doesNotMatch(text, name(n), `${where} names ${n}`);
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
/** Channel-wise sRGB interpolation, what `color-mix(in srgb, a p, b)` computes for opaque colours. */
const mix = (a: Rgba, p: number, b: Rgba): Rgba => [a[0] * p + b[0] * (1 - p), a[1] * p + b[1] * (1 - p), a[2] * p + b[2] * (1 - p), 1];

// Text is fg or muted; gleam (links, the live chip), ember (needs you) and the status hues carry words too. dim is for
// placeholders and stamp-line keys only and is the one documented exception. spark is only
// ever a fill under on-spark. Forge's hovered link is gleam-hot; Ash keeps gleam there.
const TEXT = ['fg', 'muted', 'gleam', 'ember', 'ok', 'warn', 'bad', 'info'];
const TEXT_BY_THEME: Record<string, string[]> = { forge: [...TEXT, 'gleam-hot'], ash: TEXT };
const DIM_FLOOR = 3.0;

/** The two theme scopes of the style.css tokens, as a colour reader per theme. */
function themeColors(): Record<string, (k: string) => Rgba> {
  const design = tokensCss();
  const out: Record<string, (k: string) => Rgba> = {};
  for (const theme of THEMES) {
    const vars = scope(design, THEME_SCOPE[theme]);
    out[theme] = (k: string): Rgba => {
      const c = parseColor(vars.get(`--${k}`) ?? '');
      assert.ok(c, `${theme} --${k} is a colour`);
      return c;
    };
  }
  return out;
}

test('text tokens meet 4.5:1 except the documented exceptions', () => {
  assert.deepEqual(Object.keys(themeColors()), ['forge', 'ash']);
  for (const [theme, color] of Object.entries(themeColors())) {
    for (const k of ['bg', 'panel', 'chrome']) assert.equal(color(k)[3], 1, `${theme} --${k} is opaque`);
    for (const k of TEXT_BY_THEME[theme]) {
      for (const s of ['bg', 'panel', 'chrome']) {
        const ratio = contrast(color(k), color(s));
        assert.ok(ratio >= 4.5, `${theme} --${k} on --${s} is ${ratio.toFixed(2)}:1`);
      }
    }
    // dim: placeholders and stamp keys only, below 4.5:1 by design, never under 3:1 on the ground.
    const dim = contrast(color('dim'), color('bg'));
    assert.ok(dim >= DIM_FLOOR && dim < 4.5, `${theme} --dim on --bg is ${dim.toFixed(2)}:1, the documented exception`);
    for (const [on, fill] of [['on-gleam', 'gleam'], ['on-spark', 'spark'], ['on-ember', 'ember']]) {
      const ratio = contrast(color(on), color(fill));
      assert.ok(ratio >= 4.5, `${theme} --${on} on --${fill} is ${ratio.toFixed(2)}:1`);
    }
  }
});

// Each surface steps away from the ground: plates and overlays (panel), the anvil (chrome). raised and the sheen are
// translucent and land on those opaque fills; a hovered control mixes 10–12% gleam into its own fill.
test('plates, chrome and sheen keep text at 4.5:1', (t) => {
  for (const [theme, color] of Object.entries(themeColors())) {
    const panel = color('panel');
    const chrome = color('chrome');
    const surfaces: Record<string, Rgba> = {
      panel,
      'panel+raised': over(color('raised'), panel),
      'panel+sheen': over(color('sheen'), panel),
      'panel+hover': mix(color('gleam'), 0.12, panel),
      chrome,
      'chrome+raised': over(color('raised'), chrome),
      'chrome+sheen': over(color('sheen'), chrome),
      'chrome+hover': mix(color('gleam'), 0.12, chrome),
    };
    const lowest: [number, string] = [Infinity, ''];
    for (const [s, surface] of Object.entries(surfaces)) {
      for (const k of TEXT_BY_THEME[theme].filter((x) => x !== 'gleam-hot')) {
        const ratio = contrast(color(k), surface);
        assert.ok(ratio >= 4.5, `${theme} --${k} on ${s} is ${ratio.toFixed(2)}:1`);
        if (ratio < lowest[0]) [lowest[0], lowest[1]] = [ratio, `--${k} on ${s}`];
      }
    }
    // The fg ladder and the weakest pair, for the record.
    const ladder = [color('bg'), panel, chrome].map((s) => contrast(color('fg'), s).toFixed(2));
    t.diagnostic(`${theme} fg on bg → panel → chrome: ${ladder.join(' → ')}; lowest ${lowest[1]} ${lowest[0].toFixed(2)}:1`);
  }
});

/** The bodies of every rule whose selector list names exactly `selector` (the build merges equal rules). */
function ruleFor(css: string, selector: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) if (m[1].split(',').some((x) => x.trim() === selector)) out.push(m[2]);
  return out.join(';');
}

// The token each chip tone writes its text in (.chip.<tone> in dashboard/style.css).
const CHIP_TOKEN: Record<string, string> = { ok: 'ok', bad: 'bad', warn: 'warn', info: 'info', gleam: 'gleam', muted: 'muted', live: 'gleam', you: 'ember' };
/** The tint a chip mixes into its surface, as the build writes it: `color-mix(in srgb,var(--surface,var(--bg)),<colour> N%)`. */
const TINT = /background-color:color-mix\(in srgb,var\(--surface,var\(--bg\)\),(currentColor|currentcolor|var\(--([\w-]+)\))\s*(\d+(?:\.\d+)?)%\)/;

test('chip tones meet 4.5:1 on bg, panel and chrome', () => {
  assert.deepEqual(mix([255, 0, 100, 1], 0.5, [0, 255, 0, 1]), [127.5, 127.5, 50, 1], 'self-check: mix');
  assert.deepEqual(TINT.exec('background-color:color-mix(in srgb,var(--surface,var(--bg)),var(--gleam) 14%)')?.slice(2, 4), ['gleam', '14'], 'self-check: the tint reader');
  const css = builtCss();
  const base = TINT.exec(ruleFor(css, '.chip'));
  assert.ok(base && /^current/i.test(base[1]), 'a chip tints its surface with its own colour');
  for (const tone of Object.keys(TONE_CLASS)) {
    const token = CHIP_TOKEN[tone];
    assert.ok(token, `TONE_CLASS.${tone} has a token mapping in this test`);
    const rule = ruleFor(css, `.chip.${TONE_CLASS[tone]}`);
    assert.match(rule, new RegExp(`color:var\\(--${token}\\)`), `.chip.${TONE_CLASS[tone]} colours its text with --${token}`);
    // muted is a dashed, untinted chip; the rest tint with their own colour (the base rule) or a named token.
    const own = TINT.exec(rule);
    const plain = tone === 'muted';
    if (plain) assert.match(rule, /background-color:var\(--surface,var\(--bg\)\)/, 'the muted chip fills with its surface alone');
    const pct = plain ? 0 : Number((own ?? base)[3]) / 100;
    if (own?.[2]) assert.equal(own[2], token, `.chip.${tone} tints with --${token}`);
    for (const [theme, color] of Object.entries(themeColors())) {
      for (const s of ['bg', 'panel', 'chrome']) {
        const fill = mix(color(token), pct, color(s));
        const ratio = contrast(color(token), fill);
        assert.ok(ratio >= 4.5, `${theme} chip ${tone} (--${token} at ${pct * 100}%) on ${s} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
  // The spark chip is the one solid chip: on-spark on spark.
  assert.match(ruleFor(css, '.chip.spark'), /color:var\(--on-spark\)/);
  assert.match(ruleFor(css, '.chip.spark'), /background:var\(--spark\)/);
  for (const [theme, color] of Object.entries(themeColors())) assert.ok(contrast(color('on-spark'), color('spark')) >= 4.5, `${theme} the spark chip`);
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

/** A colour stop of a gradient or a mix with its position or percentage dropped. */
const stopColor = (s: string) => s.replace(/(\s*-?\d+(\.\d+)?(%|px|deg)?)+$/, '').replace(/\)\d+(\.\d+)?%$/, ')').trim();

/** Whether a background is opaque in every theme: an opaque token, the surface, a mix or a gradient of opaque colours.
 *  currentColor counts: every chip tone that sets it is an opaque token. */
function opaque(value: string, themes: Map<string, string>[], built: Map<string, string[]>): boolean {
  const v = value.trim();
  if (v === 'var(--surface,var(--bg))' || /^currentcolor$/i.test(v)) return true;
  const mixed = /^color-mix\((.*)\)$/.exec(v);
  if (mixed) {
    const [space, ...colors] = args(mixed[1]);
    return space === 'in srgb' && colors.length === 2 && colors.every((c) => opaque(stopColor(c), themes, built));
  }
  const gradient = /^(?:linear|radial)-gradient\((.*)\)$/.exec(v);
  if (gradient) {
    const parts = args(gradient[1]);
    const stops = /^(-?\d|to |circle|ellipse|closest|farthest)/.test(parts[0]) ? parts.slice(1) : parts;
    return stops.length > 0 && stops.every((s) => opaque(stopColor(s), themes, built));
  }
  const ref = VAR.exec(v);
  if (ref) return varValues(ref[1], ref[2], themes, built).every((x) => opaque(x, themes, built));
  const c = parseColor(v);
  return c !== null && c[3] === 1;
}

// The unlayered rule that draws every native field (its selector list holds a comma inside :not()).
const NATIVE = 'input:not([type=checkbox],[type=radio]),textarea,select';
const FILLED = [
  '.chip', '.chip.live', '.chip.you', '.chip.spark', '.chip.muted', '.btn', '.btn.sel', '.btn.primary', '.btn.primary[disabled]', '.btn:active', '.btn.hover', '.navlist a', '.navlist button', '.tab', '.tab.active', '.tab.hover',
  '.input', '.check', '.check:checked', '.radio', '.track', '.fill', '.fill.ok', '.fill.warn', '.fill.bad', NATIVE, 'select option', '.plate', '.plate.hover',
  '.solid', '.plain', '.chrome',
];
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
  const themes = SCOPES.map((sel) => scope(tokensCss(), sel));
  const built = builtVars(css);
  assert.ok(opaque('color-mix(in srgb,var(--surface,var(--bg)),var(--gleam)14%)', themes, built), 'self-check: the live mix');
  assert.ok(opaque('linear-gradient(165deg,color-mix(in srgb,var(--gleam),white 9%)0%,var(--gleam)42%)', themes, built), 'self-check: a gradient of opaque stops');
  assert.ok(!opaque('#0000', themes, built) && !opaque('transparent', themes, built) && !opaque('var(--raised)', themes, built), 'self-check: see-through values');
  assert.ok(!opaque('color-mix(in srgb,var(--gleam) 12%,transparent)', themes, built), 'self-check: a mix with transparent');
  assert.ok(!opaque('linear-gradient(90deg,var(--gleam),var(--sheen))', themes, built), 'self-check: a gradient with a see-through stop');
  for (const sel of FILLED) {
    const decls = backgrounds(css, sel);
    assert.ok(decls.length > 0, `${sel} has a background`);
    for (const [prop, value] of decls) {
      if (prop === 'background-image') {
        assert.ok(['none', SELECT_ARROW].includes(value), `${sel} draws ${value}: only the select arrow`);
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
  '.falloff:after › --fall': 'the corner falloff on the ground behind main',
  '.backdrop › literal': 'the modal scrim under the drawer and dialogs',
  '[data-theme=ash] .backdrop › literal': 'the ash modal scrim',
  '.scrim › literal': 'the palette’s lighter modal scrim',
  '[data-theme=ash] .scrim › literal': 'the ash palette scrim',
  '.facts .sep › --line': 'a 1px tick between two facts, not a fill',
  '.clickable:hover › --raised': 'a hovered table row over its plate’s panel',
  '.navlist a.active,.navlist button.active › --raised': 'the active nav item over chrome or panel',
  '.prose code › --raised': 'inline code in markdown, which renders only in the drawer and dialogs (panel)',
  '.prose pre › --raised': 'a code block in markdown, on panel',
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

test('no fill is see-through: alpha only on the ground, the rivets and the allowlist', () => {
  const css = builtCss();
  const themes = SCOPES.map((sel) => scope(tokensCss(), sel));
  const built = builtVars(css);
  assert.deepEqual(alphaSources('rgba(0,0,0,.5) #0000 var(--panel) var(--raised) rgb(0 0 0/.2)', themes, built).sort(), ['--raised', 'literal'], 'self-check: literal and token alpha');
  assert.deepEqual(alphaSources('color-mix(in srgb,var(--gleam) 12%,transparent)', themes, built), ['color-mix(…, transparent)'], 'self-check: a mix with transparent');
  assert.deepEqual(alphaSources('hsla(0,0%,0%,.3)', themes, built), ['literal'], 'self-check: hsla');
  assert.deepEqual(alphaSources('transparent', themes, built), [], 'self-check: no fill');
  const measured = new Set<string>();
  let decls = 0;
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    // The grain layers are textures, not fills: they are checked in dashboard-css.test.ts.
    if (selector === '.ground:before' || selector === '.plate:after') continue;
    for (const d of m[2].matchAll(/(?:^|;)\s*(background(?:-color|-image)?)\s*:([^;]*)/g)) {
      decls++;
      for (const source of alphaSources(d[2].trim(), themes, built)) measured.add(`${selector} › ${source}`);
    }
  }
  assert.ok(decls >= 60, `checked ${decls} background declarations`);
  assert.deepEqual([...measured].sort(), Object.keys(ALPHA_ALLOWED).sort(), 'the see-through fills equal the allowlist');
  // The active nav item's raised wash is the one control state allowed (over chrome or panel).
  for (const key of Object.keys(ALPHA_ALLOWED).filter((k) => k !== '.navlist a.active,.navlist button.active › --raised'))
    assert.doesNotMatch(key.split(' › ')[0], /\.(chip|btn|navlist|tab|fill|track|toast)\b/, `${key}: no control is allowed to be see-through`);
});

// The sidebar and the phone header are opaque --chrome (App.svelte), the anvil; the active nav item lays --raised over
// it, and the Needs-you tag tints the chrome under it with ember.
test('chrome sidebar keeps text at 4.5:1', () => {
  assert.deepEqual(Object.keys(themeColors()), ['forge', 'ash'], 'the sidebar is measured in every theme');
  for (const [theme, color] of Object.entries(themeColors())) {
    const chrome = color('chrome');
    const active = over(color('raised'), chrome);
    const at = (k: string, surface: Rgba) => contrast(color(k), surface);
    // Labels, the repo line and nav counts are --muted; the active label and its count are --fg on --raised.
    for (const k of ['muted', 'fg']) {
      for (const [s, surface] of [['chrome', chrome], ['chrome+raised', active]] as const)
        assert.ok(at(k, surface) >= 4.5, `${theme} --${k} on ${s} is ${at(k, surface).toFixed(2)}:1`);
    }
    const tag = mix(color('ember'), 0.1, chrome);
    assert.ok(at('ember', tag) >= 4.5, `${theme} the Needs-you tag is ${at('ember', tag).toFixed(2)}:1`);
  }

  const app = fs.readFileSync(path.join(ROOT, 'dashboard', 'src', 'App.svelte'), 'utf8');
  assert.ok(/<aside id="sidebar" class="[^"]*\bchrome z-10 border-line-strong shadow-\(--shadow-chrome\)[^"]*"/.test(app), 'the sidebar is chrome, above main, with the chrome shadow');
  assert.ok(/<header class="[^"]*\bchrome border-line-strong[^"]*"/.test(app), 'the phone header is chrome');
  assert.ok(!app.includes('bg-black/'), 'no translucent shade is left');
  const nav = fs.readFileSync(path.join(ROOT, 'dashboard', 'src', 'components', 'Nav.svelte'), 'utf8');
  assert.match(nav, /<span class="mono num \{on \? '' : 'muted'\}">/);
  assert.match(nav, /<span class="chip you">/, 'the Needs-you tag tints the chrome under it, active or not');
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'dashboard', 'src', 'views', 'Pipeline.svelte'), 'utf8'), /opacity-70/, 'a selected filter count is full --on-gleam');

  // gleam-hot is lighter than gleam, under 4.5:1 on ash's pale ground, so a hovered link keeps gleam there.
  const css = builtCss();
  assert.match(ruleFor(css, '[data-theme=ash] a:hover'), /color:var\(--gleam\)/);
  const ash = themeColors().ash;
  assert.ok(contrast(ash('gleam-hot'), ash('bg')) < 4.5, 'the measurement that motivates the rule');
  assert.ok(contrast(ash('gleam'), ash('bg')) >= 4.5);
});

// ---------- the two themes: cascade, color-scheme, and the overrides ash takes ----------

/**
 * The custom properties a theme resolves to through the cascade: the unlayered top-level blocks in
 * source order, each applying when its selector list names `:root` or `[data-theme=<id>]`, the last
 * declaration winning. Descendant rules (`[data-theme=x] .a`) never apply. color-scheme rides along.
 */
function effective(css: string, theme: string): Map<string, string> {
  const out = new Map<string, string>();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
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
        const parts = args(normSelector(head));
        if (!head.startsWith('@') && (parts.includes(':root') || parts.includes(`[data-theme=${theme}]`)))
          for (const m of text.slice(bodyStart, i).matchAll(/((?:--(?:[\w-]|\\.)+)|color-scheme)\s*:([^;]*)/g)) out.set(m[1], m[2].trim());
        start = i + 1;
      }
    } else if (c === ';' && depth === 0) start = i + 1;
  }
  return out;
}

/** An extra as written in style.css and as the build minifies it (`.10` becomes `.1`, rgba becomes hex). */
const sameExtra = (a: string, b: string) => sameValue(a, b) || (a.trim() !== '' && !Number.isNaN(Number(a)) && Number(a) === Number(b));
const GRAIN_BLEND: Record<string, string> = { forge: 'soft-light', ash: 'multiply' };

test("each theme's tokens and extras win the cascade", () => {
  const sample = ':root{--a:1;--p:.18}:root,[data-theme="x"]{--a:2}[data-theme=y]{--a:3;--p:.5}[data-theme=x] .b{--a:9}@layer l{:root{--a:8}}';
  assert.deepEqual(Object.fromEntries(effective(sample, 'x')), { '--a': '2', '--p': '.18' }, 'self-check: the shared :root block applies');
  assert.deepEqual(Object.fromEntries(effective(sample, 'y')), { '--a': '3', '--p': '.5' }, 'self-check: a later theme block wins, descendants and layers never apply');
  assert.deepEqual(Object.fromEntries(effective('[data-theme=y]{--p:.5}:root{--p:.18}', 'y')), { '--p': '.18' }, 'self-check: a later :root block wins');
  assert.ok(sameExtra('.10', '.1') && !sameExtra('.10', '.18') && !sameExtra('', '0'), 'self-check: numeric extras');

  const design = tokensCss();
  const extrasSrc = extrasCss();
  const css = builtCss();
  for (const theme of THEMES) {
    const got = effective(css, theme);
    const want = new Map([...scope(design, SCOPES[2]), ...scope(design, THEME_SCOPE[theme])]);
    // The extras as the source resolves them for this theme. The grain URIs are compared in dashboard-css.test.ts.
    const extras = effective(extrasSrc, theme);
    for (const k of [...SMITHY_EXTRAS.filter((x) => !['--hammer', '--grain', '--gleam-fill', '--gleam-fill-hot', '--gleam-fill-bar'].includes(x)), 'color-scheme']) {
      assert.ok(extras.has(k), `style.css extras give ${theme} a ${k}`);
      want.set(k, extras.get(k) ?? '');
    }
    for (const [name, value] of want) assert.ok(sameExtra(value, got.get(name) ?? ''), `${theme} › ${name}: source ${value}, effective ${got.get(name)}`);
    const opacity = Number(got.get('--grain-opacity'));
    assert.ok(opacity > 0 && opacity <= 0.1, `${theme} › the grain's opacity ${opacity} is faint`);
    assert.equal(got.get('--grain-blend'), GRAIN_BLEND[theme], `${theme} › the grain's blend`);
  }
});

/** Every rule at any depth whose selector names `[data-theme=<id>]`: [normalised selector, body]. */
function themeRules(css: string, id: string): [string, string][] {
  const out: [string, string][] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sel = normSelector(m[1].split(';').pop() ?? '');
    if (sel.includes(`[data-theme=${id}]`)) out.push([sel, m[2]]);
  }
  return out;
}

// Native UI (scrollbars, an open <select>, autofill) follows the theme: forge is dark, ash is light. Ash overrides only
// its token blocks, the hovered link, and the two scrims.
const ASH_RULES = ['[data-theme=ash]', '[data-theme=ash]', '[data-theme=ash]a:hover', '[data-theme=ash].backdrop', '[data-theme=ash].scrim'];

test('forge is dark and ash is light', () => {
  const sample = '@layer a,b;@layer b{[data-theme="x"] .m{c:1}}[data-theme=x]{color-scheme:dark;--a:1}.y{c:2}';
  assert.deepEqual(themeRules(sample, 'x'), [['[data-theme=x].m', 'c:1'], ['[data-theme=x]', 'color-scheme:dark;--a:1']], 'self-check: nested and top-level rules');
  const css = builtCss();
  assert.equal(effective(css, 'forge').get('color-scheme'), 'dark', 'forge (and :root) is dark');
  assert.equal(effective(css, 'ash').get('color-scheme'), 'light', 'ash is light');
  assert.deepEqual(themeRules(css, 'forge').map(([sel]) => sel), [':root,[data-theme=forge]'], 'only the token block names forge: it is the :root default');
  assert.deepEqual(themeRules(css, 'ash').map(([sel]) => sel).sort(), [...ASH_RULES].sort(), 'ash keeps exactly its overrides');
});

// Ash is cooled ash, warm rather than a white page: red over green over blue, with these four ground values.
const ASH_GROUND: Record<string, string> = { '--bg': '#ebe7e0', '--bg-deep': '#ddd7cd', '--panel': '#f6f3ee', '--chrome': '#fbf9f6' };
test('ash bg is warm', () => {
  const warm = ([r, g, b]: Rgba) => r >= g && g >= b && r - b >= 8;
  assert.ok(warm([235, 231, 224, 1]), 'self-check: the warm ground');
  assert.ok(!warm([241, 240, 238, 1]), 'self-check: a near-white ground is not warm');
  assert.ok(!warm([224, 231, 235, 1]), 'self-check: a cool ground is not warm');
  const vars = scope(tokensCss(), SCOPES[1]);
  for (const [k, v] of Object.entries(ASH_GROUND)) assert.equal(vars.get(k)?.toLowerCase(), v, `style.css ash ${k}`);
  for (const k of ['bg', 'bg-deep']) assert.ok(warm(themeColors().ash(k)), `ash --${k} is warm`);
});

// A plate reads as a separate piece of metal on the ground (at least 1.11:1), and the solid
// focus ring (line-strong) stays visible on every surface it can land on, in both themes.
test('a plate stands at least 1.11:1 off the ground', () => {
  for (const [theme, color] of Object.entries(themeColors())) {
    const step = contrast(color('panel'), color('bg'));
    assert.ok(step >= 1.11, `${theme} a plate stands ${step.toFixed(3)}:1 off the ground`);
    for (const s of ['bg', 'panel', 'chrome']) {
      const ratio = contrast(color('line-strong'), color(s));
      assert.ok(ratio >= 5, `${theme} the focus ring (--line-strong) on --${s} is ${ratio.toFixed(2)}:1`);
    }
  }
});
