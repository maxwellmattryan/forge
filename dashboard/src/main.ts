// The dashboard's entry: signs the browser in from a login link's `#k=` fragment, turns a `?project=<name>` link into
// its hash route, then mounts the Svelte app into the empty <body> that index.html ships. The route selects the
// project (App's first route() call).
import { mount } from 'svelte';
import App from './App.svelte';
import { consumeLoginFragment } from './lib/login.ts';
import { entryRedirect } from './lib/routes.ts';
import { followSystemTheme } from './lib/theme.ts';

followSystemTheme();
// First, so the key leaves the address bar before anything else runs; the exchange itself settles below.
const signedIn = consumeLoginFragment(window);
// `forge dash`, the README and notify webhooks still print `/?project=<name>#/<view>`: before the app reads the hash.
const entry = entryRedirect(location.search, location.hash);
if (entry !== null) history.replaceState(null, '', entry);

// Once the cookie is set (or the exchange failed), so the app's first requests carry it.
void signedIn.then(() => mount(App, { target: document.body }));
