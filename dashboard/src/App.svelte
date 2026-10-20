<!-- The dashboard shell: sidebar (with the "New job or command" input), phone nav, banners, the active view, the job
     drawer over it, the status bar and its popovers, the command palette, and the toast. -->
<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import Banner from './components/Banner.svelte';
  import CommandBar from './components/CommandBar.svelte';
  import Drawer from './components/Drawer.svelte';
  import GitHubCard from './components/GitHubCard.svelte';
  import Icon from './components/Icon.svelte';
  import Nav from './components/Nav.svelte';
  import RailTip from './components/RailTip.svelte';
  import Settings from './components/Settings.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import Toast from './components/Toast.svelte';
  import Tooltip from './components/Tooltip.svelte';
  import Pipeline from './views/Pipeline.svelte';
  import Backlog from './views/Backlog.svelte';
  import Agents from './views/Agents.svelte';
  import Analytics from './views/Analytics.svelte';
  import Evals from './views/Evals.svelte';
  import Project from './views/Project.svelte';
  import { S, closeDrawer, loadView, refresh, route, setSidebar } from './lib/app.svelte.ts';
  import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_RAIL, sidebarDrag, sidebarKey, sidebarShown } from './lib/sidebar.ts';
  import { hideTip, railTipOn } from './lib/rail-tip.svelte.ts';
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
    project: $t('nav.project'),
    backlog: $t('nav.backlog'),
    agents: $t('nav.agents'),
    analytics: $t('nav.analytics'),
    evals: $t('nav.evals'),
  });
  const viewLabel = $derived(labels[S.view]);

  // ---------- the sidebar's width and its icon-only rail ----------
  const compact = $derived(S.side.compact);
  /** The width on screen, which --size-sidebar carries to the aside, the status bar's left edge and the drawer's gutter. */
  const shown = $derived(sidebarShown(S.side));
  let sideDrag: { x: number; start: number } | null = null;
  let sideDragging = $state(false);
  function sideDragStart(e: PointerEvent & { currentTarget: HTMLElement }): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    sideDrag = { x: e.clientX, start: shown };
    sideDragging = true;
  }
  function sideDragMove(e: PointerEvent): void {
    if (!sideDrag) return;
    // The separator is the sidebar's right edge: moving right widens it. Snapping to the rail keeps the expanded width.
    const r = sidebarDrag(sideDrag.start + (e.clientX - sideDrag.x));
    setSidebar(r.compact ? { width: S.side.width, compact: true } : r, false);
  }
  // Both pointerup and lostpointercapture end a drag; the second call finds no drag, so the sidebar is saved once.
  function sideDragEnd(): void {
    if (!sideDrag) return;
    sideDrag = null;
    sideDragging = false;
    setSidebar({ width: S.side.width, compact: S.side.compact });
  }
  function sideKey(e: KeyboardEvent): void {
    const next = sidebarKey({ width: S.side.width, compact: S.side.compact }, e.key, e.shiftKey);
    if (!next) return;
    e.preventDefault();
    setSidebar(next);
  }
  const sideReset = (): void => setSidebar({ width: SIDEBAR_DEFAULT, compact: false });

  // The rail's tooltip goes when the rail expands or the drawer covers it.
  $effect(() => {
    if (!compact || covered) hideTip();
  });

  // Settings or the palette taking over closes a popover and leaves focus to that dialog.
  $effect(() => {
    if (settingsOpen || palette.open) untrack(() => closePopover('external'));
  });

  // The toast and the job drawer follow the md breakpoint; the drawer's width clamps to the window (bound below).
  $effect(() => {
    const mq = matchMedia('(width >= 48rem)');
    const set = (): void => {
      S.pane.md = mq.matches;
    };
    set();
    mq.addEventListener('change', set);
    return () => mq.removeEventListener('change', set);
  });

  // An open drawer covers the view, the sidebar and the phone header: they leave the tab order, the drawer takes focus
  // (Drawer), and closing it hands focus back to the control that opened it (WCAG 2.4.11). Pre-effect, so the opener is
  // read before inert lands on it.
  const covered = $derived(S.drawer.id !== null);
  $effect.pre(() => {
    if (!covered) return;
    const active = untrack(() => document.activeElement);
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    return () => {
      // Read after the flush: the cleanup can run before the close lands, and switching jobs keeps the drawer open.
      if (opener) tick().then(() => S.drawer.id === null && opener.isConnected && opener.focus());
    };
  });

  // The page under an open drawer does not scroll; html's scrollbar-gutter: stable keeps it from shifting.
  $effect(() => {
    if (!covered) return;
    document.documentElement.classList.add('overflow-hidden');
    return () => document.documentElement.classList.remove('overflow-hidden');
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
  let settingsMobile = $state<HTMLButtonElement>();

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
    const views = setInterval(() => document.visibilityState === 'visible' && ['analytics', 'evals', 'agents', 'project'].includes(S.view) && loadView(), 15000);
    const stopClock = startClock();
    return () => {
      stopClock();
      clearInterval(poll);
      clearInterval(views);
    };
  });
</script>

<svelte:window bind:innerWidth={S.pane.viewport} onhashchange={route} onkeydown={onKey} />

<div class="flex min-h-screen" style="--size-sidebar: {shown}px" inert={settingsOpen || palette.open}>
  <!-- Compact, the sidebar is a 64px rail: the brand's mark, an icon button for the palette, the view icons and the gear,
       each named by aria-label and shown a tooltip (RailTip) on hover and focus. -->
  <aside id="sidebar" class="hidden md:flex w-(--size-sidebar) shrink-0 flex-col gap-1 border-r chrome z-10 border-line-strong shadow-(--shadow-chrome) {compact ? 'px-2' : 'px-3'} py-4 sticky top-0 h-screen overflow-y-auto overscroll-contain" inert={covered}>
    <div class="plate riveted flex items-center {compact ? 'justify-center px-1 py-2' : 'gap-3 py-3 pr-3 pl-3.5'} mb-1.5"><img src="/forge.png" alt="" class="mark shrink-0" />{#if !compact}<div class="min-w-0"><div class="h sheet-title">{$t('app.brand')}</div><div class="label mt-0.5">{$t('app.tagline')}</div></div>{/if}</div>
    {#if !compact}<div class="stamp-line wide mx-0.5 mt-0.5 mb-2">{$t('app.view', { view: viewLabel })}</div>{/if}
    {#if !compact}<div class="label flex min-w-0 items-baseline gap-2 px-2.5 pb-2.5"><span class="shrink-0">{$t('app.repo')}</span><span id="repo-name" class="mono truncate font-normal normal-case tracking-normal text-fg">{S.data?.repo?.name ?? ''}</span></div>{/if}
    <!-- A real input: typing hands its text to the palette. The kbd is hidden from assistive tech because
         aria-keyshortcuts announces it. The placeholder is its only visible label, so it takes muted (4.5:1 in both
         themes) rather than dim, and the strong edge. On the rail it is an icon button that opens the palette; with no
         input on screen, Cmd/Ctrl-K opens the palette at once (commandState). -->
    <span class="relative mb-2.5 {compact ? 'flex justify-center' : 'block'}">
      {#if compact}
      <button id="sidebar-command" class="btn icon" aria-label={$t('command.open')} aria-haspopup="dialog" aria-keyshortcuts="Meta+K Control+K" onclick={(e) => openPalette({ opener: e.currentTarget })} {@attach railTipOn($t('command.open'))}><Icon name="command" /></button>
      {:else}
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
      {/if}
    </span>
    <nav id="nav" class="navlist {compact ? 'rail' : ''}"><Nav {compact} /></nav>
    <div class="mt-auto flex flex-col gap-2 pt-3">
      <div class="navlist {compact ? 'rail' : ''}"><button id="settings-open" aria-label={compact ? $t('settings.open') : undefined} aria-haspopup="dialog" aria-keyshortcuts={settingsKeyShortcuts(platform)} onclick={openSettings} {@attach compact && railTipOn($t('settings.open'))}>{#if compact}<Icon name="settings" />{:else}<span class="lbl"><Icon name="settings" />{$t('settings.open')}</span><kbd class="mono muted text-[10px] normal-case" aria-hidden="true">{settingsShortcut}</kbd>{/if}</button></div>
    </div>
  </aside>
  <!-- The sidebar's separator, outside the aside so it never scrolls with it: an 8px hit area over the aside's right rule,
       which turns gleam while it is hovered, focused or dragged (as on the job panel). Dragging below the minimum snaps
       to the rail; the arrow keys step it, Home is the rail, End the maximum, Enter toggles the rail, a double-click
       restores the default. -->
  <div class="hidden md:block w-0 shrink-0 sticky top-0 h-screen z-20" inert={covered}>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (a focusable separator with a value is a widget in ARIA: the window splitter pattern) -->
    <div
      role="separator"
      aria-orientation="vertical"
      aria-controls="sidebar"
      aria-label={$t('sidebar.resize')}
      aria-valuemin={SIDEBAR_RAIL}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={shown}
      tabindex="0"
      class="group absolute inset-y-0 -left-1 w-2 cursor-col-resize touch-none focus-visible:-outline-offset-2"
      onpointerdown={sideDragStart}
      onpointermove={sideDragMove}
      onpointerup={sideDragEnd}
      onlostpointercapture={sideDragEnd}
      onkeydown={sideKey}
      ondblclick={sideReset}
    ><span class="absolute inset-y-0 left-[3px] border-l {sideDragging ? 'border-gleam' : 'border-transparent group-hover:border-gleam group-focus-visible:border-gleam'}" aria-hidden="true"></span></div>
  </div>
  <RailTip />
  <main class="falloff flex-1 min-w-0">
    <!-- The palette and settings buttons stay outside the scrolling nav, so they are always on screen. -->
    <header class="md:hidden flex items-center gap-1 border-b chrome border-line-strong pr-2" inert={covered}>
      <div id="mobile-nav" class="navlist row flex-1 min-w-0 overflow-x-auto p-2"><Nav mobile /></div>
      <button id="mobile-command" class="btn touch shrink-0 px-2.5! normal-case tracking-normal" aria-haspopup="dialog" onclick={(e) => openPalette({ opener: e.currentTarget })}><Icon name="command" /><span class="max-sm:sr-only">{$t('command.open')}</span></button>
      <button bind:this={settingsMobile} id="settings-open-mobile" class="btn icon touch shrink-0" aria-label={$t('settings.open')} aria-haspopup="dialog" onclick={openSettings}><Icon name="settings" /></button>
    </header>
    <!-- Outside the strip, which holds exactly its three controls; the tip sits in the top layer wherever it is written. -->
    <Tooltip anchor={settingsMobile} text={$t('settings.open')} />
    <!-- The view keeps its centred width whether the drawer is open or not: the drawer overlays it. #view is the board's
         container-query root. -->
    <div id="view" class="@container mx-auto max-w-[1400px] px-4 md:px-8 pt-4 pb-[calc(var(--size-statusbar)_+_env(safe-area-inset-bottom)_+_var(--space-6))]" inert={covered}>
      {#if !S.data}
        {#if S.error}<Banner msg={S.error} />{:else}<div class="plate w-fit px-3 py-1.5 text-sm text-muted">{$t('common.loading')}</div>{/if}
      {:else}
        {#if S.error}<Banner msg={S.error} />{/if}
        {#if !S.data.initialized}<Banner msg={$t('app.noConfig')} />{/if}
        {#if S.view === 'pipeline'}<Pipeline data={S.data} />
        {:else if S.view === 'backlog'}<Backlog />
        {:else if S.view === 'agents'}<Agents data={S.data} />
        {:else if S.view === 'analytics'}<Analytics data={S.data} />
        {:else if S.view === 'project'}<Project data={S.data} />
        {:else}<Evals data={S.data} />{/if}
      {/if}
    </div>
  </main>
  <!-- Outside main: main.falloff isolates, which would trap the bar's z-25 and its popovers' z-42 inside main's stacking
       context, where they could not order against the drawer's backdrop, the drawer and the toast. -->
  <StatusBar />
</div>
<!-- Outside main as well: inside main.falloff's stacking context, the sidebar's z-10 would sit above the backdrop. -->
<div inert={settingsOpen || palette.open}><Drawer /></div>
{#if settingsOpen}<Settings bind:this={settings} onclose={closeSettings} />{/if}
{#if palette.open}<CommandBar bind:this={command} onclose={closePalette} />{/if}
<Toast />
<!-- Last and outside every inert wrapper: it describes links in Settings and the palette too. -->
<GitHubCard />
