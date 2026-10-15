<!-- A status bar popover: a non-modal dialog that sits --space-2 above the bar, anchored to its indicator at md and up and
     spanning the viewport less 16px on phones. It takes focus when it opens, and closes on a press outside or when focus
     leaves it (lib/popover.ts decides where focus goes). It holds no live region: StatusBar has the one. -->
<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import CloseButton from './CloseButton.svelte';
  import { TABBABLE, placePopover, type PopoverId } from '../lib/popover.ts';
  import { closePopover } from '../lib/popover.svelte.ts';
  import { t } from '../lib/locale.ts';

  let { id, title, anchor, align, wide = false, children }: { id: PopoverId; title: string; anchor: HTMLElement; align: 'start' | 'end'; wide?: boolean; children: Snippet } = $props();

  let el = $state<HTMLDivElement>();
  const md = (): boolean => matchMedia('(width >= 48rem)').matches;
  let viewport = $state(document.documentElement.clientWidth);
  let narrow = $state(!md());
  // Recomputed when the window resizes, and when another indicator of the same popover (Held for Daemon) takes it over.
  const place = $derived.by(() => {
    const r = anchor.getBoundingClientRect();
    return placePopover({ triggerLeft: r.left, triggerRight: r.right, viewport, width: wide ? 560 : 400, align, narrow });
  });

  function measure(): void {
    viewport = document.documentElement.clientWidth;
    narrow = !md();
  }

  const within = (n: Node): boolean => Boolean(el?.contains(n) || anchor.contains(n));

  // Capture phase, so a control that stops the event still counts as outside.
  function down(e: PointerEvent): void {
    const target = e.target instanceof Element ? e.target : null;
    if (!target || within(target)) return;
    closePopover('outside', { targetFocusable: target.closest(TABBABLE) !== null });
  }

  function focusOut(e: FocusEvent): void {
    const to = e.relatedTarget instanceof Node ? e.relatedTarget : null;
    closePopover('focusout', { relatedInside: to === null ? null : within(to) });
  }

  // Tab past the page's last control leaves the document (a focusout with no relatedTarget, which closes nothing); focus
  // that later lands outside closes it then.
  function focusIn(e: FocusEvent): void {
    if (e.target instanceof Node && !within(e.target)) closePopover('focusout', { relatedInside: false });
  }

  onMount(() => {
    el?.focus();
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('focusin', focusIn, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('focusin', focusIn, true);
    };
  });
</script>

<svelte:window onresize={measure} />

<div
  bind:this={el}
  id="popover-{id}"
  role="dialog"
  aria-labelledby="popover-{id}-title"
  tabindex="-1"
  class="sheet ticks solid fixed z-42 flex flex-col bottom-[calc(var(--size-statusbar)_+_env(safe-area-inset-bottom)_+_var(--space-2))] max-h-[calc(100dvh_-_var(--size-statusbar)_-_env(safe-area-inset-bottom)_-_2rem)] shadow-(--shadow-dialog)"
  style="left: {place.left}px; width: {place.width}px"
  onfocusout={focusOut}
>
  <span class="tk"></span>
  <div class="flex shrink-0 items-center justify-between gap-3 border-b border-line py-1.5 pr-1.5 pl-4">
    <h2 id="popover-{id}-title" class="h section min-w-0 truncate">{title}</h2>
    <CloseButton size="sm" label={$t('statusbar.close')} onclick={() => closePopover('close')} />
  </div>
  <div class="min-h-0 flex-1 overflow-y-auto p-4">{@render children()}</div>
</div>
