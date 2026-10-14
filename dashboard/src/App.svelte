<!-- The dashboard shell: sidebar, phone nav, banners, the active view, the daemon bar, the drawer, the command bar and the toast. -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Banner from './components/Banner.svelte';
  import CommandBar from './components/CommandBar.svelte';
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
  import { VIEWS, activeSessions, viewIndex, type ViewId } from './lib/view.ts';
  import { t } from './lib/locale.ts';
  import { settingsKey } from './lib/settings.ts';
  import { commandKey, shortcutLabel } from './lib/command.ts';
  import { pref } from './lib/prefs.ts';

  let settingsOpen = $state(false);
  let settings = $state<ReturnType<typeof Settings>>();
  let commandOpen = $state(false);
  let command = $state<ReturnType<typeof CommandBar>>();
  // Focus goes back here when a modal closes.
  let opener: HTMLElement | null = null;
  const shortcut = shortcutLabel(typeof navigator === 'undefined' ? '' : navigator.platform);
  const sessions = $derived(activeSessions(S.data?.jobs ?? [], Date.now()));
  // The same map Nav.svelte builds, for the DWG line and the title block's SHEET cell.
  const labels = $derived<Record<ViewId, string>>({
    pipeline: $t('nav.pipeline'),
    inbox: $t('nav.inbox'),
    backlog: $t('nav.backlog'),
    agents: $t('nav.agents'),
    analytics: $t('nav.analytics'),
    evals: $t('nav.evals'),
  });
  const viewLabel = $derived(labels[S.view]);

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

  function openCommand(): void {
    if (commandOpen) return void command?.focus();
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    commandOpen = true;
  }

  function closeCommand(): void {
    commandOpen = false;
    const back = opener;
    opener = null;
    tick().then(() => back?.focus());
  }

  function onKey(e: KeyboardEvent): void {
    const bar = commandKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, open: commandOpen, settingsOpen, repeat: e.repeat, composing: e.isComposing });
    if (bar) {
      e.preventDefault();
      if (bar === 'open') openCommand();
      else closeCommand();
      return;
    }
    if (commandOpen) return;
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

<div class="flex min-h-screen" inert={settingsOpen || commandOpen}>
  <aside id="sidebar" class="hidden md:flex w-(--size-sidebar) shrink-0 flex-col gap-1 border-r border-line bg-black/8 px-3 py-4 sticky top-0 h-screen overflow-y-auto">
    <div class="sheet ticks flex items-center gap-3 py-3 pr-3 pl-3.5 mb-1.5"><span class="tk"></span><img src="/forge.png" alt="" class="mark shrink-0" /><div class="min-w-0"><div class="h sheet-title">{$t('app.brand')}</div><div class="label mt-0.5">{$t('app.tagline')}</div></div></div>
    <div class="dim-line mx-0.5 mt-0.5 mb-2.5"><span class="end"></span>{$t('app.dwg', { view: viewLabel })}<span class="end"></span></div>
    <div class="label flex min-w-0 items-baseline gap-2 px-2.5 pb-2.5"><span class="shrink-0">{$t('app.repo')}</span><span id="repo-name" class="mono truncate font-normal normal-case tracking-normal text-fg">{S.data?.repo?.name ?? ''}</span></div>
    <button id="command-open" class="btn dashed mb-2.5 w-full justify-between" aria-haspopup="dialog" aria-keyshortcuts="Meta+K Control+K" onclick={openCommand}><span class="flex min-w-0 items-center gap-2 overflow-hidden"><Icon name="command" /><span class="truncate">{$t('command.open')}</span></span><kbd class="mono muted shrink-0 text-[10px]">{shortcut}</kbd></button>
    <nav id="nav" class="nav"><Nav /></nav>
    <div class="mt-auto flex flex-col gap-2 pt-3">
      <div class="nav"><button id="settings-open" aria-haspopup="dialog" aria-keyshortcuts="," onclick={openSettings}><span class="lbl"><Icon name="settings" />{$t('settings.open')}</span></button></div>
      <div class="tblock">
        <div><span class="k">{$t('app.tblock.drawnBy')}</span>{$t('app.tblock.drawnByValue')}</div>
        <div id="footer-sessions"><span class="k">{$t('app.tblock.sessions')}</span><span class="dot {sessions ? 'ok' : 'hollow'} mr-1 align-middle"></span>{$t('app.tblock.sessionsValue', { count: sessions })}</div>
        <div id="footer-version"><span class="k">{$t('app.tblock.rev')}</span>{S.data ? $t('app.tblock.revValue', { version: S.data.forgeVersion }) : '—'}</div>
        <div><span class="k">{$t('app.tblock.api')}</span>{S.data ? S.data.apiVersion : '—'}</div>
        <div class="wide"><span class="k">{$t('app.tblock.sheet')}</span>{$t('app.tblock.sheetValue', { view: viewLabel, index: viewIndex(S.view), total: VIEWS.length })}</div>
      </div>
    </div>
  </aside>
  <main class="falloff flex-1 min-w-0">
    <!-- The command and settings buttons stay outside the scrolling nav, so they are always on screen. -->
    <header class="md:hidden flex items-center gap-1 border-b border-line bg-black/8 pr-2">
      <div id="mobile-nav" class="nav row flex-1 min-w-0 overflow-x-auto p-2"><Nav mobile /></div>
      <button id="command-open-mobile" class="btn icon touch shrink-0" aria-label={$t('command.open')} aria-haspopup="dialog" onclick={openCommand}><Icon name="command" /></button>
      <button id="settings-open-mobile" class="btn icon touch shrink-0" aria-label={$t('settings.open')} aria-haspopup="dialog" onclick={openSettings}><Icon name="settings" /></button>
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
<div inert={settingsOpen || commandOpen}><Drawer /></div>
{#if settingsOpen}<Settings bind:this={settings} onclose={closeSettings} />{/if}
{#if commandOpen}<CommandBar bind:this={command} onclose={closeCommand} />{/if}
<Toast />
