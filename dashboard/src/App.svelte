<!-- The dashboard shell: sidebar, phone nav, banners, the active view, the status bar and its popovers, the drawer, the command palette, and the toast. -->
<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import Banner from './components/Banner.svelte';
  import CommandBar from './components/CommandBar.svelte';
  import Drawer from './components/Drawer.svelte';
  import Icon from './components/Icon.svelte';
  import LiveDot from './components/LiveDot.svelte';
  import Nav from './components/Nav.svelte';
  import Settings from './components/Settings.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import Toast from './components/Toast.svelte';
  import Pipeline from './views/Pipeline.svelte';
  import Inbox from './views/Inbox.svelte';
  import Backlog from './views/Backlog.svelte';
  import Agents from './views/Agents.svelte';
  import Analytics from './views/Analytics.svelte';
  import Evals from './views/Evals.svelte';
  import { S, closeDrawer, loadView, refresh, route } from './lib/app.svelte.ts';
  import { startClock } from './lib/clock.svelte.ts';
  import { VIEWS, viewIndex, type ViewId } from './lib/view.ts';
  import { activeSessions } from './lib/live.ts';
  import { INBOX_SCOPE } from './lib/types.ts';
  import { t } from './lib/locale.ts';
  import { settingsKey } from './lib/settings.ts';
  import { commandKey, shellEscape, shortcutAction } from './lib/command.ts';
  import { closePalette, openPalette, palette } from './lib/palette.svelte.ts';
  import { closePopover, popover } from './lib/popover.svelte.ts';
  import { pref } from './lib/prefs.ts';

  let settingsOpen = $state(false);
  let settings = $state<ReturnType<typeof Settings>>();
  let command = $state<ReturnType<typeof CommandBar>>();
  let bar = $state<ReturnType<typeof StatusBar>>();
  // Focus goes back here when Settings closes (the palette keeps its own, in palette.svelte.ts).
  let settingsOpener: HTMLElement | null = null;
  const active = $derived(activeSessions(S.data?.daemons));
  // One active session per line: the sidebar cell and the phone strip share it.
  const activeTitle = $derived(active.count ? active.ids.map((id) => (id === INBOX_SCOPE ? $t('live.inbox') : id)).join('\n') : $t('live.none'));
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

  // Settings or the palette taking over closes a popover and leaves focus to that dialog.
  $effect(() => {
    if (settingsOpen || palette.open) untrack(() => closePopover('external'));
  });

  $effect(() => {
    document.title = S.data?.repo?.name ? $t('app.titleRepo', { repo: S.data.repo.name }) : $t('app.title');
  });

  function openSettings(): void {
    settingsOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    settingsOpen = true;
  }

  function closeSettings(): void {
    settingsOpen = false;
    const back = settingsOpener;
    settingsOpener = null;
    tick().then(() => back?.focus());
  }

  function onKey(e: KeyboardEvent): void {
    if (commandKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, open: palette.open, settingsOpen, repeat: e.repeat, composing: e.isComposing }) === 'open') {
      e.preventDefault();
      // Open: back to its input, keeping the scope. md and up: the first press focuses the bar's input, the second opens.
      const inline = bar?.commandState() ?? { visible: false, focused: false };
      const action = shortcutAction({ paletteOpen: palette.open, inlineVisible: inline.visible, inlineFocused: inline.focused });
      if (action === 'focus-palette') command?.focus();
      else if (action === 'focus-inline') bar?.focusCommand();
      else openPalette();
      return;
    }
    if (e.key === 'Escape') {
      // Escape that cancels an IME composition closes nothing.
      if (e.isComposing) return;
      const layer = shellEscape({ command: palette.open, settings: settingsOpen, popover: popover.open !== null, drawer: S.drawer.id !== null });
      if (layer === 'command') {
        e.preventDefault();
        closePalette();
      } else if (layer === 'settings') {
        e.preventDefault();
        settings?.requestClose();
      } else if (layer === 'popover') {
        e.preventDefault();
        closePopover('escape');
      } else if (layer === 'drawer') closeDrawer();
      return;
    }
    if (palette.open) return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    const action = settingsKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, targetTag: target?.tagName ?? '', editable: target?.isContentEditable ?? false, open: settingsOpen, shortcut: pref.get('settingsShortcut', 'on') !== 'off', repeat: e.repeat, composing: e.isComposing });
    if (action === 'open') {
      e.preventDefault();
      openSettings();
    }
  }

  onMount(() => {
    route();
    refresh();
    const poll = setInterval(() => document.visibilityState === 'visible' && refresh(), 2000);
    const views = setInterval(() => document.visibilityState === 'visible' && ['analytics', 'evals', 'agents'].includes(S.view) && loadView(), 15000);
    const stopClock = startClock();
    return () => {
      stopClock();
      clearInterval(poll);
      clearInterval(views);
    };
  });
</script>

<svelte:window onhashchange={route} onkeydown={onKey} />

<div class="flex min-h-screen" inert={settingsOpen || palette.open}>
  <aside id="sidebar" class="hidden md:flex w-(--size-sidebar) shrink-0 flex-col gap-1 border-r chrome z-10 border-line-strong shadow-(--shadow-chrome) px-3 py-4 sticky top-0 h-screen overflow-y-auto">
    <div class="sheet ticks flex items-center gap-3 py-3 pr-3 pl-3.5 mb-1.5"><span class="tk"></span><img src="/forge.png" alt="" class="mark shrink-0" /><div class="min-w-0"><div class="h sheet-title">{$t('app.brand')}</div><div class="label mt-0.5">{$t('app.tagline')}</div></div></div>
    <div class="dim-line mx-0.5 mt-0.5 mb-2.5"><span class="end"></span>{$t('app.dwg', { view: viewLabel })}<span class="end"></span></div>
    <div class="label flex min-w-0 items-baseline gap-2 px-2.5 pb-2.5"><span class="shrink-0">{$t('app.repo')}</span><span id="repo-name" class="mono truncate font-normal normal-case tracking-normal text-fg">{S.data?.repo?.name ?? ''}</span></div>
    <nav id="nav" class="nav"><Nav /></nav>
    <div class="mt-auto flex flex-col gap-2 pt-3">
      <div class="nav"><button id="settings-open" aria-haspopup="dialog" aria-keyshortcuts="," onclick={openSettings}><span class="lbl"><Icon name="settings" />{$t('settings.open')}</span></button></div>
      <div class="tblock">
        <div><span class="k">{$t('app.tblock.drawnBy')}</span>{$t('app.tblock.drawnByValue')}</div>
        <div id="footer-sessions" title={activeTitle}><span class="k">{$t('app.tblock.sessions')}</span><span class="mr-1 inline-flex align-middle"><LiveDot on={active.count > 0} /></span>{$t('app.tblock.sessionsValue', { count: active.count })}</div>
        <div id="footer-version"><span class="k">{$t('app.tblock.rev')}</span>{S.data ? $t('app.tblock.revValue', { version: S.data.forgeVersion }) : '—'}</div>
        <div><span class="k">{$t('app.tblock.api')}</span>{S.data ? S.data.apiVersion : '—'}</div>
        <div class="wide"><span class="k">{$t('app.tblock.sheet')}</span>{$t('app.tblock.sheetValue', { view: viewLabel, index: viewIndex(S.view), total: VIEWS.length })}</div>
      </div>
    </div>
  </aside>
  <main class="falloff flex-1 min-w-0">
    <!-- The settings button stays outside the scrolling nav, so it is always on screen; the palette opens from the status bar. -->
    <header class="md:hidden flex items-center gap-1 border-b chrome border-line-strong pr-2">
      <div id="mobile-nav" class="nav row flex-1 min-w-0 overflow-x-auto p-2"><Nav mobile /></div>
      <span id="mobile-sessions" class="label flex shrink-0 items-center gap-1.5 px-1" title={activeTitle}><LiveDot on={active.count > 0} /><span class="num">{$t('app.tblock.sessionsValue', { count: active.count })}</span></span>
      <button id="settings-open-mobile" class="btn icon touch shrink-0" aria-label={$t('settings.open')} aria-haspopup="dialog" onclick={openSettings}><Icon name="settings" /></button>
    </header>
    <div id="view" class="mx-auto max-w-[1400px] px-4 md:px-8 pt-4 pb-[calc(var(--size-statusbar)_+_env(safe-area-inset-bottom)_+_var(--space-6))]">
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
  <!-- Outside main: main.falloff isolates, which would trap the bar's z-35 and its popovers' z-42 inside main's stacking
       context, under the drawer's backdrop and the drawer. -->
  <StatusBar bind:this={bar} />
</div>
<div inert={settingsOpen || palette.open}><Drawer /></div>
{#if settingsOpen}<Settings bind:this={settings} onclose={closeSettings} />{/if}
{#if palette.open}<CommandBar bind:this={command} onclose={closePalette} />{/if}
<Toast />
