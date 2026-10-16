<!-- The dashboard shell: sidebar (with the "New job or command" input), phone nav, banners, the active view, the status
     bar and its popovers, the drawer, the command palette, and the toast. -->
<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import Banner from './components/Banner.svelte';
  import CommandBar from './components/CommandBar.svelte';
  import Drawer from './components/Drawer.svelte';
  import GitHubCard from './components/GitHubCard.svelte';
  import Icon from './components/Icon.svelte';
  import Nav from './components/Nav.svelte';
  import Settings from './components/Settings.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import Toast from './components/Toast.svelte';
  import Pipeline from './views/Pipeline.svelte';
  import Backlog from './views/Backlog.svelte';
  import Agents from './views/Agents.svelte';
  import Analytics from './views/Analytics.svelte';
  import Evals from './views/Evals.svelte';
  import { S, closeDrawer, loadView, refresh, route } from './lib/app.svelte.ts';
  import { startClock } from './lib/clock.svelte.ts';
  import type { ViewId } from './lib/view.ts';
  import { inlineInputAction, type InlineInputEvent } from './lib/statusbar.ts';
  import { t } from './lib/locale.ts';
  import { settingsKey, settingsKeyShortcuts, settingsShortcutLabel } from './lib/settings.ts';
  import { commandKey, isMac, shellEscape, shortcutAction, shortcutLabel } from './lib/command.ts';
  import { closePalette, openPalette, palette } from './lib/palette.svelte.ts';
  import { closePopover, popover } from './lib/popover.svelte.ts';
  import { closeCard, ghCard } from './lib/github-card.svelte.ts';

  let settingsOpen = $state(false);
  let settings = $state<ReturnType<typeof Settings>>();
  let command = $state<ReturnType<typeof CommandBar>>();
  // Focus goes back here when Settings closes (the palette keeps its own, in palette.svelte.ts).
  let settingsOpener: HTMLElement | null = null;
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  const shortcut = shortcutLabel(platform);
  const mac = isMac(platform);
  const settingsShortcut = settingsShortcutLabel(platform);
  // The same map Nav.svelte builds, for the sidebar's stamp line.
  const labels = $derived<Record<ViewId, string>>({
    pipeline: $t('nav.pipeline'),
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

  // The toast and the job pane follow the md breakpoint.
  $effect(() => {
    const mq = matchMedia('(width >= 48rem)');
    const set = (): void => {
      S.pane.md = mq.matches;
    };
    set();
    mq.addEventListener('change', set);
    return () => mq.removeEventListener('change', set);
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
      const inline = commandState();
      const action = shortcutAction({ paletteOpen: palette.open, inlineVisible: inline.visible, inlineFocused: inline.focused });
      if (action === 'focus-palette') command?.focus();
      else if (action === 'focus-inline') input?.focus();
      else openPalette();
      return;
    }
    if (e.key === 'Escape') {
      // Escape that cancels an IME composition closes nothing.
      if (e.isComposing) return;
      const layer = shellEscape({ card: ghCard.link !== null, command: palette.open, settings: settingsOpen, popover: popover.open !== null, drawer: S.drawer.id !== null });
      if (layer === 'card') {
        e.preventDefault();
        closeCard();
      } else if (layer === 'command') {
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
    const action = settingsKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, open: settingsOpen, mac, palette: palette.open, repeat: e.repeat, composing: e.isComposing });
    if (action === 'open') {
      e.preventDefault();
      openSettings();
    }
  }

  // ---------- the "New job or command" input ----------
  let input = $state<HTMLInputElement>();

  function inline(e: Event & { currentTarget: HTMLInputElement }, type: InlineInputEvent['type']): void {
    const el = e.currentTarget;
    const composing = 'isComposing' in e && type !== 'compositionend' ? Boolean(e.isComposing) : false;
    const key = e instanceof KeyboardEvent ? e.key : undefined;
    if (inlineInputAction({ type, value: el.value, key, composing }) !== 'open') return;
    if (type === 'keydown') e.preventDefault();
    openPalette({ text: el.value, opener: el });
    el.value = '';
  }

  /** For Cmd/Ctrl-K: whether the sidebar input shows (md and up) and has focus. */
  function commandState(): { visible: boolean; focused: boolean } {
    return { visible: Boolean(input && input.getClientRects().length > 0), focused: Boolean(input && document.activeElement === input) };
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
  <aside id="sidebar" class="hidden md:flex w-(--size-sidebar) shrink-0 flex-col gap-1 border-r chrome z-10 border-line-strong shadow-(--shadow-chrome) px-3 py-4 sticky top-0 h-screen overflow-y-auto overscroll-contain">
    <div class="plate riveted flex items-center gap-3 py-3 pr-3 pl-3.5 mb-1.5"><img src="/forge.png" alt="" class="mark shrink-0" /><div class="min-w-0"><div class="h sheet-title">{$t('app.brand')}</div><div class="label mt-0.5">{$t('app.tagline')}</div></div></div>
    <div class="stamp-line wide mx-0.5 mt-0.5 mb-2">{$t('app.view', { view: viewLabel })}</div>
    <div class="label flex min-w-0 items-baseline gap-2 px-2.5 pb-2.5"><span class="shrink-0">{$t('app.repo')}</span><span id="repo-name" class="mono truncate font-normal normal-case tracking-normal text-fg">{S.data?.repo?.name ?? ''}</span></div>
    <!-- A real input: typing hands its text to the palette. The kbd is hidden from assistive tech because
         aria-keyshortcuts announces it. The placeholder is its only visible label, so it takes muted (4.5:1 in both
         themes) rather than dim, and the strong edge. -->
    <span class="relative mb-2.5 block">
      <input
        bind:this={input}
        id="sidebar-command"
        type="text"
        aria-label={$t('command.open')}
        aria-haspopup="dialog"
        aria-keyshortcuts="Meta+K Control+K"
        autocomplete="off"
        spellcheck="false"
        placeholder={$t('command.open')}
        class="w-full pr-14! border-line-strong! placeholder:text-muted!"
        oninput={(e) => inline(e, 'input')}
        oncompositionend={(e) => inline(e, 'compositionend')}
        onkeydown={(e) => inline(e, 'keydown')}
      />
      <kbd class="mono muted pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[10px]" aria-hidden="true">{shortcut}</kbd>
    </span>
    <nav id="nav" class="navlist"><Nav /></nav>
    <div class="mt-auto flex flex-col gap-2 pt-3">
      <div class="navlist"><button id="settings-open" aria-haspopup="dialog" aria-keyshortcuts={settingsKeyShortcuts(platform)} onclick={openSettings}><span class="lbl"><Icon name="settings" />{$t('settings.open')}</span><kbd class="mono muted text-[10px] normal-case" aria-hidden="true">{settingsShortcut}</kbd></button></div>
    </div>
  </aside>
  <main class="falloff flex-1 min-w-0">
    <!-- The palette and settings buttons stay outside the scrolling nav, so they are always on screen. -->
    <header class="md:hidden flex items-center gap-1 border-b chrome border-line-strong pr-2">
      <div id="mobile-nav" class="navlist row flex-1 min-w-0 overflow-x-auto p-2"><Nav mobile /></div>
      <button id="mobile-command" class="btn touch shrink-0 px-2.5! normal-case tracking-normal" aria-haspopup="dialog" onclick={(e) => openPalette({ opener: e.currentTarget })}><Icon name="command" /><span class="max-sm:sr-only">{$t('command.open')}</span></button>
      <button id="settings-open-mobile" class="btn icon touch shrink-0" aria-label={$t('settings.open')} aria-haspopup="dialog" onclick={openSettings}><Icon name="settings" /></button>
    </header>
    <div id="view" class="mx-auto max-w-[1400px] px-4 md:px-8 pt-4 pb-[calc(var(--size-statusbar)_+_env(safe-area-inset-bottom)_+_var(--space-6))]">
      {#if !S.data}
        {#if S.error}<Banner msg={S.error} />{:else}<div class="plate w-fit px-3 py-1.5 text-sm text-muted">{$t('common.loading')}</div>{/if}
      {:else}
        {#if S.error}<Banner msg={S.error} />{/if}
        {#if !S.data.initialized}<Banner msg={$t('app.noConfig')} />{/if}
        {#if S.view === 'pipeline'}<Pipeline data={S.data} />
        {:else if S.view === 'backlog'}<Backlog />
        {:else if S.view === 'agents'}<Agents data={S.data} />
        {:else if S.view === 'analytics'}<Analytics data={S.data} />
        {:else}<Evals data={S.data} />{/if}
      {/if}
    </div>
  </main>
  <!-- Outside main: main.falloff isolates, which would trap the bar's z-35 and its popovers' z-42 inside main's stacking
       context, under the drawer's backdrop and the drawer. -->
  <StatusBar />
</div>
<div inert={settingsOpen || palette.open}><Drawer /></div>
{#if settingsOpen}<Settings bind:this={settings} onclose={closeSettings} />{/if}
{#if palette.open}<CommandBar bind:this={command} onclose={closePalette} />{/if}
<Toast />
<!-- Last and outside every inert wrapper: it describes links in Settings and the palette too. -->
<GitHubCard />
