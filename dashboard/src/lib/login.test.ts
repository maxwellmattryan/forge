// The page's login: the `#k=` fragment is cleared before the one POST /api/session that trades it for the cookie,
// any other hash posts nothing, and a 401 reads as signed out rather than a lost connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SIGNED_OUT_MESSAGE, connectionBanner, consumeLoginFragment, isSignedOutError } from './login.ts';
import { setProject } from './project.ts';
import { SIGNED_OUT_ERROR } from './types.ts';

/** A page at `hash`, recording each history and fetch call in order; replaceState rewrites the location as a browser does. */
function page(hash: string, fetchFails = false) {
  const calls: { kind: 'replace' | 'fetch'; args: unknown[] }[] = [];
  const location = { hash, pathname: '/', search: '?project=a' };
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
      if (fetchFails) throw new TypeError('Failed to fetch');
      return new Response('{"ok":true}');
    }) as typeof fetch,
  };
  return { env, calls };
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
  assert.deepEqual(init, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ k: key }) });

  // The hash is empty now: a second call does nothing.
  await consumeLoginFragment(p.env);
  assert.equal(p.calls.length, 2);

  for (const hash of ['#/p/a/pipeline', '#k', '']) {
    const other = page(hash);
    await consumeLoginFragment(other.env);
    assert.deepEqual(other.calls, [], hash);
  }

  const failing = page(`#k=${key}`, true);
  await assert.doesNotReject(consumeLoginFragment(failing.env), 'a failed exchange still lets the app mount');
  assert.deepEqual(
    failing.calls.map((c) => c.kind),
    ['replace', 'fetch'],
  );
  setProject(null);
});

test('a 401 reads as signed out, not a lost connection', () => {
  assert.equal(isSignedOutError(SIGNED_OUT_ERROR), true);
  for (const text of ['no registered project "x"', 'Lost connection', '']) {
    assert.equal(isSignedOutError(text), false, text);
    assert.equal(connectionBanner(text, 'lost'), 'lost', text);
  }
  assert.equal(connectionBanner(SIGNED_OUT_ERROR, 'lost'), SIGNED_OUT_MESSAGE);
});
