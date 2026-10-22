// The dashboard invariants a public function can't hold, so these tests read source and build text (docs/TESTING.md
// "Allowed source-text tests"): raw HTML and URLs stay confined to the escape-first helpers, every message comes from
// en.json, the build loads nothing from another origin, theme colours keep text readable, and controls expose their
// state and names to assistive tech. Each check has a self-test that a planted break fails it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOSE, endOf, literals, markup, soleCall, tags } from './svelte-markup.ts';
import { builtCss } from './built-css.ts';
import { DIST, noDist } from './dist.ts';
import { isPlural } from '../dashboard/src/lib/i18n.ts';
import { TONE_CLASS } from '../dashboard/src/lib/util.ts';
import { THEMES } from '../dashboard/src/lib/theme.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD = path.join(ROOT, 'dashboard');
const SRC = path.join(DASHBOARD, 'src');
const BUILT = { skip: noDist() };
/** A file under dashboard/. */
const read = (rel: string) => fs.readFileSync(path.join(DASHBOARD, rel), 'utf8');
/** A file under dashboard/src/. */
const readSrc = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

// ---------- 1. raw HTML and URLs: only the escape-first builders and safeUrl ----------
// Svelte's {…} interpolation escapes by construction; these keep raw HTML confined to the escape-first builders
// (md, budget*, screenshotsPanel), whose own suites pin their escaping.

/** Every .ts and .svelte file under dashboard/src, as paths relative to dashboard/. */
const sources = () =>
  fs
    .readdirSync(SRC, { recursive: true })
    .map((f) => `src/${String(f).split(path.sep).join('/')}`)
    .filter((f) => /\.(ts|svelte)$/.test(f))
    .sort();
const componentFiles = () => sources().filter((f) => f.endsWith('.svelte'));
/** The escape-first HTML builders; their output is the only raw HTML the app renders. */
const BUILDERS = { md: 'markdown', budgetChip: 'budget', budgetCell: 'budget', budgetPanel: 'budget', screenshotsPanel: 'screenshots' };

function htmlProblems(file: string, text: string) {
  const problems: string[] = [];
  const calls: string[] = [];
  for (const m of text.matchAll(/\{@html\b/g)) {
    const end = endOf(text, m.index);
    const name = end < 0 ? null : soleCall(text.slice(m.index + '{@html'.length, end));
    if (!name || !Object.hasOwn(BUILDERS, name)) {
      problems.push(`${file}: {@html} must be exactly one escape-first builder call: ${text.slice(m.index, end < 0 ? m.index + 60 : end + 1)}`);
      continue;
    }
    const lib = BUILDERS[name as keyof typeof BUILDERS];
    const imp = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'(?:\\.\\.?\\/)+lib\\/${lib}\\.ts'`);
    if (!imp.test(text)) problems.push(`${file}: ${name} must be imported from lib/${lib}.ts`);
    calls.push(name);
  }
  return { problems, calls };
}

test('{@html} receives only escape-first builders', () => {
  let drawerMd = false;
  for (const f of sources()) {
    const { problems, calls } = htmlProblems(f, read(f));
    assert.deepEqual(problems, []);
    if (f === 'src/components/Drawer.svelte' && calls.includes('md')) drawerMd = true;
  }
  assert.ok(drawerMd, 'Drawer.svelte renders markdown through {@html md(…)}');
});

test('the {@html} guard rejects anything but one whole builder call', () => {
  const head = `<script lang="ts">\n  import { md } from '../lib/markdown.ts';\n</script>\n`;
  assert.deepEqual(htmlProblems('ok.svelte', `${head}{@html md(x)}{@html md(a.b, { c: '}' })}`).problems, []);
  for (const bad of ['{@html md(x) + raw}', '{@html md(x) || raw}', '{@html md(x)(raw)}', '{@html cond ? md(x) : raw}', '{@html raw}', '{@html md(x)']) {
    assert.equal(htmlProblems('bad.svelte', head + bad).problems.length, 1, bad);
  }
  assert.equal(htmlProblems('bad.svelte', '{@html md(x)}').problems.length, 1, 'md must come from lib/markdown.ts');
});

test('no raw HTML sinks in dashboard sources', () => {
  const sinks = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'srcdoc', 'createContextualFragment', 'DOMParser'];
  for (const f of sources()) {
    const text = read(f);
    for (const s of sinks) assert.ok(!text.includes(s), `${f} uses ${s}`);
  }
});

/** The right-hand side of the assignment starting at `i`: up to `;`, a newline, or the `}` closing an `{@const}`. */
function rhs(text: string, i: number) {
  let j = i;
  for (; j < text.length && !/[;\n}]/.test(text[j]); j++) {
    if (text[j] in CLOSE || text[j] === '"' || text[j] === "'" || text[j] === '`') {
      const end = endOf(text, j);
      if (end < 0) return '';
      j = end;
    }
  }
  return text.slice(i, j).trim();
}

/** True when `name` is declared, and every `const name =` / `{@const name =}` is exactly safeUrl(…) or $derived(safeUrl(…)). */
function fromSafeUrl(text: string, name: string) {
  const decls = [...text.matchAll(new RegExp(`(?:\\{@const|\\bconst)\\s+${name.replace(/\$/g, '\\$')}\\s*=\\s*`, 'g'))];
  return decls.length > 0 && decls.every((m) => {
    const e = rhs(text, m.index + m[0].length);
    if (soleCall(e) === 'safeUrl') return true;
    return soleCall(e) === '$derived' && soleCall(e.slice(e.indexOf('(') + 1, -1)) === 'safeUrl';
  });
}

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href']);
/**
 * Which allowance a dynamic URL attribute value meets, or why it meets none. Allowed: a quoted value whose literal
 * prefix is a hash route or a same-origin path with a fixed first segment (an interpolation can't change its scheme
 * or host), a `#/…` template, or exactly safeUrl(…) / a const assigned exactly from it.
 */
function urlVerdict(text: string, value: string): { via: 'prefix' | 'safeUrl' } | { why: string } {
  const bare = { why: 'interpolates without a fixed #/ or same-origin /path prefix' };
  let v = value;
  if (/^["']/.test(v)) {
    const inner = v.slice(1, -1);
    if (inner.startsWith('{') && endOf(inner, 0) === inner.length - 1) v = inner;
    else return /^(#\/|\/[\w-])/.test(inner.slice(0, inner.indexOf('{'))) ? { via: 'prefix' } : bare;
  }
  if (!v.startsWith('{') || endOf(v, 0) !== v.length - 1) return bare;
  const expr = v.slice(1, -1).trim();
  if (expr.startsWith('`#/') && endOf(expr, 0) === expr.length - 1) return { via: 'prefix' };
  if (soleCall(expr) === 'safeUrl') return { via: 'safeUrl' };
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) return fromSafeUrl(text, expr) ? { via: 'safeUrl' } : { why: `{${expr}} is not a const assigned exactly from safeUrl(…)` };
  return { why: 'is not exactly safeUrl(…), a const from it, or a #/ route' };
}

function urlProblems(file: string, text: string) {
  const problems: string[] = [];
  let checked = 0;
  let viaSafeUrl = false;
  for (const tag of tags(file, text)) {
    // Components (capitalised) may take spreads: whatever they forward lands on a native element checked here.
    const native = /^[a-z]/.test(tag.name);
    for (const a of tag.attrs) {
      if (a.spread !== undefined) {
        if (native) problems.push(`${file}: <${tag.name} {${a.spread}}> spreads attributes, which can carry an unchecked URL`);
        continue;
      }
      if (!a.name || !URL_ATTRS.has(a.name.toLowerCase()) || a.value === undefined || !a.value.includes('{')) continue;
      checked++;
      const r = urlVerdict(text, a.value);
      if ('why' in r) problems.push(`${file}: <${tag.name} ${a.name}=${a.value}> ${r.why}`);
      else if (r.via === 'safeUrl') viaSafeUrl = true;
    }
  }
  if (viaSafeUrl && !/import\s*\{[^}]*\bsafeUrl\b[^}]*\}\s*from\s*'(?:\.\.?\/)+lib\/markdown\.ts'/.test(text)) {
    problems.push(`${file}: safeUrl must be imported from lib/markdown.ts`);
  }
  return { problems, checked };
}

test('mockups render only in the sandboxed /raw iframe', () => {
  const hits = sources().flatMap((f) => [...read(f).matchAll(/<iframe\b[^>]*>/g)].map((m) => [f, m[0]]));
  assert.equal(hits.length, 1, `exactly one <iframe>: ${JSON.stringify(hits)}`);
  const [file, tag] = hits[0];
  assert.equal(file, 'src/components/Drawer.svelte');
  assert.match(tag, /\ssandbox="allow-scripts"/);
  assert.match(tag, /\ssrc="\/api\/jobs\/\{[^}]+\}\/raw\?path=\{[^}]+\}"/);
});

test('dynamic URLs go through safeUrl', () => {
  let checked = 0;
  for (const f of componentFiles()) {
    const r = urlProblems(f, read(f));
    assert.deepEqual(r.problems, []);
    checked += r.checked;
  }
  assert.ok(checked >= 8, `checked ${checked} dynamic URL attributes`);
});

test('the URL guard rejects shorthand, spreads and unchecked src/action/formaction/xlink:href', () => {
  const imp = `  import { safeUrl } from '../lib/markdown.ts';\n`;
  const head = `<script lang="ts">\n${imp}  const href = $derived(safeUrl(job.url));\n</script>\n`;
  const ok = [
    '<a {href}>x</a>',
    '<a href={safeUrl(u)} onclick={() => go({ to: "a>b" })}>x</a>',
    '{#each xs as x}{@const u = safeUrl(x.url)}<a href={u}>x</a>{/each}',
    '<a href="#/{v.id}">x</a>',
    '<a href={`#/${v.id}`}>x</a>',
    '<iframe sandbox="allow-scripts" src="/api/jobs/{id}/raw?path={p}"></iframe>',
    '<img src="/forge.png" alt="" />',
    '<Card {...props} />',
  ];
  for (const m of ok) assert.deepEqual(urlProblems('ok.svelte', head + m).problems, [], m);
  const bad = [
    // Shorthand whose name never passed through safeUrl, and spreads on URL-bearing elements.
    `<script lang="ts">\n  let { href } = $props();\n</script>\n<a {href}>x</a>`,
    ...['a', 'iframe', 'img', 'form', 'area', 'link'].map((t) => `${head}<${t} {...props}></${t}>`),
    // The other URL attributes.
    `${head}<img src={u} />`,
    `${head}<iframe sandbox="allow-scripts" src={u}></iframe>`,
    `${head}<button formaction={u}>x</button>`,
    `${head}<form action={u}></form>`,
    `${head}<svg><use xlink:href={u} /></svg>`,
    `${head}<img src="{u}" />`,
    `${head}<a href="//{host}/x">x</a>`,
    `${head}<a href="{base}/x">x</a>`,
    // safeUrl must be the whole value, and the real one.
    `${head}<a href={safeUrl(u) || raw}>x</a>`,
    `<script lang="ts">\n${imp}  const href = $derived(safeUrl(job.url) ?? raw);\n</script>\n<a {href}>x</a>`,
    `<script lang="ts">\n  const href = $derived(safeUrl(job.url));\n</script>\n<a {href}>x</a>`,
  ];
  for (const m of bad) assert.ok(urlProblems('bad.svelte', m).problems.length > 0, m);
});

// ---------- 2. i18n: every user-facing string comes from en.json through $t('literal.key') ----------

const EN = JSON.parse(readSrc('messages/en.json'));
/** Every .svelte file under dashboard/src, as [path relative to src, text]. */
const svelte = fs
  .readdirSync(SRC, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.svelte'))
  .sort()
  .map((f) => [f.split(path.sep).join('/'), readSrc(f)] as const);

/** Attributes whose value is shown to people (natively or by our components). */
const TEXT_ATTRS = new Set(['title', 'aria-label', 'placeholder', 'alt', 'label', 'text', 'msg']);
const LETTERS = /\p{L}{2,}/u;
/** A literal that reads as prose: Capitalised or several words. */
const PROSE = (s: string) => /\p{Lu}\p{Ll}/u.test(s) || /\p{L}+ +\p{L}+/u.test(s);
const COMPARED = (before: string, after: string) => /(===|!==|==|!=)\s*$/.test(before) || /^\s*(===|!==|==|!=)/.test(after);
const KEY_ARG = (before: string) => /\$t\(\s*$/.test(before);

function leaves(o: any, prefix = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string' || isPlural(v)) return [key];
    assert.ok(v && typeof v === 'object' && !Array.isArray(v), `${key} is a string, a plural object or a nested map`);
    assert.ok(!('other' in (v as object)), `${key} looks like a plural object but isn't one: ${JSON.stringify(v)}`);
    return leaves(v, key);
  });
}

const resolves = (key: string) => {
  const v = key.split('.').reduce((o: any, k) => (o && typeof o === 'object' && !isPlural(o) && Object.hasOwn(o, k) ? o[k] : undefined), EN);
  return typeof v === 'string' || isPlural(v);
};

test('en.json is a catalog of strings and plural objects, and every message is used', () => {
  const all = leaves(EN);
  assert.ok(all.length > 50, `${all.length} messages`);
  const used = new Set<string>();
  for (const [f, text] of svelte) {
    for (const m of text.matchAll(/\$t\(/g)) {
      const lit = /^\$t\(\s*(['"])([^'"\\]+)\1/.exec(text.slice(m.index));
      assert.ok(lit, `${f}: $t( needs a string-literal key: ${text.slice(m.index, m.index + 50)}`);
      assert.ok(resolves(lit[2]), `${f}: $t('${lit[2]}') is not in en.json`);
      used.add(lit[2]);
    }
  }
  assert.deepEqual(all.filter((k) => !used.has(k)), [], 'unused messages');
});

test('components carry no hard-coded user-facing text', () => {
  const problems: string[] = [];
  const proseIn = (f: string, where: string, expr: string) => {
    for (const l of literals(expr)) if (!KEY_ARG(l.before) && !COMPARED(l.before, l.after) && PROSE(l.value)) problems.push(`${f}: ${where} literal ${JSON.stringify(l.value)}`);
  };
  for (const [f, text] of svelte) {
    const { texts, exprs } = markup(f, text);
    for (const t of texts) if (LETTERS.test(t)) problems.push(`${f}: text ${JSON.stringify(t.trim())}`);
    for (const e of exprs) proseIn(f, 'markup', e);
    for (const tag of tags(f, text)) {
      for (const a of tag.attrs) {
        if (!a.name || !TEXT_ATTRS.has(a.name) || a.value === undefined) continue;
        const v = a.value.replace(/^["']|["']$/g, '');
        let fixed = '';
        for (let i = 0; i < v.length; i++) {
          if (v[i] !== '{') fixed += v[i];
          else {
            const end = v.indexOf('}', i) < 0 ? v.length : matching(v, i);
            proseIn(f, `<${tag.name} ${a.name}>`, v.slice(i + 1, end));
            i = end;
          }
        }
        if (LETTERS.test(fixed)) problems.push(`${f}: <${tag.name} ${a.name}="${a.value}">`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

/** The `}` that closes the `{` at `i`, counting nesting and skipping strings. */
function matching(v: string, i: number): number {
  let depth = 0;
  for (let j = i; j < v.length; j++) {
    const c = v[j];
    if (c === '"' || c === "'" || c === '`') {
      const end = v.indexOf(c, j + 1);
      j = end < 0 ? v.length : end;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j;
  }
  return v.length;
}

test('the text guard catches what it should', () => {
  const run = (src: string) => {
    const { texts, exprs } = markup('x.svelte', src);
    return [...texts.filter((t) => LETTERS.test(t)), ...exprs.flatMap((e) => literals(e).filter((l) => !KEY_ARG(l.before) && !COMPARED(l.before, l.after) && PROSE(l.value)).map((l) => l.value))];
  };
  assert.deepEqual(run('<div>{$t(\'a.bC\')} · {x === \'Some Thing\' ? 1 : 2}</div>'), []);
  assert.deepEqual(run('<div>Hello</div>'), ['Hello']);
  assert.deepEqual(run("<b>{ok ? 'Done' : 'not yet'}</b>"), ['Done', 'not yet']);
  assert.deepEqual(run('<p>{`Forge v${v}`}</p>'), ['Forge v']);
  assert.deepEqual(run('<script lang="ts">const a = "Hidden words";</script><!-- a comment --><i class="a b">{n}</i>'), []);
});

// ---------- 3. the build loads nothing from another origin ----------
// The fonts are vendored woff2 files the server serves from the manifest, and the film grain is inline SVG data: URIs.

function listFiles(dir: string, rel = ''): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? listFiles(dir, r) : [r];
  });
}

/** Every stylesheet in dist, joined as written (no spacing normalised: url()s are read whole). */
function distCss(): string {
  return listFiles(DIST)
    .filter((f) => f.endsWith('.css'))
    .map((f) => fs.readFileSync(path.join(DIST, f), 'utf8'))
    .join('\n');
}

/** Every url(...) in a stylesheet; a quoted data: URI is consumed whole, so url()s inside it don't count. */
const cssUrls = (css: string) => [...css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/g)].map((m) => (m[1] ?? m[2] ?? m[3]).trim());

test('dist loads nothing from another origin', BUILT, () => {
  for (const f of listFiles(DIST)) {
    const text = fs.readFileSync(path.join(DIST, f)).toString('latin1');
    for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com']) assert.ok(!text.includes(host), `${f} mentions ${host}`);
  }
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  for (const m of html.matchAll(/\s(?:src|href)\s*=\s*["']?([^"'\s>]*)/gi)) assert.doesNotMatch(m[1], /^(https?:)?\/\//i, `index.html loads ${m[1]}`);
  const css = distCss();
  assert.doesNotMatch(css, /@import\b/, 'the built CSS has no @import');
  const urls = cssUrls(css);
  assert.ok(urls.length >= 9, `found ${urls.length} url()s`);
  for (const u of urls) assert.ok(/^\/assets\/[\w.-]+$/.test(u) || u.startsWith('data:'), `url(${u.slice(0, 60)}) is same-origin`);
  assert.equal(urls.filter((u) => u.startsWith('data:image/svg+xml')).length, 2, 'two inline SVGs: the ground grain and the plate grain');
  assert.deepEqual(listFiles(DIST).filter((f) => f.toLowerCase().endsWith('.svg')), [], 'dist has no SVG file');
  assert.deepEqual(cssUrls('a{b:url("data:x,url(%23p)") url(/assets/a.woff2) url( \'/assets/b.css\' )}'), ['data:x,url(%23p)', '/assets/a.woff2', '/assets/b.css']);
});

// ---------- 4. theme tokens keep text at 4.5:1 ----------
// The token blocks of dashboard/style.css are the source; a small regex-based declaration reader stands in for a CSS parser.

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

/** Each theme's own token block in style.css (the scalar `:root` block is shared). */
const THEME_SCOPE: Record<string, string> = {
  forge: ':root, [data-theme="forge"]',
  ash: '[data-theme="ash"]',
  temper: '[data-theme="temper"]',
  crucible: '[data-theme="crucible"]',
  patina: '[data-theme="patina"]',
  obsidian: '[data-theme="obsidian"]',
};
/** The tokens section of style.css, from its `/* ---------- tokens` marker to the next marker. */
function tokensCss(): string {
  const text = read('style.css');
  const start = text.indexOf('/* ---------- tokens');
  assert.ok(start >= 0, 'style.css has a tokens section');
  const end = text.indexOf('/* ----------', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

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
const TEXT_BY_THEME: Record<string, string[]> = { forge: [...TEXT, 'gleam-hot'], ash: TEXT, temper: [...TEXT, 'gleam-hot'], crucible: [...TEXT, 'gleam-hot'], patina: [...TEXT, 'gleam-hot'], obsidian: [...TEXT, 'gleam-hot'] };
const DIM_FLOOR = 3.0;

/** The theme scopes of the style.css tokens, as a colour reader per theme. */
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

test('text tokens meet 4.5:1 except the documented exceptions', (t) => {
  assert.deepEqual(Object.keys(themeColors()), [...THEMES]);
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
    t.diagnostic(`${theme} dim on bg: ${dim.toFixed(2)}:1`);
    // on-gleam on gleam-hot: the primary button's hover fill.
    for (const [on, fill] of [['on-gleam', 'gleam'], ['on-gleam', 'gleam-hot'], ['on-spark', 'spark'], ['on-ember', 'ember']]) {
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

test('chip tones meet 4.5:1 on bg, panel and chrome', BUILT, () => {
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

// ---------- 5. accessible state and names ----------

test('segments and nav expose their selected state', () => {
  const pipeline = readSrc('views/Pipeline.svelte');
  const buttons = tags('views/Pipeline.svelte', pipeline).filter((t) => t.name === 'button' && t.attrs.some((a) => a.name === 'class' && /\bsel\b/.test(a.value ?? '')));
  assert.equal(buttons.length, 2, 'the filter and layout segments');
  for (const b of buttons) {
    const pressed = b.attrs.find((a) => a.name === 'aria-pressed');
    const sel = b.attrs.find((a) => a.name === 'class')?.value ?? '';
    assert.ok(pressed, 'a segment button carries aria-pressed');
    // aria-pressed and the `sel` class read the same condition.
    const cond = /\{(\w+) \? 'sel'/.exec(sel)?.[1];
    assert.ok(cond && pressed.value === `{${cond}}`, `aria-pressed follows the sel condition (${pressed.value} vs ${sel})`);
  }
  assert.match(pipeline, /\{@const on = S\.filter === f\}/);
  assert.match(pipeline, /\{@const on = S\.layout === l\}/);

  const nav = readSrc('components/Nav.svelte');
  const links = tags('components/Nav.svelte', nav).filter((t) => t.name === 'a');
  assert.equal(links.length, 1, 'one link per view, for the sidebar and the phone strip');
  const attr = (n: string) => links[0].attrs.find((a) => a.name === n)?.value;
  assert.equal(attr('aria-current'), `{on ? 'page' : undefined}`);
  assert.equal(attr('class'), `{on ? 'active' : ''}`);
  assert.match(nav, /\{@const on = S\.view === v\.id\}/);
});

/** Class tokens of a `class` value: its fixed words plus every string literal in its `{…}` parts. */
function classTokens(value: string | undefined): string[] {
  if (value === undefined) return [];
  const words: string[] = [];
  let rest = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '{') {
      rest += value[i];
      continue;
    }
    const end = endOf(value, i);
    if (end < 0) throw new Error(`cannot parse class value ${JSON.stringify(value)}`);
    for (const m of value.slice(i + 1, end).matchAll(/'([^']*)'|"([^"]*)"/g)) words.push(m[1] ?? m[2]);
    rest += ' ';
    i = end;
  }
  return [rest, ...words].flatMap((s) => s.split(/\s+/)).filter(Boolean);
}

/** Index just past the opening tag at `i`, skipping quoted values and `{…}`. */
function openEnd(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '>') return j + 1;
    if (s[j] === '{' || s[j] === '"' || s[j] === "'") {
      const end = endOf(s, j);
      if (end < 0) return -1;
      j = end;
    }
  }
  return -1;
}

/**
 * The icon-only `<button>`s of one component that lack a tooltip or a label. Icon-only: its class has the `icon` token,
 * or its content is only `<Icon …/>`, optionally inside `{#if}`. Each needs an aria-label, no native title (MenuButton's
 * title, set only when it is not icon-only, is the one exception) and a `<Tooltip` in the same file.
 */
function iconButtonProblems(file: string, text: string): string[] {
  const s = text.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, '');
  const problems: string[] = [];
  for (let i = s.search(/<button\b/); i >= 0; ) {
    const end = openEnd(s, i);
    if (end < 0) throw new Error(`${file}: cannot parse <button near ${JSON.stringify(s.slice(i, i + 60))}`);
    const tag = tags(file, s.slice(i, end))[0];
    const closeAt = s.slice(end).search(/<\/button\s*>/);
    if (closeAt < 0) throw new Error(`${file}: <button> never closes`);
    const close = end + closeAt;
    const content = s.slice(end, close).replace(/\{[#:/](if|else)\b[^}]*\}/g, '').replace(/>\s+</g, '><').trim();
    const value = (name: string) => tag.attrs.find((a) => a.name === name)?.value;
    const iconOnly = classTokens(value('class')?.replace(/^["']|["']$/g, '')).includes('icon') || /^(<Icon\b[^>]*\/>)+$/.test(content);
    if (iconOnly) {
      const at = `${file}: <button ${s.slice(i + 8, Math.min(end, i + 80)).trim()}`;
      if (!value('aria-label')) problems.push(`${at} has no aria-label`);
      const title = value('title');
      if (tag.attrs.some((a) => a.name === 'title') && !(title !== undefined && title.startsWith('{iconOnly ? undefined :'))) problems.push(`${at} has a native title`);
      if (!s.includes('<Tooltip')) problems.push(`${at} has no <Tooltip> in its file`);
    }
    const next = s.slice(close).search(/<button\b/);
    i = next < 0 ? -1 : close + next;
  }
  return problems;
}

test('the icon-button sweep finds a planted button without a tooltip', () => {
  const planted = `<script lang="ts">import Icon from './Icon.svelte';</script>
<div>
  <button class="btn sm icon" aria-label={$t('x.y')} onclick={go}><Icon name="close" /></button>
  <button class="btn sm" title={$t('x.z')}>{#if on}<Icon name="play" />{:else}<Icon name="stop" />{/if}</button>
  <button class="btn sm">{$t('x.text')}</button>
</div>`;
  const found = iconButtonProblems('Planted.svelte', planted);
  assert.equal(found.filter((p) => p.includes('no <Tooltip>')).length, 2, `both icon-only buttons lack a tooltip: ${found.join('; ')}`);
  assert.ok(found.some((p) => p.includes('no aria-label')), 'the unlabelled one is reported');
  assert.ok(found.some((p) => p.includes('native title')), 'a native title is reported');
  assert.ok(!found.some((p) => p.includes('x.text')), 'a text button is not icon-only');
  const fixed = `<button bind:this={b} class="btn icon" aria-label={$t('x.y')}><Icon name="close" /></button><Tooltip anchor={b} text={$t('x.y')} />`;
  assert.deepEqual(iconButtonProblems('Fixed.svelte', fixed), []);
});

test('every icon-only button has a tooltip and a label', () => {
  assert.ok(svelte.length > 30, `${svelte.length} components`);
  assert.deepEqual(svelte.flatMap(([f, text]) => iconButtonProblems(f, text)), []);
});
