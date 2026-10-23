<!-- An icon-only button's visible name, in the dashboard's own style instead of the late native `title`. It shows on
     mouse hover after TIP_DELAY_MS and at once on keyboard focus (:focus-visible); touch never opens it. It hides on
     pointer leave, focus leaving, Escape (never swallowed, so the drawer's and popovers' own Escape still runs), a press,
     a scroll or resize, `off`, and unmounting. It sits in the top layer (popover="manual", as MenuButton's panel), so no
     drawer, popover body or scroller clips it; src/lib/tooltip.ts placeTip decides where. The button carries the name
     (aria-label) and the hint (aria-describedby), so the tip itself is aria-hidden. Text renders through {…} only. -->
<script lang="ts">
  import { TIP_DELAY_MS, placeTip } from '../lib/tooltip.ts';

  let { anchor, text, hint = null, off = false }: { anchor: HTMLElement | undefined; text: string; hint?: string | null; off?: boolean } = $props();

  let tip = $state<HTMLDivElement>();
  let shown = $state(false);
  let at = $state<{ left: number; top: number }>({ left: 0, top: 0 });
  let timer: ReturnType<typeof setTimeout> | undefined;

  function show(): void {
    clearTimeout(timer);
    timer = undefined;
    if (off || shown || !tip || !anchor) return;
    tip.showPopover();
    shown = true;
    place();
  }

  function place(): void {
    if (!tip || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const p = tip.getBoundingClientRect();
    at = placeTip({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: document.documentElement.clientWidth, vh: window.innerHeight, width: p.width, height: p.height });
  }

  function hide(): void {
    clearTimeout(timer);
    timer = undefined;
    if (!shown) return;
    shown = false;
    if (tip?.matches(':popover-open')) tip.hidePopover();
  }

  $effect(() => {
    const el = anchor;
    if (!el) return;
    const enter = (e: PointerEvent): void => {
      if (e.pointerType === 'touch' || shown) return;
      clearTimeout(timer);
      timer = setTimeout(show, TIP_DELAY_MS);
    };
    const focusIn = (e: FocusEvent): void => {
      if (e.target instanceof Element && e.target.matches(':focus-visible')) show();
    };
    const focusOut = (e: FocusEvent): void => {
      if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
      hide();
    };
    el.addEventListener('pointerenter', enter);
    el.addEventListener('pointerleave', hide);
    el.addEventListener('focusin', focusIn);
    el.addEventListener('focusout', focusOut);
    el.addEventListener('pointerdown', hide);
    return () => {
      el.removeEventListener('pointerenter', enter);
      el.removeEventListener('pointerleave', hide);
      el.removeEventListener('focusin', focusIn);
      el.removeEventListener('focusout', focusOut);
      el.removeEventListener('pointerdown', hide);
      hide();
    };
  });

  // Listeners live only while the tip shows. Escape is heard on the document, so it hides a hover tip too.
  $effect(() => {
    if (!shown) return;
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hide();
    };
    document.addEventListener('keydown', key, true);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  });

  $effect(() => {
    if (off) hide();
  });

  // A label or hint that changes while shown (a Start/Stop toggle flipping) changes the tip's size.
  $effect(() => {
    void text;
    void hint;
    if (shown) place();
  });

  // Unmounting takes the tip out of the top layer with it.
  $effect(() => () => {
    clearTimeout(timer);
    if (tip?.matches(':popover-open')) tip.hidePopover();
  });
</script>

<div
  bind:this={tip}
  popover="manual"
  aria-hidden="true"
  class="plate solid tip-fade fixed inset-auto m-0 px-2 py-1 text-xs text-fg pointer-events-none shadow-(--shadow-overlay) max-w-[min(20rem,calc(100vw_-_16px))]"
  style="left: {at.left}px; top: {at.top}px"
>{text}{#if hint}<span class="block text-muted">{hint}</span>{/if}</div>
