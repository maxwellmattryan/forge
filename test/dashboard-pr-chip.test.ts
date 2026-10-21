// The PR chip links to its PR (dashboard/src/components/PrChip.svelte): a real link outside a board card, a
// data-gh-href span inside one (the card is a button), and a plain chip without a safe URL. Tests can't import
// .svelte, so these read the source, as test/dashboard-github.test.ts does for the hover card.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { safeUrl } from '../dashboard/src/lib/markdown.ts';

const SRC = path.resolve(import.meta.dirname, '..', 'dashboard', 'src');
const read = (f: string): string => fs.readFileSync(path.join(SRC, f), 'utf8');
const chip = read('components/PrChip.svelte');
const markup = chip.slice(chip.indexOf('</script>'));

test('a PR chip with a safe url is a GitHub link', () => {
  assert.match(chip, /import \{ safeUrl \} from '\.\.\/lib\/markdown\.ts';/);
  assert.match(chip, /const href = \$derived\(safeUrl\(pr\?\.url\)\);/);
  assert.match(chip, /inButton = false/);
  // The tag ends at the first `>` outside an `=>`.
  const a = markup.match(/\{:else if !inButton\}(<a (?:[^>=]|=(?!>)|=>)*?>)(<Chip .*?)<\/a>/);
  assert.ok(a, 'the link branch, taken when there is an href and no inButton');
  assert.match(markup, /\{#if model\}\s*\{#if !href\}/, 'no link without a PR number or a safe url');
  const tag = a[1];
  assert.match(tag, /^<a \{href\} /);
  assert.match(tag, / target="_blank"/);
  assert.match(tag, / rel="noopener noreferrer"/);
  assert.match(tag, / onclick=\{\(e\) => e\.stopPropagation\(\)\}/, 'a jobs-table row does not open the drawer');
  assert.match(a[2], /^<Chip /, 'it wraps the Chip');
});

test('inside a button the chip is a span that opens the PR', () => {
  const branch = markup.slice(markup.indexOf('{:else}'));
  assert.doesNotMatch(branch, /<a[\s>]/);
  assert.match(branch, /<span data-gh-href=\{href\} class="inline-flex" onclick=\{open\}><Chip /);
  assert.match(branch, /svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions/);
  const open = chip.match(/function open\(e: MouseEvent\): void \{([\s\S]*?)\n {2}\}/);
  assert.ok(open);
  const body = open[1];
  const order = ['e.stopPropagation()', 'e.preventDefault()', "window.open(href, '_blank', 'noopener,noreferrer')"].map((s) => body.indexOf(s));
  assert.ok(order.every((i) => i >= 0), body);
  assert.deepEqual([...order].sort((x, y) => x - y), order, 'stop, prevent, then open');
});

test('a PR chip without a safe url is not a link', () => {
  const plain = markup.match(/\{#if !href\}(.*?)\n/);
  assert.ok(plain);
  assert.equal(plain[1].trim(), '<Chip tone={model.tone} text={model.text} icon="pull-request" />');
  assert.match(markup, /^<\/script>\s*\{#if model\}/, 'nothing without a PR number');
  for (const u of ['javascript:alert(1)', 'data:text/html,x', '//evil.example/pr/1', 'JaVaScRiPt:alert(1)', '', null, undefined]) {
    assert.equal(safeUrl(u), null, String(u));
  }
  assert.equal(safeUrl('https://github.com/acme/widgets/pull/12'), 'https://github.com/acme/widgets/pull/12');
});

test('a clickable chip shows it', () => {
  const chips = markup.match(/<Chip [^>]*\/>/g) ?? [];
  assert.equal(chips.length, 3);
  const [plain, ...clickable] = chips;
  assert.doesNotMatch(plain, /extra=|cursor-pointer|hover:underline/);
  for (const c of clickable) assert.match(c, /extra="cursor-pointer hover:underline"/, c);
});

test('no PR chip nests a link in a button or a link', () => {
  const card = read('components/JobCard.svelte');
  assert.doesNotMatch(card, /<a[\s>]/);
  const uses = card.match(/<PrChip [^>]*\/>/g) ?? [];
  assert.equal(uses.length, 2, 'root and member chips');
  for (const u of uses) assert.match(u, /\sinButton \/>$/, u);
  const repos = read('components/RepoSection.svelte');
  assert.doesNotMatch(repos, /<a[\s>]/);
  assert.match(repos, /\{#if row\.prNumber\}<PrChip pr=\{row\.pr\} \/>\{:else\}—\{\/if\}/);
});
