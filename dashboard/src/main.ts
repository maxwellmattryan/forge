// The dashboard's entry: mounts the Svelte app into the empty <body> that index.html ships.
import { mount } from 'svelte';
import App from './App.svelte';
import { followSystemTheme } from './lib/theme.ts';

followSystemTheme();

mount(App, { target: document.body });
