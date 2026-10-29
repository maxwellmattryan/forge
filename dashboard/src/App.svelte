<!-- The dashboard shell: sidebar (with the "New job or command" input, the global pages and the project section), phone
     nav, banners, the run's launch-mode line, the active view (a global page, or the selected project's), the drawer over it (the job or the issue
     panel, in one shell), the status bar
     and its popovers, the command palette, the Add project dialog, and the toast. Everything a project owns remounts when
     the project changes. -->
<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import AddProject from './components/AddProject.svelte';
  import Banner from './components/Banner.svelte';
  import CommandBar from './components/CommandBar.svelte';
  import Drawer from './components/Drawer.svelte';
  import DrawerShell from './components/DrawerShell.svelte';
  import IssueDrawer from './components/IssueDrawer.svelte';
  import GitHubCard from './components/GitHubCard.svelte';
  import Icon from './components/Icon.svelte';
  import Nav from './components/Nav.svelte';
  import RailTip from './components/RailTip.svelte';
  import Settings from './components/Settings.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import Toast from './components/Toast.svelte';
  import Tooltip from './components/Tooltip.svelte';
  import Pipeline from './views/Pipeline.svelte';
  import Issues from './views/Issues.svelte';
  import Agents from './views/Agents.svelte';
  import Office from './views/Office.svelte';
  import Foreman from './views/Foreman.svelte';
  import Analytics from './views/Analytics.svelte';
  import Evals from './views/Evals.svelte';
  import Project from './views/Project.svelte';
  import Overview from './views/Overview.svelte';
  import Machine from './views/Machine.svelte';
  import PipelineSkeleton from './components/skeletons/PipelineSkeleton.svelte';
  import IssuesSkeleton from './components/skeletons/IssuesSkeleton.svelte';
  import AgentsSkeleton from './components/skeletons/AgentsSkeleton.svelte';
  import OfficeSkeleton from './components/skeletons/OfficeSkeleton.svelte';
  import ForemanSkeleton from './components/skeletons/ForemanSkeleton.svelte';
  import AnalyticsSkeleton from './components/skeletons/AnalyticsSkeleton.svelte';
  import EvalsSkeleton from './components/skeletons/EvalsSkeleton.svelte';
  import ProjectSkeleton from './components/skeletons/ProjectSkeleton.svelte';
  import { S, checkSelection, closeDrawer, loadOverview, loadView, refresh, refreshMachine, route, setSidebar } from './lib/core/app.svelte.ts';
  import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_RAIL, sidebarDrag, sidebarKey, sidebarShown } from './lib/shell/sidebar.ts';
  import { hideTip, railTipOn } from './lib/shell/rail-tip.svelte.ts';
  import { startClock } from './lib/core/clock.svelte.ts';
  import { inlineInputAction, type InlineInputEvent } from './lib/shell/statusbar.ts';
  import { t } from './lib/text/locale.ts';
  import { settingsKey, settingsKeyShortcuts, settingsShortcutLabel, type SettingsTabId } from './lib/settings/modal.ts';
  import { commandKey, isMac, shellEscape, shortcutAction, shortcutLabel } from './lib/shell/command.ts';
  import { closePalette, openPalette, palette } from './lib/shell/palette.svelte.ts';
  import { addProjectDialog, closeAddProject } from './lib/shell/add-project.svelte.ts';
  import { closePopover, popover } from './lib/ui/overlay/popover.svelte.ts';
  import { closeCard, ghCard } from './lib/ui/overlay/github-card.svelte.ts';
  import { lockScroll } from './lib/ui/overlay/scroll-lock.ts';
  import { launchMode } from './lib/sessions/daemon.ts';

  let settingsOpen = $state(false);
  /** The tab Settings opens on; unset opens the saved tab. */
  let settingsStart = $state<SettingsTabId | undefined>();
  let settings = $state<ReturnType<typeof Settings>>();
  let command = $state<ReturnType<typeof CommandBar>>();
  // Focus goes back here when Settings closes (the palette keeps its own, in palette.svelte.ts).
  let settingsOpener: HTMLElement | null = null;
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  const shortcut = shortcutLabel(platform);
  const mac = isMac(platform);
  const settingsShortcut = settingsShortcutLabel(platform);
  /** The selected project: every project-scoped component below is keyed on it, so none keeps another project's state. */
  const project = $derived(S.selected);
  /** `forge dash --permission-mode`, the run's launch mode for every project, or null without one. */
  const launch = $derived(launchMode(S.machine?.machine));
  const launchName = $derived(launch === 'auto' ? $t('session.modes.auto') : launch === 'dontAsk' ? $t('session.modes.dontAsk') : $t('session.modes.default'));

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

  // Settings, the palette or the Add project dialog taking over closes a popover and leaves focus to that dialog.
  $effect(() => {
    if (settingsOpen || palette.open || addProjectDialog.open) untrack(() => closePopover('external'));
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
  const covered = $derived(S.drawer.open);
  $effect.pre(() => {
    if (!covered) return;
    const active = untrack(() => document.activeElement);
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    return () => {
      // Read after the flush: the cleanup can run before the close lands, and switching jobs or panels keeps the drawer open.
      if (opener) tick().then(() => !S.drawer.open && opener.isConnected && opener.focus());
    };
  });

  // The page under an open drawer does not scroll (lib/ui/overlay/scroll-lock.ts keeps it from shifting).
  $effect(() => {
    if (!covered) return;
    return lockScroll();
  });

  $effect(() => {
    document.title = project !== null && S.data?.repo?.name ? $t('app.titleRepo', { repo: S.data.repo.name }) : $t('app.title');
  });

  // Switching projects (including to none) closes Settings, dropping its drafts, which belong to the old project, and
  // the palette; Back and Forward switch too. The drawer is closed by switchProject.
  $effect(() => {
    void project;
    untrack(() => {
      if (settingsOpen) closeSettings();
      closePalette();
    });
  });

  function openSettings(start?: SettingsTabId): void {
    settingsOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    settingsStart = start;
    settingsOpen = true;
  }

  function closeSettings(): void {
    settingsOpen = false;
    const back = settingsOpener;
    settingsOpener = null;
    tick().then(() => back?.focus());
  }

  function onKey(e: KeyboardEvent): void {
    // The Add project dialog counts as Settings here: while it is open, Cmd/Ctrl-K and the Settings shortcut do nothing.
    if (commandKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, open: palette.open, settingsOpen: settingsOpen || addProjectDialog.open, repeat: e.repeat, composing: e.isComposing }) === 'open') {
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
      const layer = shellEscape({ card: ghCard.link !== null, command: palette.open, addProject: addProjectDialog.open, settings: settingsOpen, popover: popover.open !== null, drawer: S.drawer.open });
      if (layer === 'card') {
        e.preventDefault();
        closeCard();
      } else if (layer === 'command') {
        e.preventDefault();
        closePalette();
      } else if (layer === 'addProject') {
        e.preventDefault();
        closeAddProject();
      } else if (layer === 'settings') {
        e.preventDefault();
        settings?.requestClose();
      } else if (layer === 'popover') {
        e.preventDefault();
        closePopover('escape');
      } else if (layer === 'drawer') closeDrawer();
      return;
    }
    const action = settingsKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, open: settingsOpen || addProjectDialog.open, mac, palette: palette.open, repeat: e.repeat, composing: e.isComposing });
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
    // The route (or, on a global page, the remembered project) selects the project, and selecting one loads it. The
    // first machine list checks the remembered project is still there.
    route();
    refreshMachine().then(checkSelection);
    // The state poll runs whenever a project is selected (the nav's counts read it); the views' only on its pages.
    const poll = setInterval(() => document.visibilityState === 'visible' && refresh(), 2000);
    const views = setInterval(() => document.visibilityState === 'visible' && S.route.scope === 'project' && ['analytics', 'evals', 'agents', 'project', 'office'].includes(S.view) && loadView(), 15000);
    // A poll, not /api/projects/events: a stream held by every tab would take the machine's few SSE slots from the session logs.
    const machine = setInterval(() => document.visibilityState === 'visible' && refreshMachine(), 5000);
    // The Overview's graphs re-read every ledger, so they reload less often than its counts.
    const overview = setInterval(() => document.visibilityState === 'visible' && S.route.scope === 'global' && S.route.view === 'overview' && loadOverview(), 15000);
    const stopClock = startClock();
    return () => {
      stopClock();
      clearInterval(poll);
      clearInterval(views);
      clearInterval(machine);
      clearInterval(overview);
    };
  });
</script>

<svelte:window bind:innerWidth={S.pane.viewport} onhashchange={route} onkeydown={onKey} />

<div class="flex min-h-screen" style="--size-sidebar: {shown}px" inert={settingsOpen || palette.open || addProjectDialog.open}>
  <!-- Compact, the sidebar is a 64px rail: the brand's mark, an icon button for the palette, the view icons and the gear,
       each named by aria-label and shown a tooltip (RailTip) on hover and focus. -->
  <aside id="sidebar" class="hidden md:flex w-(--size-sidebar) shrink-0 flex-col gap-1 border-r chrome z-10 border-line-strong shadow-(--shadow-chrome) {compact ? 'px-2 pb-2' : 'px-3 pb-3'} pt-4 sticky top-0 h-screen overflow-y-auto overscroll-contain" inert={covered}>
    <div class="plate riveted flex items-center {compact ? 'justify-center px-1 py-2' : 'gap-3 py-3 pr-3 pl-3.5'} mb-1.5"><img src="/forge.png" alt="" class="mark shrink-0" />{#if !compact}<div class="min-w-0"><div class="h sheet-title">{$t('app.brand')}</div><div class="label mt-0.5">{$t('app.tagline')}</div></div>{/if}</div>
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
    <nav id="nav" class="flex flex-col gap-1"><Nav {compact} /></nav>
    <div class="mt-auto flex flex-col gap-2 pt-3">
      <div class="navlist {compact ? 'rail' : ''}"><button id="settings-open" aria-label={compact ? $t('settings.open') : undefined} aria-haspopup="dialog" aria-keyshortcuts={settingsKeyShortcuts(platform)} onclick={() => openSettings()} {@attach compact && railTipOn($t('settings.open'))}>{#if compact}<Icon name="settings" />{:else}<span class="lbl"><Icon name="settings" />{$t('settings.open')}</span><kbd class="mono muted text-[10px] normal-case" aria-hidden="true">{settingsShortcut}</kbd>{/if}</button></div>
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
      <nav id="mobile-nav" class="flex flex-1 min-w-0 items-center gap-1 overflow-x-auto p-2"><Nav mobile /></nav>
      <button id="mobile-command" class="btn touch shrink-0 px-2.5! normal-case tracking-normal" aria-haspopup="dialog" onclick={(e) => openPalette({ opener: e.currentTarget })}><Icon name="command" /><span class="max-sm:sr-only">{$t('command.open')}</span></button>
      <button bind:this={settingsMobile} id="settings-open-mobile" class="btn icon touch shrink-0" aria-label={$t('settings.open')} aria-haspopup="dialog" onclick={() => openSettings()}><Icon name="settings" /></button>
    </header>
    <!-- Outside the strip, which holds exactly its three controls; the tip sits in the top layer wherever it is written. -->
    <Tooltip anchor={settingsMobile} text={$t('settings.open')} />
    <!-- The view keeps its centred width whether the drawer is open or not: the drawer overlays it. #view is the board's
         container-query root. -->
    <div id="view" class="@container mx-auto max-w-[1400px] px-4 md:px-8 pt-4 pb-[calc(var(--size-statusbar)_+_env(safe-area-inset-bottom)_+_var(--space-6))]" inert={covered}>
      <!-- The run's launch mode, once for the machine on every page. Not the ember Banner: nothing waits on you. Auto in warn tone. -->
      {#if launch !== null}<p role="note" class="plate w-fit flex items-center gap-2 px-3 py-1.5 mx-1.5 mb-4 text-sm {launch === 'auto' ? 'text-warn' : 'muted'}"><Icon name="shield" /><span class="min-w-0"><span class="mono">{$t('app.launchCommand', { mode: launch })}</span> {$t('app.launchMode', { mode: launchName })}</span></p>{/if}
      {#key project}
        {#if S.route.scope === 'global'}
          {#if S.route.view === 'overview'}<Overview />{:else}<Machine />{/if}
        {:else if !S.data}
          {#if S.error}<Banner msg={S.error} />
          {:else if S.view === 'pipeline'}<PipelineSkeleton />
          {:else if S.view === 'issues'}<IssuesSkeleton />
          {:else if S.view === 'agents'}<AgentsSkeleton />
          {:else if S.view === 'office'}<OfficeSkeleton />
          {:else if S.view === 'foreman'}<ForemanSkeleton />
          {:else if S.view === 'analytics'}<AnalyticsSkeleton />
          {:else if S.view === 'project'}<ProjectSkeleton />
          {:else}<EvalsSkeleton />{/if}
        {:else}
          {#if S.error}<Banner msg={S.error} />{/if}
          {#if !S.data.initialized}<Banner msg={$t('app.noConfig')} />{/if}
          {#if S.view === 'pipeline'}<Pipeline />
          {:else if S.view === 'issues'}<Issues />
          {:else if S.view === 'agents'}<Agents />
          {:else if S.view === 'office'}<Office />
          {:else if S.view === 'foreman'}<Foreman />
          {:else if S.view === 'analytics'}<Analytics />
          {:else if S.view === 'project'}<Project />
          {:else}<Evals />{/if}
        {/if}
      {/key}
    </div>
  </main>
  <!-- Outside main: main.falloff isolates, which would trap the bar's z-25 and its popovers' z-42 inside main's stacking
       context, where they could not order against the drawer's backdrop, the drawer and the toast. Every indicator in it
       is a project's, so a global page has none. -->
  {#if project !== null}{#key project}<StatusBar />{/key}{/if}
</div>
<!-- Outside main as well: inside main.falloff's stacking context, the sidebar's z-10 would sit above the backdrop. -->
<!-- One shell for both panels; `kind` outlives a close, so the drawer slides out with the panel it showed. -->
<div inert={settingsOpen || palette.open || addProjectDialog.open}>{#key project}<DrawerShell open={S.drawer.open} label={S.drawer.kind === 'issue' ? $t('issues.view.label') : $t('drawer.label')}>{#snippet children(focusTitle)}{#if S.drawer.kind === 'issue'}<IssueDrawer {focusTitle} />{:else}<Drawer {focusTitle} />{/if}{/snippet}</DrawerShell>{/key}</div>
{#if settingsOpen}{#key project}<Settings bind:this={settings} start={settingsStart} onclose={closeSettings} />{/key}{/if}
{#if addProjectDialog.open}<AddProject />{/if}
{#if palette.open}{#key project}<CommandBar bind:this={command} onclose={closePalette} />{/key}{/if}
<Toast />
<!-- Last and outside every inert wrapper: it describes links in Settings and the palette too. -->
<GitHubCard />
