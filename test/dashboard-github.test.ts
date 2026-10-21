// The GitHub hover card's pure rules (dashboard/src/lib/github.ts): which links get a card, agreeing with the server's
// parse; where it sits; how a preview's state reads; and which layer Escape closes first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_WIDTH, cardKey, cardResult, checksTone, countShort, leftBoth, placeCard, previewable, reviewTone, stateTone } from '../dashboard/src/lib/github.ts';
import { shellEscape } from '../dashboard/src/lib/command.ts';
import { parseGitHubUrl } from '../lib/github-preview.ts';
import type { GitHubPreview } from '../dashboard/src/lib/types.ts';

const URLS = [
  'https://github.com/acme/widgets',
  'https://github.com/acme/widgets/',
  'https://www.github.com/Acme/Widgets.git',
  'https://github.com/acme/widgets/pull/12',
  'https://github.com/acme/widgets/pull/12/files?w=1#diff',
  'https://github.com/acme/widgets/issues/7#issuecomment-1',
  'https://github.com/acme/widgets/commit/ABCDEF1234',
  'https://github.com/acme/widgets/tree/main',
  'https://github.com/acme/widgets/pull/0',
  'https://github.com/settings/tokens',
  'https://github.com/acme',
  'http://github.com/acme/widgets',
  'https://user@github.com/acme/widgets',
  'https://github.com.evil.example/acme/widgets',
  'https://gist.github.com/acme/abc',
  '#/pipeline',
  '/api/state',
  'javascript:alert(1)',
];

test('previewable agrees with the server on which links get a card', () => {
  for (const u of URLS) assert.equal(previewable(u) !== null, parseGitHubUrl(u) !== null, u);
});

test('previewable folds sub-pages onto their page and the cache key ignores case', () => {
  assert.equal(previewable('https://github.com/acme/widgets/pull/12/files#diff'), 'https://github.com/acme/widgets/pull/12');
  assert.equal(previewable('https://www.github.com/Acme/Widgets.git/'), 'https://github.com/Acme/Widgets');
  assert.equal(previewable('https://github.com/acme/widgets/commit/ABCDEF1'), 'https://github.com/acme/widgets/commit/abcdef1');
  assert.equal(cardKey('https://github.com/Acme/Widgets'), cardKey('https://github.com/acme/widgets'));
});

test('placeCard: below the link, above when it does not fit, always inside the gutters', () => {
  const rect = { left: 100, top: 300, bottom: 320 };
  assert.deepEqual(placeCard({ rect, viewportWidth: 1200, viewportHeight: 800, height: 200 }), { top: 326, left: 100, width: CARD_WIDTH, above: false });
  const low = { left: 100, top: 700, bottom: 720 };
  assert.deepEqual(placeCard({ rect: low, viewportWidth: 1200, viewportHeight: 800, height: 200 }), { top: 494, left: 100, width: CARD_WIDTH, above: true });
  // Too tall for either side: it stays where there is more room, and never above the top gutter.
  const mid = placeCard({ rect: { left: 0, top: 380, bottom: 400 }, viewportWidth: 1200, viewportHeight: 800, height: 900 });
  assert.equal(mid.above, false);
  assert.ok(placeCard({ rect: { left: 0, top: 600, bottom: 620 }, viewportWidth: 1200, viewportHeight: 800, height: 900 }).top >= 16);
  // Right edge and phone width.
  assert.equal(placeCard({ rect: { left: 1150, top: 0, bottom: 20 }, viewportWidth: 1200, viewportHeight: 800, height: 0 }).left, 1200 - 16 - CARD_WIDTH);
  assert.deepEqual(placeCard({ rect: { left: 200, top: 0, bottom: 20 }, viewportWidth: 375, viewportHeight: 800, height: 0 }), { top: 26, left: 16, width: 343, above: false });
  // Before the first measure (height 0) it opens below.
  assert.equal(placeCard({ rect: low, viewportWidth: 1200, viewportHeight: 800, height: 0 }).above, false);
});

test('leftBoth: moving between the link and its card is not leaving', () => {
  const link = { contains: (n: unknown) => n === 'link' || n === 'linkChild' } as unknown as Element;
  const card = { contains: (n: unknown) => n === 'card' } as unknown as Element;
  assert.equal(leftBoth('linkChild' as unknown as Node, link, card), false);
  assert.equal(leftBoth('card' as unknown as Node, link, card), false);
  assert.equal(leftBoth('elsewhere' as unknown as Node, link, card), true);
  assert.equal(leftBoth(null, link, card), true, 'out of the window');
});

test('tones follow the board PR chip', () => {
  const pull = (state: string) => ({ kind: 'pull', state }) as unknown as GitHubPreview;
  const issue = (state: string) => ({ kind: 'issue', state }) as unknown as GitHubPreview;
  assert.deepEqual(['open', 'draft', 'merged', 'closed'].map((s) => stateTone(pull(s))), ['info', 'muted', 'ok', 'muted']);
  assert.deepEqual(['open', 'closed', 'not_planned', 'duplicate'].map((s) => stateTone(issue(s))), ['info', 'ok', 'muted', 'muted']);
  assert.equal(stateTone({ kind: 'repo', archived: true } as unknown as GitHubPreview), 'warn');
  assert.equal(stateTone({ kind: 'repo', archived: false } as unknown as GitHubPreview), null);
  assert.deepEqual([checksTone('success'), checksTone('failure'), checksTone('pending')], ['ok', 'bad', 'warn']);
  assert.deepEqual([reviewTone('approved'), reviewTone('changes_requested'), reviewTone('review_required')], ['ok', 'bad', 'warn']);
});

test('countShort and cardResult', () => {
  assert.deepEqual([0, 999, 1000, 1250, 99_960, 123_456].map(countShort), ['0', '999', '1k', '1.3k', '100k', '123k']);
  assert.deepEqual(cardResult(new Error('offline')), { error: 'failed', message: 'offline' });
  assert.deepEqual(cardResult({ error: 'not_found', message: 'x' }), { error: 'not_found', message: 'x' });
});

test('Escape closes the hover card before any other layer', () => {
  assert.equal(shellEscape({ card: true, command: true, settings: true, popover: true, drawer: true }), 'card');
  assert.equal(shellEscape({ card: false, command: false, settings: false, popover: false, drawer: true }), 'drawer');
});
