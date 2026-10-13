// Static guards for the Svelte dashboard (dashboard/src). Reads files only, so `npm test` needs no compiler and no
// node_modules: Svelte's {…} interpolation escapes by construction, and these tests keep raw HTML confined to the
// escape-first builders (md, budget*, screenshotsPanel) whose own suites pin their escaping.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const BUILDER_FILES = ['src/lib/markdown.ts', 'src/lib/budget.ts', 'src/lib/screenshots.ts'];

const FILES = [
  'index.html', 'style.css', 'svelte.config.mjs', 'vite.config.mjs', 'tsconfig.json',
  'src/main.ts', 'src/App.svelte',
  ...['Pipeline', 'Inbox', 'Backlog', 'Agents', 'Analytics', 'Evals'].map((v) => `src/views/${v}.svelte`),
  ...['Nav', 'Icon', 'Chip', 'StateChip', 'VerdictChip', 'PrChip', 'ProgressBar', 'PageHeader', 'Banner', 'Empty', 'JobCard', 'JobsTable', 'InboxCard', 'CompareTable', 'DepChips', 'DepSection', 'Drawer', 'DaemonBar', 'Toast'].map((c) => `src/components/${c}.svelte`),
  ...['app.svelte', 'toast.svelte', 'view', 'daemon-log', 'prefs', 'icons', 'daemon', 'deps', 'util'].map((m) => `src/lib/${m}.ts`),
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
        const prefers = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        document.documentElement.dataset.theme = saved || prefers;
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
  assert.match(html, /<body class="min-h-screen"><\/body>/);
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
    const text = read(f);
    for (const m of text.matchAll(/\{@html/g)) {
      const call = /^\{@html\s+(md|budgetChip|budgetCell|budgetPanel|screenshotsPanel)\(/.exec(text.slice(m.index));
      assert.ok(call, `${f}: {@html} must call an escape-first builder: ${text.slice(m.index, m.index + 60)}`);
      const name = /** @type {keyof typeof BUILDERS} */ (call[1]);
      const imp = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'(\\.\\.?\\/)+lib\\/(markdown|budget|screenshots)\\.ts'`);
      const found = imp.exec(text);
      assert.ok(found, `${f} imports ${name} from lib/${BUILDERS[name]}.ts`);
      assert.equal(found[2], BUILDERS[name], `${f}: ${name} comes from lib/${BUILDERS[name]}.ts`);
      if (f === 'src/components/Drawer.svelte' && name === 'md') drawerMd = true;
    }
  }
  assert.ok(drawerMd, 'Drawer.svelte renders markdown through {@html md(…)}');
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

test('dynamic links go through safeUrl', () => {
  let checked = 0;
  for (const f of sources().filter((x) => !BUILDER_FILES.includes(x))) {
    const text = read(f);
    for (const m of text.matchAll(/\bhref=("[^"]*"|\{[^}]*\})/g)) {
      const v = m[1];
      if (!v.includes('{')) continue;
      checked++;
      if (/^"#\/\{[^}]+\}"$/.test(v) || /^\{`#\/\$\{[^`]+\}`\}$/.test(v)) continue;
      if (/^\{safeUrl\(/.test(v)) continue;
      const name = /^\{([A-Za-z_$][\w$]*)\}$/.exec(v)?.[1];
      assert.ok(name, `${f}: dynamic href ${v} is neither #/…, safeUrl(…) nor a name`);
      const assigned = new RegExp(`(\\{@const\\s+${name}\\s*=\\s*safeUrl\\(|\\bconst\\s+${name}\\s*=\\s*safeUrl\\(|\\bconst\\s+${name}\\s*=\\s*\\$derived\\(safeUrl\\()`);
      assert.match(text, assigned, `${f}: href={${name}} must come from safeUrl(…)`);
    }
  }
  assert.ok(checked >= 6, `checked ${checked} dynamic hrefs`);
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
