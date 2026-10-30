<!-- The drawer's shell, which the job panel and the issue panel share: it slides in from the right over a backdrop, over the
     whole viewport height (the status bar included), and the view keeps its centred width underneath. At md and up its
     width is the viewer's (pref paneWidth, one for both panels), clamped so it never covers the sidebar column, and the
     separator on its left edge resizes it; below md it is full width. The backdrop, Escape (App) or a panel's close button
     closes it; closed, it is invisible, so out of the tab order. The panel inside gets `focusTitle`, the attachment its
     title takes focus through on open. -->
<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import type { Attachment } from 'svelte/attachments';
  import { S, closeDrawer } from '../../lib/core/app.svelte.ts';
  import { t } from '../../lib/text/locale.ts';
  import { PANE_DEFAULT, PANE_MIN, clampPaneWidth, paneKey, paneMax } from '../../lib/jobs/drawer.ts';
  import { pref } from '../../lib/settings/prefs.ts';
  import { sidebarShown } from '../../lib/shell/sidebar.ts';

  let { open, label, children }: { open: boolean; label: string; children: Snippet<[Attachment<HTMLElement>]> } = $props();

  // ---------- the separator ----------
  // A saved width wider than the window shows clamped; the pref keeps it, so widening the window gives it back.
  // The drawer stops at the sidebar's current edge: the rail or the viewer's width.
  const gutter = $derived(sidebarShown(S.side));
  const width = $derived(clampPaneWidth(S.pane.width, S.pane.viewport, gutter));
  let drag: { x: number; w: number } | null = null;
  let dragging = $state(false);
  const save = (): void => pref.set('paneWidth', String(S.pane.width));
  function dragStart(e: PointerEvent & { currentTarget: HTMLElement }): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, w: width };
    dragging = true;
  }
  function dragMove(e: PointerEvent): void {
    // The separator is the drawer's left edge: moving left widens it.
    if (drag) S.pane.width = clampPaneWidth(drag.w + (drag.x - e.clientX), S.pane.viewport, gutter);
  }
  // Both pointerup and lostpointercapture end a drag (capture can be lost without a pointerup); the second call finds
  // drag null and returns, so the width is saved once.
  function dragEnd(): void {
    if (!drag) return;
    drag = null;
    dragging = false;
    save();
  }
  function sepKey(e: KeyboardEvent): void {
    const next = paneKey(width, e.key, e.shiftKey, S.pane.viewport, gutter);
    if (next === null) return;
    e.preventDefault();
    S.pane.width = next;
    save();
  }
  function sepReset(): void {
    S.pane.width = clampPaneWidth(PANE_DEFAULT, S.pane.viewport, gutter);
    save();
  }

  // The drawer covers the view, which App makes inert: focus moves to the panel's title once it renders, unless it is
  // already in the drawer. The attachment reads `open`, so it runs again on every open. App hands focus back to the opener on close.
  let pane = $state<HTMLElement>();
  const focusTitle: Attachment<HTMLElement> = (title) => {
    if (!open || !pane) return;
    const el = pane;
    if (!untrack(() => el.contains(document.activeElement))) title.focus();
  };
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (the backdrop, as on main; Escape closes the drawer from the keyboard) -->
<!-- Always mounted, so it fades both ways: closed, it is invisible and lets presses through. -->
<div id="drawer-backdrop" class="fixed inset-0 backdrop z-30 {open ? 'opacity-100 transition-[opacity] duration-(--motion-base) ease-(--ease-enter)' : 'opacity-0 invisible pointer-events-none transition-[opacity,visibility] duration-(--motion-quick) ease-(--ease-exit)'}" onclick={closeDrawer}></div>
<!-- A full-height column that never scrolls itself: each panel keeps its header put and scrolls inside. It runs to the
     viewport's bottom, over the status bar, which the backdrop dims like the rest of the page; the bottom inset keeps a
     panel's foot clear of a phone's home indicator. Opening slides it 24px in from the right as it fades in (base, easing
     out); closing slides and fades it out (quick, easing in); the reduced-motion block turns both off. Only a close
     transitions visibility, so it turns invisible at the end of the exit: on open it turns visible at once, as a transition
     would hold it hidden for the first frame and the title could not take focus. A drag drops the transition, so the width
     follows the pointer. -->
<aside
  bind:this={pane}
  id="drawer"
  aria-label={label}
  class="fixed right-0 top-0 bottom-0 pb-[env(safe-area-inset-bottom)] z-40 solid w-full flex flex-col overflow-hidden {open ? 'opacity-100 shadow-(--shadow-drawer)' : 'translate-x-6 opacity-0 invisible'} {dragging ? '' : open ? 'transition-[translate,opacity] duration-(--motion-base) ease-(--ease-enter)' : 'transition-[translate,opacity,visibility] duration-(--motion-quick) ease-(--ease-exit)'}"
  style={S.pane.md ? `width: ${width}px` : undefined}
>
  {#if S.pane.md && open}
    <!-- An 8px hit area over the drawer's left rule; the rule turns gleam while it is hovered, focused or dragged. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (a focusable separator with a value is a widget in ARIA: the window splitter pattern) -->
    <div
      role="separator"
      aria-orientation="vertical"
      aria-controls="drawer"
      aria-label={$t('drawer.resize')}
      aria-valuemin={PANE_MIN}
      aria-valuemax={paneMax(S.pane.viewport, gutter)}
      aria-valuenow={width}
      tabindex="0"
      class="group absolute inset-y-0 left-0 z-30 w-2 cursor-col-resize touch-none focus-visible:-outline-offset-2"
      onpointerdown={dragStart}
      onpointermove={dragMove}
      onpointerup={dragEnd}
      onlostpointercapture={dragEnd}
      onkeydown={sepKey}
      ondblclick={sepReset}
    ><span class="absolute inset-y-0 left-0 border-l {dragging ? 'border-gleam' : 'border-line group-hover:border-gleam group-focus-visible:border-gleam'}" aria-hidden="true"></span></div>
  {/if}
  {@render children(focusTitle)}
</aside>
