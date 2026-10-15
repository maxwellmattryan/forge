// The dashboard's strict-TypeScript helpers, imported straight from source through Node's type
// stripping (Node >= 22.18). Goldens were computed from the pre-port app.js/util.js, so any drift
// in escaping or markdown output fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc, num, usd, ago, pct, tokensShort, dur, clock } from '../dashboard/src/lib/util.ts';
import { md, inline, safeUrl } from '../dashboard/src/lib/markdown.ts';
import { STAGE_LABEL, WAIT_LABEL } from '../dashboard/src/lib/labels.ts';
import * as types from '../dashboard/src/lib/types.ts';
import * as schema from '../lib/schema.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD = path.join(ROOT, 'dashboard');
const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('tsconfig is strict and erasable-only', () => {
  const raw = read('dashboard/tsconfig.json');
  const tsconfig = JSON.parse(raw);
  const o = tsconfig.compilerOptions;
  assert.equal(o.strict, true);
  assert.equal(o.noEmit, true);
  assert.equal(o.verbatimModuleSyntax, true);
  assert.equal(o.erasableSyntaxOnly, true);
  assert.equal(o.allowImportingTsExtensions, true);
  assert.equal(o.isolatedModules, true);
  assert.equal(o.module, 'esnext');
  assert.equal(o.moduleResolution, 'bundler');
  assert.equal(o.target, 'es2022');
  assert.deepEqual(o.lib, ['es2022', 'dom', 'dom.iterable']);
  assert.deepEqual(o.types, []);
  assert.equal(o.skipLibCheck, true);
  assert.equal(o.allowJs, undefined, 'no JavaScript sources: the app is .ts and .svelte only');
  assert.deepEqual(tsconfig.include, ['src/**/*.ts', 'src/**/*.svelte']);
});

test('src/lib modules exist and the vanilla copies are gone', () => {
  for (const f of ['app', 'daemon', 'util', 'budget', 'deps', 'screenshots']) assert.equal(fs.existsSync(path.join(DASHBOARD, `${f}.js`)), false, `dashboard/${f}.js is gone`);
  for (const f of ['util', 'markdown', 'labels', 'budget', 'deps', 'screenshots', 'daemon', 'types', 'view', 'prefs', 'icons', 'daemon-log'])
    assert.ok(fs.existsSync(path.join(DASHBOARD, 'src', 'lib', `${f}.ts`)), `dashboard/src/lib/${f}.ts exists`);
});

test('md, inline and safeUrl render exactly as before', () => {
  const A = ' target="_blank" rel="noopener noreferrer"';
  const goldens = [
    ['<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>', '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><p>&lt;img src=x onerror=alert(1)&gt;</p>'],
    ['[click](javascript:alert(1))', '<p>click)</p>'],
    ['[docs](https://example.com/a?b=1&c=2)', `<p><a href="https://example.com/a?b=1&amp;c=2"${A}>docs</a></p>`],
    // The period ends the sentence, not the URL (it was inside the link before).
    ['see https://example.com/x.', `<p>see <a href="https://example.com/x"${A}>https://example.com/x</a>.</p>`],
    ['```\n<b>x</b>\n```', '<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>'],
    ['use `<i>` and **bold** and *em* and _u_', '<p>use <code>&lt;i&gt;</code> and <strong>bold</strong> and <em>em</em> and <em>u</em></p>'],
    ['#### Deep <x>', '<h3>Deep &lt;x&gt;</h3>'],
    [
      '- [x] done\n- [ ] open\n- [~] half\n- plain',
      '<ul><li class="list-none -ml-5"><span class="text-muted mr-1">☑</span>done</li><li class="list-none -ml-5"><span class="text-muted mr-1">☐</span>open</li><li class="list-none -ml-5"><span class="text-muted mr-1">◐</span>half</li><li>plain</li></ul>',
    ],
    ['1. one\n2. two', '<ol><li>one</li><li>two</li></ol>'],
    ['- [blocker] bad <b>\n- [NIT] tiny', '<ul><li><span class="chip bad">blocker</span> bad &lt;b&gt;</li><li><span class="chip muted">nit</span> tiny</li></ul>'],
    ['| a | b |\n|---|---|\n| <i> | `c` |', '<div class="overflow-x-auto"><table><tr><th>a</th><th>b</th></tr><tr><td>&lt;i&gt;</td><td><code>c</code></td></tr></table></div>'],
    ['> quoted <q>\n> more', '<blockquote>quoted &lt;q&gt; more</blockquote>'],
    ['---', '<hr class="border-line my-3">'],
    ['<!-- hidden\nstill -->\nvisible', '<p>visible</p>'],
    ['[x](https://e.com/"onmouseover="alert(1))', `<p><a href="https://e.com/&amp;quot;onmouseover=&amp;quot;alert(1"${A}>x</a>)</p>`],
    ['a\r\nb', '<p>a b</p>'],
  ];
  for (const [input, expected] of goldens) assert.equal(md(input), expected, JSON.stringify(input));
  const hostile = md('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
  assert.ok(!hostile.includes('<script'), 'no live <script');
  assert.ok(!hostile.includes('<img'), 'no live <img');
  assert.equal(inline('a <b> `c`'), 'a &lt;b&gt; <code>c</code>');

  for (const same of ['https://x.y/a', 'http://x', '#frag', '/path', 'HTTPS://X']) assert.equal(safeUrl(same), same);
  for (const bad of ['//evil.com', 'javascript:alert(1)', 'JAVASCRIPT:x', 'data:text/html,x', null]) assert.equal(safeUrl(bad), null, String(bad));
});

test('formatters and esc render exactly as before', () => {
  assert.equal(pct(null), '—');
  assert.equal(pct(0.456), '46%');
  assert.equal(pct(1), '100%');
  assert.equal(tokensShort(null), '—');
  assert.equal(tokensShort(999), '999');
  assert.equal(tokensShort(1500), '2k');
  assert.equal(tokensShort(999999), '1.0M');
  assert.equal(tokensShort(1234567), '1.2M');
  assert.equal(tokensShort(999_960_000), '1.000B');
  assert.equal(tokensShort(1_469_000_000), '1.469B');
  assert.equal(tokensShort(2_500_000_000_000), '2.500T');
  assert.equal(tokensShort(1_234_000_000_000_000), '1234.000T');
  assert.equal(dur(null), '—');
  assert.equal(dur(0), '0m 0s');
  assert.equal(dur(61000), '1m 1s');
  assert.equal(dur(3720000), '1h 2m');
  assert.equal(usd(null), '—');
  assert.equal(usd(2), '$2.00');
  assert.equal(usd(0.5), '$0.500');
  // num(<number>) is locale-dependent, so only the null case has a golden.
  assert.equal(num(null), '—');
  assert.equal(ago(null), '—');
  assert.equal(esc(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(esc(null), '');
});

test('ago takes a fixed now', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const before = (s: number) => new Date(now - s * 1000).toISOString();
  assert.equal(ago(before(59), now), '59s ago');
  assert.equal(ago(before(60), now), '1m ago');
  assert.equal(ago(before(3600), now), '1h ago');
  assert.equal(ago(null, now), '—');
  // Without `now` it reads the wall clock: a time a few ms old is "0s ago", and one a day old is "1d ago".
  assert.equal(ago(new Date().toISOString()), '0s ago');
  assert.equal(ago(new Date(Date.now() - 86400000).toISOString()), '1d ago');
});

test('types.ts constants and labels match lib/schema.ts', () => {
  assert.equal(types.API_VERSION, schema.API_VERSION);
  assert.deepEqual([...types.STAGES], [...schema.STAGES]);
  assert.deepEqual([...types.STATES], [...schema.STATES]);
  assert.deepEqual([...types.WAITING_ON], [...schema.WAITING_ON]);
  for (const s of schema.STAGES) assert.ok(typeof STAGE_LABEL[s] === 'string' && STAGE_LABEL[s].length > 0, `label for stage ${s}`);
  for (const w of schema.WAITING_ON) assert.ok(typeof WAIT_LABEL[w] === 'string' && WAIT_LABEL[w].length > 0, `label for waitingOn ${w}`);
});

test('runtime code never imports dashboard sources', () => {
  /** @type {string[]} */
  const files = [];
  const walk = (/** @type {string} */ d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) files.push(full);
    }
  };
  walk(path.join(ROOT, 'lib'));
  walk(path.join(ROOT, 'bin'));
  assert.ok(files.length > 10, 'walked lib/ and bin/');
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f);
    assert.ok(!text.includes('dashboard/src'), `${rel} mentions dashboard/src`);
    // The engine is TypeScript too now, so only a .ts import that reaches into dashboard/ is refused.
    assert.doesNotMatch(text, /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"][^'"]*dashboard[^'"]*\.ts['"]/, `${rel} imports a dashboard .ts file`);
  }
});

test('clock: a local HH:MM:SS, or nothing for a missing or unparseable time', () => {
  assert.match(clock('2026-10-14T04:36:00.672Z'), /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(clock(new Date(2026, 0, 1, 9, 5, 7).toISOString()), '09:05:07');
  assert.equal(clock(null), '');
  assert.equal(clock(''), '');
  assert.equal(clock('yesterday'), '');
});
