// Guards the committed dashboard/dist/: reads files only, so it needs no Vite, no node_modules
// and no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAMP, sourceHash, distHash } from '../dashboard/build-stamp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD = path.join(ROOT, 'dashboard');
const DIST = path.join(DASHBOARD, 'dist');
const STALE = 'dashboard/dist is stale: run `npm run build:dashboard` and commit dashboard/dist';
const ASSET = /^assets\/[\w.-]+\.(js|css|woff2)$/;

/** Every file name the manifest points at (file, css[] and assets[] of each entry). */
function manifestFiles(): any {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  /** @type {Set<string>} */
  const out = new Set();
  for (const entry of Object.values(manifest) as any) {
    if (entry.file) out.add(entry.file);
    for (const k of ['css', 'assets']) for (const f of entry[k] ?? []) out.add(f);
  }
  return out;
}

/** @param {string} dir @returns {string[]} */
function listFiles(dir, rel = '') {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? listFiles(dir, r) : [r];
  });
}

test('package.json: exact-pinned devDependencies only, no install hooks', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const pinned = { '@sveltejs/vite-plugin-svelte': '6.2.4', '@tailwindcss/vite': '4.1.18', '@types/node': '22.18.13', svelte: '5.57.1', 'svelte-check': '4.7.6', tailwindcss: '4.1.18', typescript: '6.0.3', vite: '7.3.7' };
  assert.deepEqual(pkg.devDependencies, pinned);
  for (const [name, v] of Object.entries(pkg.devDependencies)) assert.match(String(v), /^\d+\.\d+\.\d+$/, `${name} must be exact-pinned`);
  assert.equal(pkg.dependencies, undefined, 'the plugin has zero runtime dependencies');
  for (const hook of ['prepare', 'preinstall', 'install', 'postinstall']) assert.equal(pkg.scripts?.[hook], undefined, `no ${hook} script`);
  assert.equal(typeof pkg.scripts?.['build:dashboard'], 'string');
  assert.equal(pkg.scripts?.['check:dashboard'], 'svelte-check --tsconfig dashboard/tsconfig.json --fail-on-warnings');
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.lockfileVersion, 3);
  for (const [name, v] of Object.entries(pinned)) assert.equal(lock.packages[`node_modules/${name}`]?.version, v, `lockfile resolves ${name}`);
  // esbuild and fsevents predate the Svelte toolchain; anything new that runs code on install fails here.
  const scripted = Object.entries(lock.packages).filter(([, e]: any) => e?.hasInstallScript).map(([k]) => k).sort();
  assert.deepEqual(scripted, ['node_modules/esbuild', 'node_modules/fsevents']);
});

test('dist holds only the manifest\'s files plus index, manifest and stamp', () => {
  const named = manifestFiles();
  assert.ok(named.size >= 2, 'the manifest names at least the module and the stylesheet');
  for (const f of named) assert.match(f, ASSET);
  const expected = ['index.html', 'manifest.json', STAMP, ...named].sort();
  assert.deepEqual(listFiles(DIST).sort(), expected);
});

test('dist is fresh: build-stamp matches sources and dist contents', () => {
  let stamp;
  try {
    stamp = JSON.parse(fs.readFileSync(path.join(DIST, STAMP), 'utf8'));
  } catch {
    assert.fail(STALE);
  }
  assert.equal(stamp.source, sourceHash(DASHBOARD, path.join(ROOT, 'package-lock.json')), `${STALE} (sources or package-lock.json changed)`);
  assert.equal(stamp.dist, distHash(DIST), `${STALE} (dist/ was edited by hand)`);
});

test('build-stamp hashes notice source, lockfile and dist edits', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-stamp-'));
  try {
    const dash = path.join(tmp, 'dashboard');
    fs.mkdirSync(path.join(dash, 'dist', 'assets'), { recursive: true });
    fs.mkdirSync(path.join(dash, 'node_modules'));
    fs.writeFileSync(path.join(dash, 'app.js'), 'export {};\n');
    fs.writeFileSync(path.join(dash, 'dist', 'assets', 'index-x.js'), 'x');
    const lock = path.join(tmp, 'package-lock.json');
    const writeLock = (/** @type {string} */ v, /** @type {string} */ root = '1.0.0') =>
      fs.writeFileSync(lock, JSON.stringify({ packages: { '': { version: root }, 'node_modules/vite': { version: v, resolved: 'r' } } }));
    writeLock('7.3.7');
    const base = sourceHash(dash, lock);
    // Ignored: the dist dir, node_modules, dotfiles, the root package version.
    fs.writeFileSync(path.join(dash, 'dist', 'index.html'), 'x');
    fs.writeFileSync(path.join(dash, 'node_modules', 'x.js'), 'x');
    fs.writeFileSync(path.join(dash, '.DS_Store'), 'x');
    writeLock('7.3.7', '2.0.0');
    assert.equal(sourceHash(dash, lock), base);
    // CRLF checkouts hash like LF ones.
    fs.writeFileSync(path.join(dash, 'app.js'), 'export {};\r\n');
    assert.equal(sourceHash(dash, lock), base);
    fs.appendFileSync(path.join(dash, 'app.js'), '// edit\n');
    assert.notEqual(sourceHash(dash, lock), base, 'edited source');
    fs.writeFileSync(path.join(dash, 'app.js'), 'export {};\n');
    fs.writeFileSync(path.join(dash, 'new.js'), '');
    assert.notEqual(sourceHash(dash, lock), base, 'added source');
    fs.rmSync(path.join(dash, 'new.js'));
    fs.rmSync(path.join(dash, 'app.js'));
    assert.notEqual(sourceHash(dash, lock), base, 'removed source');
    fs.writeFileSync(path.join(dash, 'app.js'), 'export {};\n');
    assert.equal(sourceHash(dash, lock), base);
    // TypeScript sources nest under src/lib/, and tsconfig.json can change what Vite emits.
    fs.mkdirSync(path.join(dash, 'src', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dash, 'src', 'lib', 'x.ts'), 'export const x: number = 1;\n');
    const nested = sourceHash(dash, lock);
    assert.notEqual(nested, base, 'added nested ts source');
    fs.appendFileSync(path.join(dash, 'src', 'lib', 'x.ts'), '// edit\n');
    const edited = sourceHash(dash, lock);
    assert.notEqual(edited, nested, 'edited nested ts source');
    fs.writeFileSync(path.join(dash, 'tsconfig.json'), '{}\n');
    const withTsconfig = sourceHash(dash, lock);
    assert.notEqual(withTsconfig, edited, 'added tsconfig.json');
    fs.writeFileSync(path.join(dash, 'tsconfig.json'), '{"compilerOptions":{}}\n');
    assert.notEqual(sourceHash(dash, lock), withTsconfig, 'edited tsconfig.json');
    // Svelte components nest under src/components/, and svelte.config.mjs changes how they compile.
    fs.mkdirSync(path.join(dash, 'src', 'components'), { recursive: true });
    fs.writeFileSync(path.join(dash, 'src', 'components', 'X.svelte'), '<p>x</p>\n');
    const component = sourceHash(dash, lock);
    assert.notEqual(component, withTsconfig, 'added nested svelte component');
    fs.appendFileSync(path.join(dash, 'src', 'components', 'X.svelte'), '<!-- edit -->\n');
    const editedComponent = sourceHash(dash, lock);
    assert.notEqual(editedComponent, component, 'edited nested svelte component');
    fs.writeFileSync(path.join(dash, 'svelte.config.mjs'), 'export default {};\n');
    assert.notEqual(sourceHash(dash, lock), editedComponent, 'added svelte.config.mjs');
    fs.rmSync(path.join(dash, 'svelte.config.mjs'));
    fs.rmSync(path.join(dash, 'src'), { recursive: true });
    fs.rmSync(path.join(dash, 'tsconfig.json'));
    writeLock('7.3.8');
    assert.notEqual(sourceHash(dash, lock), base, 'package version change');
    const dist = distHash(path.join(dash, 'dist'));
    fs.writeFileSync(path.join(dash, 'dist', STAMP), '{}');
    assert.equal(distHash(path.join(dash, 'dist')), dist, 'the stamp is not part of its own hash');
    fs.appendFileSync(path.join(dash, 'dist', 'assets', 'index-x.js'), 'y');
    assert.notEqual(distHash(path.join(dash, 'dist')), dist, 'hand-edited dist');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The theme bootstrap must run before the stylesheet so there is no flash of the wrong theme.
const THEME_SCRIPT = `<script>
      try {
        const saved = localStorage.getItem('forge.theme');
        const light = matchMedia('(prefers-color-scheme: light)').matches;
        document.documentElement.dataset.theme =
          saved === 'cyanotype' || saved === 'dark' ? 'cyanotype' : saved === 'vellum' || saved === 'light' ? 'vellum' : light ? 'vellum' : 'cyanotype';
      } catch {}
    </script>`;

test('dist index keeps token meta and theme bootstrap, loads only local hashed assets', () => {
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const named = manifestFiles();
  assert.ok(html.includes('<meta name="forge-token" content="__FORGE_TOKEN__" />'));
  assert.match(html, /<html lang="en" data-theme="cyanotype">/);
  const theme = html.indexOf(THEME_SCRIPT);
  assert.ok(theme > 0, 'theme bootstrap is inline and unchanged');
  assert.ok(fs.readFileSync(path.join(DASHBOARD, 'index.html'), 'utf8').includes(THEME_SCRIPT), 'source keeps the same bootstrap');
  assert.ok(html.includes('<link rel="icon" type="image/png" href="/forge.png" />'));
  assert.match(html, /<body class="ground min-h-screen">\s*<\/body>/, 'the Svelte app mounts into an empty body');
  const modules = [...html.matchAll(/<script type="module"[^>]*\ssrc="\/([^"]+)"/g)].map((m) => m[1]);
  assert.equal(modules.length, 1, 'one module script');
  assert.ok(named.has(modules[0]), `${modules[0]} is a manifest file`);
  const sheets = [...html.matchAll(/<link rel="stylesheet"[^>]*\shref="\/([^"]+)"/g)].map((m) => [m[1], m.index ?? -1]);
  assert.equal(sheets.length, 1, 'one stylesheet');
  assert.ok(named.has(String(sheets[0][0])), `${sheets[0][0]} is a manifest file`);
  assert.ok(theme < Number(sheets[0][1]), 'theme bootstrap comes before the stylesheet');
  for (const banned of ['https://', 'tailwindcss/browser', 'integrity=', 'type="text/tailwindcss"']) assert.ok(!html.includes(banned), `no ${banned}`);
});

// Applied only from JS expressions, or custom utilities/classes: the likeliest to be missed.
const DYNAMIC_CLASSES =
  'bg-ok/15 text-ok bg-bad/15 text-bad bg-warn/15 text-warn bg-info/15 text-info bg-accent/15 text-accent bg-raised text-muted bg-ok bg-warn bg-bad bg-muted border-warn/50 border-accent/60 border-accent border-transparent text-fg hover:text-fg translate-x-full hidden card chip btn btn-primary nav-item active kpi kpi-label kpi-value tbl prose-md ember-bar brand-rule';

test('compiled CSS covers dynamically applied and custom classes', () => {
  const css = [...manifestFiles()].filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(DIST, f), 'utf8')).join('\n');
  assert.ok(css.length > 0, 'a stylesheet is built');
  for (const cls of DYNAMIC_CLASSES.split(' ')) {
    const selector = '.' + cls.replace(/[/:.[\]]/g, (c) => '\\' + c);
    // The selector must end there, so `.bg-ok` isn't satisfied by `.bg-ok\/15` alone.
    const at = [...css.matchAll(new RegExp(selector.replace(/[\\.[\]/]/g, (c) => '\\' + c) + '(?![\\w\\\\-])', 'g'))];
    assert.ok(at.length > 0, `no rule for .${cls} (expected ${selector}); rebuild with npm run build:dashboard or check @source in dashboard/style.css`);
  }
});
