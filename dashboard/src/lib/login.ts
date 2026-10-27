// The page's half of the login link: `forge dash` prints `<origin>/?project=<name>#k=<key>`, and before the app
// mounts the page takes the key from the fragment, clears it from the address bar and history entry, then trades it
// once for the server's HttpOnly login cookie (POST /api/session). After that every same-origin fetch and
// EventSource carries the cookie, and no dashboard code ever holds a token. A 401 with SIGNED_OUT_ERROR reads as
// "this browser is not signed in", not as a lost server. A login link pasted into a tab that is already open changes
// only the fragment, so watchLoginFragment takes the key from that tab too.
import { SIGNED_OUT_ERROR, type PostSessionBody } from './types.ts';

/** The connection banners' text for a signed-out browser (a new profile, a restarted server, or a localhost URL). */
export const SIGNED_OUT_MESSAGE = 'This browser is not signed in to the Forge dashboard. Run `forge dash url` in a terminal and open the link it prints.';

/** What consumeLoginFragment reads and calls: `window` in the page, plain objects in tests. */
export interface LoginEnv {
  location: { hash: string; pathname: string; search: string };
  history: { replaceState(data: unknown, unused: string, url?: string | null): void };
  fetch: typeof fetch;
  /** How long the exchange may take before the boot goes on without it; EXCHANGE_TIMEOUT_MS when absent. */
  timeoutMs?: number;
}

const PREFIX = '#k=';

/** The server is on loopback, so an exchange that takes longer than this is stuck, and the page must still mount. */
export const EXCHANGE_TIMEOUT_MS = 5000;

/**
 * When the hash is `#k=<key>`: clears the fragment at once (before any request, so a failed exchange leaves no key in
 * the address bar or the current history entry), then POSTs the key to /api/session, a machine path outside any
 * project. Any other hash posts nothing. Resolves once the exchange settles, or after `timeoutMs` if it stalls, and
 * never rejects: the app mounts either way, and a failed exchange shows as the signed-out banner on its first poll.
 */
export async function consumeLoginFragment({ location, history, fetch: fetchImpl, timeoutMs = EXCHANGE_TIMEOUT_MS }: LoginEnv): Promise<void> {
  if (!location.hash.startsWith(PREFIX)) return;
  const k = location.hash.slice(PREFIX.length);
  history.replaceState(null, '', location.pathname + location.search);
  try {
    await fetchImpl('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ k } satisfies PostSessionBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // The banner tells the person what to do; the boot never stops here.
  }
}

/** What watchLoginFragment needs of `window`: the exchange's environment, the reload and the hashchange hook. */
export interface LoginWindow extends LoginEnv {
  location: LoginEnv['location'] & { reload(): void };
  addEventListener(type: 'hashchange', listener: (e: Event) => void): void;
}

/**
 * Signs in a page that is already open when a login link is pasted into its address bar: a link that differs from the
 * open page only in its fragment (always so for `<origin>/#k=<key>`) fires `hashchange` and runs no boot code. On a
 * `#k=` hash this trades the key as the boot does, then reloads so the page starts signed in. It stops the event, so
 * the router (registered when the app mounts, after this) never reads the key as an unknown route and rewrites it to
 * the Overview. Register it before the app mounts.
 */
export function watchLoginFragment(win: LoginWindow): void {
  win.addEventListener('hashchange', (e) => {
    if (!win.location.hash.startsWith(PREFIX)) return;
    e.stopImmediatePropagation();
    void consumeLoginFragment(win).then(() => win.location.reload());
  });
}

/** Whether an error text is the server's 401 for a request without the login cookie. */
export const isSignedOutError = (text: string): boolean => text === SIGNED_OUT_ERROR;

/** A failed poll's connection banner: the signed-out message for the server's 401, else `lost`. */
export const connectionBanner = (text: string, lost: string): string => (isSignedOutError(text) ? SIGNED_OUT_MESSAGE : lost);
