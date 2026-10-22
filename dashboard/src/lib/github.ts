// GitHub hover cards' pure rules: which links get a card, when it opens and closes, where it sits and how a preview's
// state reads. The server parses the URL again (lib/github-preview.ts); this side only decides whether to ask.
import type { GitHubChecks, GitHubPreview, GitHubPreviewResponse } from './types.ts';
import type { Tone } from './job-state.ts';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const NUMBER = /^[1-9]\d{0,9}$/;
const SHA = /^[0-9a-f]{7,40}$/i;
// GitHub's own pages, not owners: lib/github-preview.ts keeps the same list.
const RESERVED = new Set(['about', 'account', 'apps', 'codespaces', 'collections', 'contact', 'customer-stories', 'dashboard', 'enterprise', 'events', 'explore', 'features', 'issues', 'login', 'logout', 'marketplace', 'new', 'notifications', 'organizations', 'orgs', 'pricing', 'pulls', 'search', 'security', 'settings', 'site', 'sponsors', 'stars', 'team', 'topics', 'trending', 'users']);

/** Hover intent: a pointer rests this long before the card opens, and may wander off this long before it closes. */
export const OPEN_DELAY = 400;
export const CLOSE_DELAY = 250;
/** How long the dashboard reuses an answer before asking the server again (which has its own cache). */
export const CLIENT_TTL = 60_000;
export const CARD_WIDTH = 360;

/**
 * The page a link points at, as `https://github.com/owner/repo[/pull/N|/issues/N|/commit/sha]`, or null when it is not a
 * repository, pull request, issue or commit on github.com. Sub-pages (`/files`, `#issuecomment-1`) fold onto their page.
 */
export function previewable(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') || u.port || u.username || u.password) return null;
  const [owner, rawName, section, id] = u.pathname.split('/').filter(Boolean);
  if (!owner || !rawName || !OWNER.test(owner) || RESERVED.has(owner.toLowerCase())) return null;
  const name = rawName.replace(/\.git$/i, '');
  if (!NAME.test(name) || name === '.' || name === '..') return null;
  const base = `https://github.com/${owner}/${name}`;
  if (section === undefined) return base;
  if ((section === 'pull' || section === 'issues') && id && NUMBER.test(id) && Number(id) <= 2 ** 31 - 1) return `${base}/${section}/${id}`;
  if (section === 'commit' && id && SHA.test(id)) return `${base}/commit/${id.toLowerCase()}`;
  return null;
}

/** The card's cache key: GitHub owners and repos are case-insensitive. */
export const cardKey = (url: string): string => url.toLowerCase();

export interface PlaceCardInput {
  /** The link's box, from getBoundingClientRect. */
  rect: { left: number; top: number; bottom: number };
  viewportWidth: number;
  viewportHeight: number;
  /** The card's rendered height; 0 before the first measure. */
  height: number;
  width?: number;
  gap?: number;
  gutter?: number;
}

/**
 * Where the card sits: below the link, left edges meeting, kept `gutter` px inside the viewport; above it when it does
 * not fit below and there is more room above.
 */
export function placeCard({ rect, viewportWidth, viewportHeight, height, width = CARD_WIDTH, gap = 6, gutter = 16 }: PlaceCardInput): { top: number; left: number; width: number; above: boolean } {
  const w = Math.max(0, Math.min(width, viewportWidth - 2 * gutter));
  const left = Math.min(Math.max(rect.left, gutter), Math.max(gutter, viewportWidth - gutter - w));
  const below = viewportHeight - gutter - (rect.bottom + gap);
  const aboveRoom = rect.top - gap - gutter;
  const above = height > below && aboveRoom > below;
  const top = above ? Math.max(gutter, rect.top - gap - height) : rect.bottom + gap;
  return { top, left, width: w, above };
}

/** Whether a pointer moving from `from` to `to` has left the link and its card (so the close timer starts). */
export const leftBoth = (to: Node | null, link: Element | null, card: Element | null): boolean => !to || (!link?.contains(to) && !card?.contains(to));

/** The state chip's tone, as the board's PR chip colours a PR: merged ok, open info, closed and draft muted. */
export function stateTone(p: GitHubPreview): Tone | null {
  switch (p.kind) {
    case 'pull':
      return p.state === 'merged' ? 'ok' : p.state === 'open' ? 'info' : 'muted';
    case 'issue':
      return p.state === 'open' ? 'info' : p.state === 'closed' ? 'ok' : 'muted';
    case 'repo':
      return p.archived ? 'warn' : null;
    case 'commit':
      return null;
  }
}

export const checksTone = (c: GitHubChecks): Tone => (c === 'success' ? 'ok' : c === 'failure' ? 'bad' : 'warn');

export const reviewTone = (r: 'approved' | 'changes_requested' | 'review_required'): Tone => (r === 'approved' ? 'ok' : r === 'changes_requested' ? 'bad' : 'warn');

/** A count in a card's facts line: 1234 → 1.2k. */
export function countShort(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k < 100 ? `${k.toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(k)}k`;
}

/** What the card shows for an answer: the preview, or the error the server named; a thrown fetch reads as `failed`. */
export function cardResult(r: GitHubPreviewResponse | Error): GitHubPreviewResponse {
  if (r instanceof Error) return { error: 'failed', message: r.message };
  return r;
}
