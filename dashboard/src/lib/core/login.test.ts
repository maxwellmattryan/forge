// The page's login: the `#k=` fragment is cleared before the one POST /api/session that trades it for the cookie,
// any other hash posts nothing, a link pasted into an open tab signs it in too, a stalled exchange does not hold the
// page back, and a 401 reads as signed out rather than a lost connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SIGNED_OUT_MESSAGE, connectionBanner, consumeLoginFragment, isSignedOutError, watchLoginFragment } from './login.ts';
import type { LoginWindow } from './login.ts';
import { setProject } from './project.ts';
import { SIGNED_OUT_ERROR } from './types.ts';

/**
 * A page at `hash`, recording each history, fetch and reload call in order; replaceState rewrites the location as a
 * browser does. The exchange succeeds, fails (the fetch throws) or stalls (the fetch settles only when its signal aborts).
 */
function page(hash: string, exchange: 'ok' | 'fails' | 'stalls' = 'ok') {
  const calls: { kind: 'replace' | 'fetch' | 'reload'; args: unknown[] }[] = [];
  let reloaded!: () => void;
  const reload = new Promise<void>((resolve) => (reloaded = resolve));
  const location = {
    hash,
    pathname: '/',
    search: '?project=a',
    reload() {
      calls.push({ kind: 'reload', args: [] });
      reloaded();
    },
  };
  const env = {
    location,
    history: {
      replaceState(...args: [unknown, string, (string | URL | null)?]) {
        calls.push({ kind: 'replace', args });
        location.hash = '';
      },
    },
    fetch: (async (...args: unknown[]) => {
      calls.push({ kind: 'fetch', args });
      if (exchange === 'fails') throw new TypeError('Failed to fetch');
      if (exchange === 'stalls') {
        // AbortSignal.timeout's timer does not keep the process alive; this one does, until the signal fires.
        const hold = setInterval(() => {}, 1000);
        const { signal } = args[1] as RequestInit;
        return new Promise<Response>((_, reject) =>
          signal!.addEventListener('abort', () => {
            clearInterval(hold);
            reject(signal!.reason);
          }),
        );
      }
      return new Response('{"ok":true}');
    }) as typeof fetch,
  };
  return { env, calls, reload };
}

test('the page reads the login fragment once and clears it', async () => {
  // A project selected for the page must not prefix the machine route.
  setProject('a');
  const key = 'f'.repeat(32);
  const p = page(`#k=${key}`);
  await consumeLoginFragment(p.env);
  assert.deepEqual(
    p.calls.map((c) => c.kind),
    ['replace', 'fetch'],
    'the fragment is cleared before the request',
  );
  assert.deepEqual(p.calls[0]!.args, [null, '', '/?project=a']);
  const [url, init] = p.calls[1]!.args as [string, RequestInit];
  assert.equal(url, '/api/session');
  const { signal, ...rest } = init;
  assert.deepEqual(rest, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ k: key }) });
  assert.ok(signal instanceof AbortSignal && !signal.aborted, 'the exchange carries a timeout that has not fired');

  // The hash is empty now: a second call does nothing.
  await consumeLoginFragment(p.env);
  assert.equal(p.calls.length, 2);

  for (const hash of ['#/p/a/pipeline', '#k', '']) {
    const other = page(hash);
    await consumeLoginFragment(other.env);
    assert.deepEqual(other.calls, [], hash);
  }

  const failing = page(`#k=${key}`, 'fails');
  await assert.doesNotReject(consumeLoginFragment(failing.env), 'a failed exchange still lets the app mount');
  assert.deepEqual(
    failing.calls.map((c) => c.kind),
    ['replace', 'fetch'],
  );
  setProject(null);
});

test('a stalled exchange gives up, so the app still mounts', async () => {
  const stalled = page(`#k=${'a'.repeat(32)}`, 'stalls');
  await assert.doesNotReject(consumeLoginFragment({ ...stalled.env, timeoutMs: 10 }), 'the timeout ends the wait');
  assert.deepEqual(
    stalled.calls.map((c) => c.kind),
    ['replace', 'fetch'],
  );
});

/**
 * An open tab as a browser keeps it: its hashchange listeners run in registration order until one stops the event.
 * watchLoginFragment registers first (before mount), then `router` stands in for App's own handler.
 */
function openTab(exchange: 'ok' | 'fails' = 'ok') {
  const p = page('#/overview', exchange);
  const listeners: ((e: Event) => void)[] = [];
  const win: LoginWindow = { ...p.env, addEventListener: (_type, listener) => void listeners.push(listener) };
  watchLoginFragment(win);
  const routed: string[] = [];
  listeners.push(() => void routed.push(p.env.location.hash));
  /** Navigates the tab to `hash` without a page load, as pasting a link that differs only in its fragment does. */
  const navigate = (hash: string): void => {
    p.env.location.hash = hash;
    let stopped = false;
    const e = { stopImmediatePropagation: () => void (stopped = true) } as Event;
    for (const listener of listeners) {
      if (stopped) break;
      listener(e);
    }
  };
  return { ...p, navigate, routed };
}

test('a login link pasted into an open tab signs it in and reloads before the router sees the key', async () => {
  const key = 'c'.repeat(32);
  const tab = openTab();
  tab.navigate(`#k=${key}`);
  // Synchronously: the key is gone from the address bar and the router never ran on it.
  assert.deepEqual(
    tab.calls.map((c) => c.kind),
    ['replace', 'fetch'],
  );
  assert.deepEqual(tab.routed, []);
  const [url, init] = tab.calls[1]!.args as [string, RequestInit];
  assert.equal(url, '/api/session');
  assert.equal(init.body, JSON.stringify({ k: key }));
  // Once the cookie is set the page reloads signed in.
  await tab.reload;
  assert.deepEqual(
    tab.calls.map((c) => c.kind),
    ['replace', 'fetch', 'reload'],
  );

  // A wrong key or a stopped server still ends in the reload: the reloaded page shows the signed-out banner.
  const failing = openTab('fails');
  failing.navigate(`#k=${key}`);
  await failing.reload;
  assert.deepEqual(
    failing.calls.map((c) => c.kind),
    ['replace', 'fetch', 'reload'],
  );
});

test('a hash change that is not a login link reaches the router untouched', () => {
  const tab = openTab();
  for (const hash of ['#/p/a/pipeline', '#k', '', '#/machine']) tab.navigate(hash);
  assert.deepEqual(tab.routed, ['#/p/a/pipeline', '#k', '', '#/machine']);
  assert.deepEqual(tab.calls, []);
});

test('a 401 reads as signed out, not a lost connection', () => {
  assert.equal(isSignedOutError(SIGNED_OUT_ERROR), true);
  for (const text of ['no registered project "x"', 'Lost connection', '']) {
    assert.equal(isSignedOutError(text), false, text);
    assert.equal(connectionBanner(text, 'lost'), 'lost', text);
  }
  assert.equal(connectionBanner(SIGNED_OUT_ERROR, 'lost'), SIGNED_OUT_MESSAGE);
});
