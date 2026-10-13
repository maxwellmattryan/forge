<!-- The dashboard shell: sidebar, phone nav, banners, the active view, the daemon bar, the drawer and the toast. -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Banner from './components/Banner.svelte';
  import DaemonBar from './components/DaemonBar.svelte';
  import Drawer from './components/Drawer.svelte';
  import Icon from './components/Icon.svelte';
  import Nav from './components/Nav.svelte';
  import Settings from './components/Settings.svelte';
  import Toast from './components/Toast.svelte';
  import Pipeline from './views/Pipeline.svelte';
  import Inbox from './views/Inbox.svelte';
  import Backlog from './views/Backlog.svelte';
  import Agents from './views/Agents.svelte';
  import Analytics from './views/Analytics.svelte';
  import Evals from './views/Evals.svelte';
  import { S, closeDrawer, loadView, refresh, route } from './lib/app.svelte.ts';
  import { activeSessions } from './lib/view.ts';
  import { t } from './lib/locale.ts';
  import { settingsKey } from './lib/settings.ts';
  import { pref } from './lib/prefs.ts';

  let settingsOpen = $state(false);
  let settings = $state<ReturnType<typeof Settings>>();
  // Focus goes back here when the modal closes.
  let opener: HTMLElement | null = null;
  const sessions = $derived(activeSessions(S.data?.jobs ?? [], Date.now()));

  $effect(() => {
    document.title = S.data?.repo?.name ? $t('app.titleRepo', { repo: S.data.repo.name }) : $t('app.title');
  });

  function openSettings(): void {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    settingsOpen = true;
  }

  function closeSettings(): void {
    settingsOpen = false;
    const back = opener;
    opener = null;
    tick().then(() => back?.focus());
  }

  function onKey(e: KeyboardEvent): void {
    const target = e.target instanceof HTMLElement ? e.target : null;
    const action = settingsKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, targetTag: target?.tagName ?? '', editable: target?.isContentEditable ?? false, open: settingsOpen, shortcut: pref.get('settingsShortcut', 'on') !== 'off', repeat: e.repeat, composing: e.isComposing });
    if (action === 'open') {
      e.preventDefault();
      openSettings();
    } else if (action === 'close') {
      e.preventDefault();
      settings?.requestClose();
    } else if (!settingsOpen && e.key === 'Escape') closeDrawer();
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

<svelte:window onhashchange={route} onkeydown={onKey} />

<div class="flex min-h-screen" inert={settingsOpen}>
  <aside id="sidebar" class="hidden md:flex w-56 shrink-0 flex-col border-r border-line bg-panel px-3 py-4 gap-1 sticky top-0 h-screen">
    <div class="flex items-center gap-2.5 px-2 pb-3">
      <img src="/forge.png" alt="" class="size-9 rounded-lg" />
      <div class="min-w-0">
        <div class="text-[15px] font-semibold leading-4 tracking-tight">{$t('app.brand')}</div>
        <div class="text-[10px] uppercase tracking-[0.12em] text-muted">{$t('app.tagline')}</div>
      </div>
    </div>
    <div class="brand-rule mx-2 mb-3"></div>
    <div class="px-3 pb-3 text-[11px] text-muted truncate">{$t('app.repo')} <span id="repo-name" class="font-mono text-fg">{S.data?.repo?.name ?? ''}</span></div>
    <nav id="nav" class="flex flex-col gap-0.5"><Nav /></nav>
    <div class="mt-auto flex flex-col gap-1 border-t border-line pt-3 text-xs text-muted">
      <div id="footer-sessions" class="px-3"><span class="inline-block size-1.5 rounded-full {sessions ? 'bg-ok' : 'bg-muted'} mr-1.5 align-middle"></span>{$t('app.sessions', { count: sessions })}</div>
      <button id="settings-open" class="nav-item" aria-haspopup="dialog" aria-keyshortcuts="," onclick={openSettings}><span class="flex items-center gap-2"><Icon name="settings" />{$t('settings.open')}</span></button>
      <div id="footer-version" class="px-3 text-[10px]">{S.data ? $t('app.version', { version: S.data.forgeVersion, api: S.data.apiVersion }) : ''}</div>
    </div>
  </aside>
  <main class="flex-1 min-w-0">
    <!-- The gear stays outside the scrolling nav, so it is always on screen. -->
    <header class="md:hidden flex items-center border-b border-line bg-panel">
      <div class="flex flex-1 min-w-0 items-center gap-2 px-4 py-3 overflow-x-auto" id="mobile-nav"><Nav mobile /></div>
      <button id="settings-open-mobile" class="nav-item shrink-0 mr-2 min-h-11 min-w-11 justify-center" aria-label={$t('settings.open')} aria-haspopup="dialog" onclick={openSettings}><Icon name="settings" /></button>
    </header>
    <DaemonBar />
    <div id="view" class="mx-auto max-w-[1400px] px-4 md:px-8 pt-4 pb-6">
      {#if !S.data}
        {#if S.error}<Banner msg={S.error} />{:else}<div class="text-muted text-sm">{$t('common.loading')}</div>{/if}
      {:else}
        {#if S.error}<Banner msg={S.error} />{/if}
        {#if !S.data.initialized}<Banner msg={$t('app.noConfig')} />{/if}
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
<div inert={settingsOpen}><Drawer /></div>
{#if settingsOpen}<Settings bind:this={settings} onclose={closeSettings} />{/if}
<Toast />
