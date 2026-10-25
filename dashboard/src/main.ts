// The dashboard's entry: turns a `?project=<name>` link into its hash route, then mounts the Svelte app into the
// empty <body> that index.html ships. The route selects the project (App's first route() call).
import { mount } from 'svelte';
import App from './App.svelte';
import { entryRedirect } from './lib/routes.ts';
import { followSystemTheme } from './lib/theme.ts';

followSystemTheme();
// `forge dash`, the README and notify webhooks still print `/?project=<name>#/<view>`: before the app reads the hash.
const entry = entryRedirect(location.search, location.hash);
if (entry !== null) history.replaceState(null, '', entry);

mount(App, { target: document.body });
