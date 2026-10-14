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
  [SCOPES[0]]: ['--accent', '--on-accent', '--paper-blend', '--fall'],
  [SCOPES[1]]: ['--accent', '--on-accent', '--paper-opacity', '--paper-blend', '--fall'],
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
    assert.deepEqual(extra, [...EXTRAS[sel]].sort(), `${sel}: only the drafting extras and aliases are added`);
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

/** The bodies of every rule whose selector list names exactly `selector` (the build merges equal rules). */
function ruleFor(css: string, selector: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) if (m[1].split(',').some((x) => x.trim() === selector)) out.push(m[2]);
  return out.join(';');
}

// The token each chip tone writes its text in (.chip.<tone> in dashboard/style.css).
const CHIP_TOKEN: Record<string, string> = { ok: 'ok', bad: 'bad', warn: 'warn', info: 'info', ink: 'ink', muted: 'muted', live: 'ink', rev: 'redline' };

test('chip tones meet 4.5:1 on bg, panel and raised', () => {
  const design = fs.readFileSync(path.join(ROOT, 'design', 'tokens.css'), 'utf8');
  const css = builtCss();
  const themes: Record<string, Map<string, string>> = { cyanotype: scope(design, SCOPES[0]), vellum: scope(design, SCOPES[1]) };
  for (const tone of Object.keys(TONE_CLASS)) {
    const token = CHIP_TOKEN[tone];
    assert.ok(token, `TONE_CLASS.${tone} has a token mapping in this test`);
    assert.match(ruleFor(css, `.chip.${TONE_CLASS[tone]}`), new RegExp(`color:var\\(--${token}\\)`), `.chip.${TONE_CLASS[tone]} colours its text with --${token}`);
    for (const [theme, vars] of Object.entries(themes)) {
      const color = (k: string): Rgba => {
        const c = parseColor(vars.get(`--${k}`) ?? '');
        assert.ok(c, `${theme} --${k} is a colour`);
        return c;
      };
      const bg = color('bg');
      const surfaces: Record<string, Rgba> = { bg, panel: over(color('panel'), bg), raised: over(color('raised'), bg) };
      // The live chip's hatch (1px of --line-soft in every 5px) averages out to a fifth of its alpha.
      if (tone === 'live') {
        const [r, g, b, a] = color('line-soft');
        for (const k of Object.keys(surfaces)) surfaces[`${k}+hatch`] = over([r, g, b, a * 0.2], surfaces[k]);
      }
      for (const [k, surface] of Object.entries(surfaces)) {
        const ratio = contrast(color(token), surface);
        assert.ok(ratio >= 4.5, `${theme} chip ${tone} (--${token}) on ${k} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});
