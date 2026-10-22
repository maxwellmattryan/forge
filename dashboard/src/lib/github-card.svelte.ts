// The GitHub hover card's one open card, its hover-intent timers and the answers fetched so far, like toast.svelte.ts
// for the toast: GitHubCard.svelte feeds it document events and renders it, and src/lib/github.ts holds the rules. The card
// describes any link to a github.com page, or an element carrying `data-gh-href` (a board card's PR chip).
import { fetchGitHubPreview } from './app.svelte.ts';
import { CLIENT_TTL, CLOSE_DELAY, OPEN_DELAY, cardKey, cardResult, leftBoth } from './github.ts';
import type { GitHubPreviewResponse } from './types.ts';

/** The card's element id: the link it describes points aria-describedby at it while it shows. */
export const CARD_ID = 'gh-card';

class CardState {
  /** The link (or `data-gh-href` element) the card describes; null while it is closed. */
  link = $state.raw<HTMLElement | null>(null);
  /** The page, as src/lib/github.ts previewable() spells it. */
  url = $state('');
  /** The answer; null while it loads. */
  result = $state.raw<GitHubPreviewResponse | null>(null);
}

export const ghCard = new CardState();

const answers = new Map<string, { at: number; value: Promise<GitHubPreviewResponse> }>();
let openTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
/** A link the pointer or focus rests on, waiting out OPEN_DELAY. */
let pending: HTMLElement | null = null;
/** The open link's own aria-describedby, put back when the card leaves it. */
let ownDescribedBy: string | null = null;

/** The answer for a page, fetched at most once per CLIENT_TTL. A failure is dropped once it lands, so the next hover asks again. */
function load(url: string): Promise<GitHubPreviewResponse> {
  const key = cardKey(url);
  const hit = answers.get(key);
  if (hit && Date.now() - hit.at < CLIENT_TTL) return hit.value;
  const value = fetchGitHubPreview(url).catch((e: unknown) => cardResult(e instanceof Error ? e : new Error(String(e))));
  answers.set(key, { at: Date.now(), value });
  value.then((r) => 'error' in r && answers.get(key)?.value === value && answers.delete(key));
  return value;
}

function release(): void {
  const a = ghCard.link;
  if (!a) return;
  if (ownDescribedBy) a.setAttribute('aria-describedby', ownDescribedBy);
  else a.removeAttribute('aria-describedby');
  ownDescribedBy = null;
}

function show(a: HTMLElement, url: string): void {
  pending = null;
  release();
  ghCard.link = a;
  ghCard.url = url;
  ghCard.result = null;
  ownDescribedBy = a.getAttribute('aria-describedby');
  a.setAttribute('aria-describedby', ownDescribedBy ? `${ownDescribedBy} ${CARD_ID}` : CARD_ID);
  load(url).then((r) => {
    if (ghCard.link === a && ghCard.url === url) ghCard.result = r;
  });
}

/**
 * The pointer or keyboard focus came to a GitHub link: fetch now, show after OPEN_DELAY. With a card already showing it
 * swaps at once, so running the pointer down a column of links reads each without waiting.
 */
export function linkIntent(a: HTMLElement, url: string): void {
  clearTimeout(closeTimer);
  if (ghCard.link === a || pending === a) return;
  clearTimeout(openTimer);
  void load(url);
  if (ghCard.link) return show(a, url);
  pending = a;
  openTimer = setTimeout(() => pending === a && show(a, url), OPEN_DELAY);
}

/** The pointer is over the card: it stays. */
export function holdCard(): void {
  clearTimeout(closeTimer);
}

/** A pointer left `from` for `to`: when it has left both the link and the card, a waiting card is dropped and an open one closes after CLOSE_DELAY. */
export function pointerLeft(from: Node, to: Node | null, card: Element | null): void {
  const link = ghCard.link ?? pending;
  if (!link || !(link.contains(from) || card?.contains(from)) || !leftBoth(to, link, card)) return;
  clearTimeout(openTimer);
  pending = null;
  if (!ghCard.link) return;
  clearTimeout(closeTimer);
  closeTimer = setTimeout(closeCard, CLOSE_DELAY);
}

/** Whether `el` is the link the card shows for or is waiting on. */
export const isCardLink = (el: Element | null): boolean => el !== null && (el === ghCard.link || el === pending);

export function closeCard(): void {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  pending = null;
  release();
  ghCard.link = null;
  ghCard.result = null;
}
