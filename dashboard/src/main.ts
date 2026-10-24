// The dashboard's entry: reads the page's project from `?project=`, then mounts the Svelte app into the
// empty <body> that index.html ships.
import { mount } from 'svelte';
import App from './App.svelte';
import { projectFromSearch, setProject } from './lib/project.ts';
import { followSystemTheme } from './lib/theme.ts';

followSystemTheme();
// Before the app mounts, so its first request already names the project.
setProject(projectFromSearch(location.search));

mount(App, { target: document.body });
