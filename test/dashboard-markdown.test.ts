// The inline markdown renderer against hostile text: issue bodies and PR comments render on the
// origin that holds the POST token, so no input may put markup inside an attribute or nest anchors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { md, inline } from '../dashboard/src/lib/markdown.ts';

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
    ['see https://a.b/c, and http://d.e/f.', `see <a href="https://a.b/c,"${A}>https://a.b/c,</a> and <a href="http://d.e/f."${A}>http://d.e/f.</a>`],
    [
      '**bold** _it_ *em* [major] [MINOR] [blocker]',
      '<strong>bold</strong> <em>it</em> <em>em</em> <span class="chip warn">major</span> <span class="chip info">minor</span> <span class="chip bad">blocker</span>',
    ],
    ['https://a/x(https://b/y)', `<a href="https://a/x(https://b/y"${A}>https://a/x(https://b/y</a>)`],
    ['x_y_z and snake_case_name', 'x_y_z and snake_case_name'],
  ];
  for (const [input, expected] of goldens) assert.equal(inline(input), expected, JSON.stringify(input));
});

test('U+E000 in input is dropped', () => {
  assert.equal(inline('ab'), 'ab');
  assert.equal(inline(' https://a.b'), ` <a href="https://a.b"${A}>https://a.b</a>`);
  assert.equal(inline('[x](https://u.v)'), `<a href="https://u.v"${A}>x</a>`);
});
