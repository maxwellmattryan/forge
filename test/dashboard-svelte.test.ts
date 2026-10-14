// Static guards for the Svelte dashboard (dashboard/src). Reads files only, so `npm test` needs no compiler and no
// node_modules: Svelte's {…} interpolation escapes by construction, and these tests keep raw HTML confined to the
// escape-first builders (md, budget*, screenshotsPanel) whose own suites pin their escaping.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLOSE, endOf, soleCall, tags } from './svelte-markup.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD = path.join(ROOT, 'dashboard');
const SRC = path.join(DASHBOARD, 'src');
const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(DASHBOARD, rel), 'utf8');

/** Every .ts and .svelte file under dashboard/src, as paths relative to dashboard/. */
const sources = () =>
  fs
    .readdirSync(SRC, { recursive: true })
    .map((f) => `src/${String(f).split(path.sep).join('/')}`)
    .filter((f) => /\.(ts|svelte)$/.test(f))
    .sort();
const svelteFiles = () => sources().filter((f) => f.endsWith('.svelte'));
/** The escape-first HTML builders; their output is the only raw HTML the app renders. */
const BUILDERS = { md: 'markdown', budgetChip: 'budget', budgetCell: 'budget', budgetPanel: 'budget', screenshotsPanel: 'screenshots' };

/** @param {string} file @param {string} text */
function htmlProblems(file, text) {
  const problems = [];
  const calls = [];
  for (const m of text.matchAll(/\{@html\b/g)) {
    const end = endOf(text, m.index);
    const name = end < 0 ? null : soleCall(text.slice(m.index + '{@html'.length, end));
    if (!name || !Object.hasOwn(BUILDERS, name)) {
      problems.push(`${file}: {@html} must be exactly one escape-first builder call: ${text.slice(m.index, end < 0 ? m.index + 60 : end + 1)}`);
      continue;
    }
    const lib = BUILDERS[/** @type {keyof typeof BUILDERS} */ (name)];
    const imp = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'(?:\\.\\.?\\/)+lib\\/${lib}\\.ts'`);
    if (!imp.test(text)) problems.push(`${file}: ${name} must be imported from lib/${lib}.ts`);
    calls.push(name);
  }
  return { problems, calls };
}

/** The right-hand side of the assignment starting at `i`: up to `;`, a newline, or the `}` closing an `{@const}`. */
function rhs(/** @type {string} */ text, /** @type {number} */ i) {
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
function fromSafeUrl(/** @type {string} */ text, /** @type {string} */ name) {
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
 * @param {string} text @param {string} value
 * @returns {{ via: 'prefix' | 'safeUrl' } | { why: string }}
 */
function urlVerdict(text, value) {
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

/** @param {string} file @param {string} text */
function urlProblems(file, text) {
  const problems = [];
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

const FILES = [
  'index.html', 'style.css', 'svelte.config.mjs', 'vite.config.mjs', 'tsconfig.json',
  'src/main.ts', 'src/App.svelte',
  ...['Pipeline', 'Inbox', 'Backlog', 'Agents', 'Analytics', 'Evals'].map((v) => `src/views/${v}.svelte`),
  ...['Nav', 'Icon', 'Chip', 'StateChip', 'VerdictChip', 'PrChip', 'ProgressBar', 'PageHeader', 'Banner', 'Empty', 'JobCard', 'JobsTable', 'InboxCard', 'CompareTable', 'DepChips', 'DepSection', 'Drawer', 'DaemonBar', 'SessionLog', 'Toast'].map((c) => `src/components/${c}.svelte`),
  ...['app.svelte', 'toast.svelte', 'view', 'daemon-log', 'session-log', 'prefs', 'icons', 'daemon', 'deps', 'util'].map((m) => `src/lib/${m}.ts`),
];

const HEAD = `<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="forge-token" content="__FORGE_TOKEN__" />
    <title>Forge</title>
    <link rel="icon" type="image/png" href="/forge.png" />
    <script>
      try {
        const saved = localStorage.getItem('forge.theme');
        const light = matchMedia('(prefers-color-scheme: light)').matches;
        document.documentElement.dataset.theme =
          saved === 'cyanotype' || saved === 'dark' ? 'cyanotype' : saved === 'vellum' || saved === 'light' ? 'vellum' : light ? 'vellum' : 'cyanotype';
      } catch {}
    </script>
    <link rel="stylesheet" href="/style.css" />
    <script type="module" src="/src/main.ts"></script>
  </head>`;

test('inventory: the Svelte app replaced app.js and daemon.js', () => {
  for (const gone of ['app.js', 'daemon.js']) assert.equal(fs.existsSync(path.join(DASHBOARD, gone)), false, `dashboard/${gone} is gone`);
  for (const f of FILES) assert.ok(fs.existsSync(path.join(DASHBOARD, f)), `dashboard/${f} exists`);
  const html = read('index.html');
  assert.ok(html.includes(HEAD), 'index.html keeps its head; only the module entry changed');
  assert.match(html, /<body class="ground min-h-screen"><\/body>/);
  assert.equal([...html.matchAll(/<script type="module"/g)].length, 1);
  const all = [...sources(), 'index.html', 'vite.config.mjs', 'svelte.config.mjs'].map((f) => [f, read(f)]);
  for (const [f, text] of all)
    for (const name of ['lineHtml', 'daemonBar(', 'noteHtml', 'depChips', 'depSection', 'mountDaemon']) assert.ok(!text.includes(name), `${f} mentions ${name}`);
  assert.doesNotMatch(read('src/lib/util.ts'), /export\s+(async\s+)?(function|const|let)\s+toast\b/, 'util.ts no longer exports toast');
});

test('components are TypeScript, unstyled, and use whole class literals', () => {
  const files = svelteFiles();
  assert.ok(files.length >= 26, `found ${files.length} components`);
  for (const f of files) {
    const text = read(f);
    for (const tag of text.match(/<script\b[^>]*>/g) ?? []) assert.equal(tag, '<script lang="ts">', `${f}: ${tag}`);
    assert.doesNotMatch(text, /<style\b/, `${f} has a <style> block`);
    assert.doesNotMatch(text, /\bclass:[A-Za-z]/, `${f} uses a class: directive`);
    assert.doesNotMatch(text, /\son:[a-z]/, `${f} uses an on: directive`);
    assert.doesNotMatch(text, /\besc\(/, `${f} calls esc(): Svelte escapes already, so it would double-escape`);
    // A class token glued to an expression (`bg-{tone}`) hides it from Tailwind's scanner.
    for (const m of text.matchAll(/\bclass="([^"]*)"/g)) {
      assert.doesNotMatch(m[1], /[\w/-]\{|\}[\w/-]/, `${f}: class fragment in "${m[1]}"`);
    }
    assert.doesNotMatch(text, /\bclass=\{`/, `${f}: template-literal class`);
  }
});

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
  for (const f of svelteFiles()) {
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
  for (const markup of ok) assert.deepEqual(urlProblems('ok.svelte', head + markup).problems, [], markup);
  const bad = [
    // Gap 2: shorthand whose name never passed through safeUrl, and spreads on URL-bearing elements.
    `<script lang="ts">\n  let { href } = $props();\n</script>\n<a {href}>x</a>`,
    ...['a', 'iframe', 'img', 'form', 'area', 'link'].map((t) => `${head}<${t} {...props}></${t}>`),
    // Gap 3: the other URL attributes.
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
  for (const markup of bad) assert.ok(urlProblems('bad.svelte', markup).problems.length > 0, markup);
});

test('svelte config forces runes and the entry mounts the app', async () => {
  const cfgPath = path.join(DASHBOARD, 'svelte.config.mjs');
  assert.doesNotMatch(fs.readFileSync(cfgPath, 'utf8'), /\bimport\b/, 'svelte.config.mjs imports nothing');
  const cfg = (await import(pathToFileURL(cfgPath).href)).default;
  assert.deepEqual(cfg, { compilerOptions: { runes: true } });
  const main = read('src/main.ts');
  assert.match(main, /import \{ mount \} from 'svelte';/);
  assert.match(main, /import App from '\.\/App\.svelte';/);
  assert.match(main, /mount\(App, \{ target: document\.body \}\)/);
  const vite = read('vite.config.mjs');
  assert.match(vite, /import \{ svelte \} from '@sveltejs\/vite-plugin-svelte';/);
  assert.match(vite, /plugins: \[tailwindcss\(\), svelte\(\)\]/);
  const css = read('style.css');
  for (const src of ['./index.html', './src/**/*.ts', './src/**/*.svelte']) assert.ok(css.includes(`@source "${src}";`), `style.css sources ${src}`);
  assert.ok(!css.includes('@source "./*.js"'), 'no ./*.js source');
});
