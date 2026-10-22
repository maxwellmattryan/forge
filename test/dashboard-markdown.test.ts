// The inline markdown renderer against hostile text: issue bodies and PR comments render on the
// origin that holds the POST token, so no input may put markup inside an attribute or nest anchors.
// Also: when a string may go through md() (md-view.ts), and the PR chip's link check (safeUrl).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { md, inline, safeUrl } from '../dashboard/src/lib/markdown.ts';
import { MD_MAX, MD_SURFACES, MD_VIEWS, PROSE_KINDS, mdPrefKey, readMdView, renderable } from '../dashboard/src/lib/md-view.ts';

const A = ' target="_blank" rel="noopener noreferrer"';

function assertStructure(html: string, label = html) {
  const opens = html.match(/<a [^>]*>/g) ?? [];
  for (const tag of opens) assert.match(tag, /^<a href="[^"<>]*" target="_blank" rel="noopener noreferrer">$/, `${label}: ${tag}`);
  assert.ok(!/="[^"]*</.test(html), `${label}: markup inside an attribute value`);
  assert.equal((html.match(/<a /g) ?? []).length, (html.match(/<\/a>/g) ?? []).length, `${label}: unbalanced anchors`);
  let depth = 0;
  for (const m of html.matchAll(/<a |<\/a>/g)) {
    depth += m[0] === '<a ' ? 1 : -1;
    assert.ok(depth === 0 || depth === 1, `${label}: nested anchor`);
  }
}

test('a link whose URL holds a URL renders one anchor', () => {
  const html = md('see [x](https://a.example/p?q=(https://b.example/z)');
  assert.equal(html, '<p>see <a href="https://a.example/p?q=(https://b.example/z" target="_blank" rel="noopener noreferrer">x</a></p>');
  assert.equal((html.match(/<a/g) ?? []).length, 1);
  assertStructure(html);
});

test('hostile input never puts markup inside an attribute or nests anchors', () => {
  const hostile = [
    'see [x](https://a.example/p?q=(https://b.example/z)',
    '[x](https://a/(https://b/"onmouseover="alert(1))',
    'https://a/x(https://b/y)',
    '(https://'.repeat(1200),
    'https://x/_a_/ https://x/[nit] https://x/**b**',
    '[x](https://a/*b*_c_[blocker])',
    '[see https://x.y](https://z.w)',
    '_[x](https://u.v)_',
    '[a](https://b/(https://c/[d](https://e/f)))',
    '[x](https://a/`b`)',
    '<a href="https://x">y</a> https://z',
  ];
  for (const input of hostile) assertStructure(md(input), JSON.stringify(input.slice(0, 60)));

  // Deliberate changes: main's output on these is broken; these are the fixed renderings.
  const changed = [
    [
      'https://x/_a_/ https://x/[nit] https://x/**b**',
      `<a href="https://x/_a_/"${A}>https://x/_a_/</a> <a href="https://x/[nit]"${A}>https://x/[nit]</a> <a href="https://x/**b**"${A}>https://x/**b**</a>`,
    ],
    ['_[x](https://u.v)_', `<em><a href="https://u.v"${A}>x</a></em>`],
    ['[see https://x.y](https://z.w)', `<a href="https://z.w"${A}>see https://x.y</a>`],
    ['[x](https://a/(https://b/"onmouseover="alert(1))', `<a href="https://a/(https://b/&amp;quot;onmouseover=&amp;quot;alert(1"${A}>x</a>)`],
  ];
  for (const [input, expected] of changed) {
    assert.equal(inline(input), expected, JSON.stringify(input));
    assert.equal(md(input), `<p>${expected}</p>`, JSON.stringify(input));
    assertStructure(md(input), JSON.stringify(input));
  }
});

test('pathological lines render in under a second', () => {
  for (const unit of ['(https://', '[x](', '[']) {
    const line = unit.repeat(Math.ceil(10000 / unit.length)).slice(0, 10000);
    assert.equal(line.length, 10000);
    const start = performance.now();
    const html = md(line);
    const ms = performance.now() - start;
    assert.ok(ms < 1000, `${JSON.stringify(unit)} x ${line.length} took ${Math.round(ms)} ms`);
    assertStructure(html, JSON.stringify(unit));
  }
});

test('ordinary markdown renders exactly as on main', () => {
  // Each expected value is main's inline() output for the input.
  const goldens = [
    ['`see https://x.y/z` now', '<code>see https://x.y/z</code> now'],
    ['(see https://example.com/a) more', `(see <a href="https://example.com/a"${A}>https://example.com/a</a>) more`],
    ['see https://example.com/a) more', `see <a href="https://example.com/a"${A}>https://example.com/a</a>) more`],
    ['**see [x](https://y.z) now**', `<strong>see <a href="https://y.z"${A}>x</a> now</strong>`],
    ['*[x](https://u.v)*', `<em><a href="https://u.v"${A}>x</a></em>`],
    ['[x](https://x.y) and https://z.w', `<a href="https://x.y"${A}>x</a> and <a href="https://z.w"${A}>https://z.w</a>`],
    ['`c`https://x.y', `<code>c</code><a href="https://x.y"${A}>https://x.y</a>`],
    ['[a](https://x.y)https://z.w', `<a href="https://x.y"${A}>a</a>https://z.w`],
    [
      '**bold** _it_ *em* [major] [MINOR] [blocker]',
      '<strong>bold</strong> <em>it</em> <em>em</em> <span class="chip warn">major</span> <span class="chip info">minor</span> <span class="chip bad">blocker</span>',
    ],
    ['https://a/x(https://b/y)', `<a href="https://a/x(https://b/y"${A}>https://a/x(https://b/y</a>)`],
    ['x_y_z and snake_case_name', 'x_y_z and snake_case_name'],
  ];
  for (const [input, expected] of goldens) assert.equal(inline(input), expected, JSON.stringify(input));
});

test('a bare URL leaves trailing punctuation and quotes to the sentence', () => {
  const cases = [
    ['see https://a.b/c, and http://d.e/f.', `see <a href="https://a.b/c"${A}>https://a.b/c</a>, and <a href="http://d.e/f"${A}>http://d.e/f</a>.`],
    ['is it https://a.b/c?! yes', `is it <a href="https://a.b/c"${A}>https://a.b/c</a>?! yes`],
    ['at https://a.b/c: then; https://d.e/f;', `at <a href="https://a.b/c"${A}>https://a.b/c</a>: then; <a href="https://d.e/f"${A}>https://d.e/f</a>;`],
    // A URL starts after whitespace or `(` only, so these quotes are the closing ones.
    [`see https://a.b/c" and https://d.e/f'.`, `see <a href="https://a.b/c"${A}>https://a.b/c</a>&quot; and <a href="https://d.e/f"${A}>https://d.e/f</a>&#39;.`],
    ['(see https://a.b/c.) more', `(see <a href="https://a.b/c"${A}>https://a.b/c</a>.) more`],
    ['https://a.b/c>', `<a href="https://a.b/c"${A}>https://a.b/c</a>&gt;`],
    // Inside the URL nothing is trimmed, and an entity's closing `;` stays with it.
    ['https://a.b/v1.2/x?q=1,2&r=3', `<a href="https://a.b/v1.2/x?q=1,2&amp;r=3"${A}>https://a.b/v1.2/x?q=1,2&amp;r=3</a>`],
    ['https://a.b/c?x&', `<a href="https://a.b/c?x&amp;"${A}>https://a.b/c?x&amp;</a>`],
    ['https://a.b/c?x&.', `<a href="https://a.b/c?x&amp;"${A}>https://a.b/c?x&amp;</a>.`],
    // Nothing left after the scheme: plain text.
    ['see https://... later', 'see https://... later'],
  ];
  for (const [input, expected] of cases) assert.equal(inline(input), expected, JSON.stringify(input));
});

test('U+E000 in input is dropped', () => {
  assert.equal(inline('ab'), 'ab');
  assert.equal(inline(' https://a.b'), ` <a href="https://a.b"${A}>https://a.b</a>`);
  assert.equal(inline('[x](https://u.v)'), `<a href="https://u.v"${A}>x</a>`);
});

test('hostile HTML in session prose is escaped, markdown still renders', () => {
  const html = md('<script>alert(1)</script><img src=x onerror=alert(2)>\n**b**');
  assert.ok(html.includes('&lt;script&gt;'), html);
  assert.ok(html.includes('<strong>b</strong>'), html);
  assert.ok(!html.includes('<img'), html);
  assert.ok(!html.includes('<script'), html);
  assertStructure(html);
});

test('md memo returns identical output across eviction', () => {
  const first = '# Report\n- **done**\n```\n<b>x</b>\n```';
  const once = md(first);
  assert.equal(md(first), once, 'a hit returns the cached string');
  // Far more distinct inputs than the memo holds, so the first one is evicted and parsed again.
  for (let i = 0; i < 2000; i++) assert.equal(md(`line ${i} *em*`), `<p>line ${i} <em>em</em></p>`);
  assert.equal(md(first), once, 'an evicted input renders the same again');
  assert.equal(md(null), md(''), 'null and undefined key as the empty string');
  assert.equal(md(undefined), '');
});

describe('md-view', () => {
  // dashboard/src/lib/md-view.ts: the Rendered/Raw choice per surface and when a string may go through md().
  test("readMdView reads only 'raw' as raw", () => {
    for (const saved of [null, undefined, '', 'bogus', 'RAW', 'rendered', ' raw']) assert.equal(readMdView(saved), 'rendered', String(saved));
    assert.equal(readMdView('raw'), 'raw');
  });

  test('surfaces, views, prose kinds and pref keys', () => {
    assert.deepEqual(MD_SURFACES, ['files', 'thread', 'session']);
    assert.deepEqual(MD_VIEWS, ['rendered', 'raw']);
    assert.deepEqual(PROSE_KINDS, ['text', 'thinking']);
    assert.equal(mdPrefKey('thread'), 'mdView.thread');
    assert.deepEqual(MD_SURFACES.map(mdPrefKey), ['mdView.files', 'mdView.thread', 'mdView.session']);
  });

  test('renderable honours the view and the 20k cap', () => {
    assert.equal(MD_MAX, 20000);
    assert.equal(renderable('x'.repeat(20000), 'rendered'), true);
    assert.equal(renderable('x'.repeat(20001), 'rendered'), false);
    assert.equal(renderable('x', 'raw'), false);
    assert.equal(renderable('', 'rendered'), true);
  });
});

describe('pr-chip', () => {
  // The PR chip only links to a url safeUrl accepts; its markup is not tested, since tests can't import .svelte.
  // dashboard-lib.test.ts › "md, inline and safeUrl" holds javascript:, data:, protocol-relative, upper-case and null.
  test('a PR chip links only to a safe url', () => {
    for (const u of ['JaVaScRiPt:alert(1)', '', undefined]) assert.equal(safeUrl(u), null, String(u));
  });
});
