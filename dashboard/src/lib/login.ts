// The page's half of the login link: `forge dash` prints `<origin>/?project=<name>#k=<key>`, and before the app
// mounts the page takes the key from the fragment, clears it from the address bar and history entry, then trades it
// once for the server's HttpOnly login cookie (POST /api/session). After that every same-origin fetch and
// EventSource carries the cookie, and no dashboard code ever holds a token. A 401 with SIGNED_OUT_ERROR reads as
// "this browser is not signed in", not as a lost server.
import { SIGNED_OUT_ERROR, type PostSessionBody } from './types.ts';

/** The connection banners' text for a signed-out browser (a new profile, a restarted server, or a localhost URL). */
export const SIGNED_OUT_MESSAGE = 'This browser is not signed in to the Forge dashboard. Run `forge dash url` in a terminal and open the link it prints.';

/** What consumeLoginFragment reads and calls: `window` in the page, plain objects in tests. */
export interface LoginEnv {
  location: Pick<Location, 'hash' | 'pathname' | 'search'>;
  history: Pick<History, 'replaceState'>;
  fetch: typeof fetch;
}

const PREFIX = '#k=';

/**
 * When the hash is `#k=<key>`: clears the fragment at once (before any request, so a failed exchange leaves no key in
 * the address bar or the current history entry), then POSTs the key to /api/session, a machine path outside any
 * project. Any other hash posts nothing. Resolves once the exchange settles and never rejects: the app mounts either
 * way, and a failed exchange shows as the signed-out banner on its first poll.
 */
export async function consumeLoginFragment({ location, history, fetch: fetchImpl }: LoginEnv): Promise<void> {
  if (!location.hash.startsWith(PREFIX)) return;
  const k = location.hash.slice(PREFIX.length);
  history.replaceState(null, '', location.pathname + location.search);
  try {
    await fetchImpl('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ k } satisfies PostSessionBody) });
  } catch {
    // The banner tells the person what to do; the boot never stops here.
  }
}

/** Whether an error text is the server's 401 for a request without the login cookie. */
export const isSignedOutError = (text: string): boolean => text === SIGNED_OUT_ERROR;

/** A failed poll's connection banner: the signed-out message for the server's 401, else `lost`. */
export const connectionBanner = (text: string, lost: string): string => (isSignedOutError(text) ? SIGNED_OUT_MESSAGE : lost);
