// Deterministic job titles from dashboard free text (lib/title.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveTitle, normalizeTitle } from '../lib/title.ts';

test('deriveTitle examples', () => {
  const cases: [string, string | null][] = [
    ['Add a reading-time badge to blog posts', 'Add a reading-time badge to blog posts'],
    ['please add a reading-time badge. It should show minutes.', 'Add a reading-time badge'],
    ['Can you please fix the login redirect?', 'Fix the login redirect'],
    ["/forge we need to let's add dark mode", 'Add dark mode'],
    ['/forge:forge Pls, add export', 'Add export'],
    ['## **Dark** mode for `settings`\n\nMore detail here.', 'Dark mode for settings'],
    ['- [ ] [Link text](https://example.com/x) and more', 'Link text and more'],
    ['\n\n  > quoted request: support CSV!  \nsecond line', 'Quoted request: support CSV'],
    ['one two three four five six seven eight nine ten', 'One two three four five six seven eight'],
    ['Supercalifragilisticexpialidocious internationalization localization configuration', 'Supercalifragilisticexpialidocious internationalization'],
    ['x'.repeat(80), 'X'.concat('x'.repeat(59))],
    ['next button is broken!!!', 'Next button is broken'],
    ['"Quoted" request…', 'Quoted" request'],
    ['   ', null],
    ['!!! ??? ...', null],
    ['/forge', null],
    ['please', null],
    ['v1.2 release notes. Then more', 'V1.2 release notes'],
    ['café menu', 'Café menu'],
  ];
  for (const [input, want] of cases) assert.equal(deriveTitle(input), want, JSON.stringify(input));
  for (const [input] of cases) assert.equal(deriveTitle(input), deriveTitle(input), 'deterministic');
  for (const [input] of cases) {
    const t = deriveTitle(input);
    if (t) assert.ok(t.length <= 60 && t.split(' ').length <= 8, t);
  }
  assert.equal(deriveTitle('Fix\u0007 the bell'), 'Fix the bell');
});

test('normalizeTitle', () => {
  assert.equal(normalizeTitle('  My   title\n\twith\u0000 junk here '), 'My title with junk here');
  assert.equal(normalizeTitle('a'.repeat(200))!.length, 120);
  assert.equal(normalizeTitle(' \n\t '), null);
  assert.equal(normalizeTitle(''), null);
  assert.equal(normalizeTitle('Keep <script> as text'), 'Keep <script> as text');
});
