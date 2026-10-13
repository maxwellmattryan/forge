<!-- The dashboard shell: sidebar, phone nav, banners, the active view, the daemon bar, the drawer and the toast. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import Banner from './components/Banner.svelte';
  import DaemonBar from './components/DaemonBar.svelte';
  import Drawer from './components/Drawer.svelte';
  import Icon from './components/Icon.svelte';
  import Nav from './components/Nav.svelte';
  import Toast from './components/Toast.svelte';
  import Pipeline from './views/Pipeline.svelte';
  import Inbox from './views/Inbox.svelte';
  import Backlog from './views/Backlog.svelte';
  import Agents from './views/Agents.svelte';
  import Analytics from './views/Analytics.svelte';
  import Evals from './views/Evals.svelte';
  import { S, closeDrawer, loadView, refresh, route } from './lib/app.svelte.ts';
  import { pref } from './lib/prefs.ts';
  import { activeSessions } from './lib/view.ts';

  let dark = $state(document.documentElement.dataset.theme === 'dark');
  const sessions = $derived(activeSessions(S.data?.jobs ?? [], Date.now()));

  $effect(() => {
    document.title = S.data?.repo?.name ? `Forge · ${S.data.repo.name}` : 'Forge';
  });

  function toggleTheme(): void {
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    pref.set('theme', next);
    dark = next === 'dark';
  }

  onMount(() => {
    route();
    refresh();
    const poll = setInterval(() => document.visibilityState === 'visible' && refresh(), 2000);
    const views = setInterval(() => document.visibilityState === 'visible' && ['analytics', 'evals', 'agents'].includes(S.view) && loadView(), 15000);
    return () => {
      clearInterval(poll);
      clearInterval(views);
    };
  });
</script>

<svelte:window onhashchange={route} onkeydown={(e) => e.key === 'Escape' && closeDrawer()} />

<div class="flex min-h-screen">
  <aside id="sidebar" class="hidden md:flex w-56 shrink-0 flex-col border-r border-line bg-panel px-3 py-4 gap-1 sticky top-0 h-screen">
    <div class="flex items-center gap-2.5 px-2 pb-3">
      <img src="/forge.png" alt="" class="size-9 rounded-lg" />
      <div class="min-w-0">
        <div class="text-[15px] font-semibold leading-4 tracking-tight">Forge</div>
        <div class="text-[10px] uppercase tracking-[0.12em] text-muted">software factory</div>
      </div>
    </div>
    <div class="brand-rule mx-2 mb-3"></div>
    <div class="px-3 pb-3 text-[11px] text-muted truncate">repo <span id="repo-name" class="font-mono text-fg">{S.data?.repo?.name ?? ''}</span></div>
    <nav id="nav" class="flex flex-col gap-0.5"><Nav /></nav>
    <div class="mt-auto flex flex-col gap-1 border-t border-line pt-3 text-xs text-muted">
      <div id="footer-sessions" class="px-3"><span class="inline-block size-1.5 rounded-full {sessions ? 'bg-ok' : 'bg-muted'} mr-1.5 align-middle"></span>{sessions} session{sessions === 1 ? '' : 's'} active</div>
      <button id="theme-toggle" class="nav-item" onclick={toggleTheme}><span class="flex items-center gap-2"><Icon name={dark ? 'sun' : 'moon'} />{dark ? 'Light' : 'Dark'} theme</span></button>
      <div id="footer-version" class="px-3 text-[10px]">{S.data ? `Forge v${S.data.forgeVersion} · api ${S.data.apiVersion}` : ''}</div>
    </div>
  </aside>
  <main class="flex-1 min-w-0">
    <header class="md:hidden flex items-center gap-2 border-b border-line bg-panel px-4 py-3 overflow-x-auto" id="mobile-nav"><Nav mobile /></header>
    <DaemonBar />
    <div id="view" class="mx-auto max-w-[1400px] px-4 md:px-8 pt-4 pb-6">
      {#if !S.data}
        {#if S.error}<Banner msg={S.error} />{:else}<div class="text-muted text-sm">Loading…</div>{/if}
      {:else}
        {#if S.error}<Banner msg={S.error} />{/if}
        {#if !S.data.initialized}<Banner msg="This repo has no .forge/config.yml yet. Run /forge init." />{/if}
        {#if S.view === 'pipeline'}<Pipeline data={S.data} />
        {:else if S.view === 'inbox'}<Inbox data={S.data} />
        {:else if S.view === 'backlog'}<Backlog />
        {:else if S.view === 'agents'}<Agents data={S.data} />
        {:else if S.view === 'analytics'}<Analytics data={S.data} />
        {:else}<Evals data={S.data} />{/if}
      {/if}
    </div>
  </main>
</div>
<Drawer />
<Toast />
