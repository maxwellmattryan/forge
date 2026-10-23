<!-- A status bar popover: a non-modal dialog that sits --space-1 above the bar, anchored to its indicator at md and up and
     spanning the viewport less 16px on phones. It takes focus when it opens, and closes on a press outside or when focus
     leaves it (src/lib/popover.ts decides where focus goes). Tab moves through it as if it sat right after its indicator.
     It holds no live region: StatusBar has the one. The chat size (the Foreman's thread) has a fixed height, and its content
     fills the body instead of growing it, so the session log inside is the one scroller and its follow-to-bottom keeps
     working (the body scrolls only when the room is too short for the log's own header). Every other size is capped at
     40rem (or the room above the bar, when that is less) and scrolls inside, so none comes near full screen on a desktop. -->
<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import CloseButton from './CloseButton.svelte';
  import { FOCUSABLE, POPOVER_WIDTH, TAB_STOPS, placePopover, type PopoverId, type PopoverSize } from '../lib/popover.ts';
  import { closePopover, keepFocus } from '../lib/popover.svelte.ts';
  import { EXIT, fade, rise, settled } from '../lib/motion.ts';
  import { S } from '../lib/app.svelte.ts';
  import { t } from '../lib/locale.ts';

  let { id, title, anchor, align, size = 'normal', accent, children }: { id: PopoverId; title: string; anchor: HTMLElement; align: 'start' | 'end'; size?: PopoverSize; accent?: 'foreman'; children: Snippet } = $props();
  const chat = $derived(size === 'chat');
  // A popover opened before the dashboard settles (#/inbox at load) snaps open: no rise, no gleam edge. Read once at mount.
  const ready = (): number | null => S.readyAt;
  const edge = settled(Date.now(), S.readyAt);
  // While it fades out it stays in the DOM with its listeners: switching popovers mounts the next one meanwhile, and a
  // leaving popover must never close (or steal focus from) the one replacing it.
  let leaving = false;

  let el = $state<HTMLDivElement>();
  let body = $state<HTMLDivElement>();
  let content = $state<HTMLDivElement>();
  let scrollable = $state(false);
  const md = (): boolean => matchMedia('(width >= 48rem)').matches;
  let viewport = $state(document.documentElement.clientWidth);
  let narrow = $state(!md());
  // Follows the window's width and the anchor: a cleared hold hands the Daemon popover back to the Daemon button. The anchor
  // prop reads the popover state, so it is briefly null while a closing popover unmounts.
  const place = $derived.by(() => {
    const r = anchor ? anchor.getBoundingClientRect() : { left: 0, right: 0 };
    return placePopover({ triggerLeft: r.left, triggerRight: r.right, viewport, width: POPOVER_WIDTH[size], align, narrow });
  });

  function measure(): void {
    viewport = document.documentElement.clientWidth;
    narrow = !md();
  }

  const within = (n: Node): boolean => Boolean(el?.contains(n) || anchor?.contains(n));
  const shown = (x: HTMLElement): boolean => x.getClientRects().length > 0;

  // Capture phase, so a control that stops the event still counts as outside.
  function down(e: PointerEvent): void {
    const target = e.target instanceof Element ? e.target : null;
    if (leaving || !target || within(target)) return;
    closePopover('outside', { targetFocusable: target.closest(FOCUSABLE) !== null });
  }

  function focusOut(e: FocusEvent): void {
    if (leaving) return;
    const to = e.relatedTarget instanceof Node ? e.relatedTarget : null;
    closePopover('focusout', { relatedInside: to === null ? null : within(to) });
    // No relatedTarget: a control that disabled itself or went away dropped focus to the body.
    if (to === null) keepFocus();
  }

  // Tab past the page's last control leaves the document (a focusout with no relatedTarget, which closes nothing); focus
  // that later lands outside closes it then.
  function focusIn(e: FocusEvent): void {
    if (!leaving && e.target instanceof Node && !within(e.target)) closePopover('focusout', { relatedInside: false });
  }

  // The popover follows the bar in the DOM. Shift+Tab before its first stop goes back to its indicator, and Tab past its
  // last goes on to what follows the indicator, as if the popover sat right after it.
  function key(e: KeyboardEvent): void {
    if (leaving || e.key !== 'Tab' || e.defaultPrevented || !el) return;
    const items = [...el.querySelectorAll<HTMLElement>(TAB_STOPS)].filter(shown);
    const at = document.activeElement;
    if (e.shiftKey) {
      if (at === el || at === items[0]) {
        e.preventDefault();
        closePopover('close');
      }
      return;
    }
    if (at !== (items.at(-1) ?? el)) return;
    e.preventDefault();
    const box = el;
    // Read before closing: the anchor prop follows the popover state, which closing clears.
    const back = anchor;
    const next = [...document.querySelectorAll<HTMLElement>(TAB_STOPS)].find((x) => shown(x) && !box.contains(x) && (back.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    closePopover('focusout', { relatedInside: false });
    // Nothing follows the indicator (the last one, with no drawer or toast): back to the indicator, never the body.
    (next ?? back).focus();
  }

  // A body that scrolls with no control in reach takes focus itself, so the keyboard can scroll it in every browser.
  $effect(() => {
    if (!body || !content) return;
    const b = body;
    const ro = new ResizeObserver(() => (scrollable = b.scrollHeight > b.clientHeight + 1));
    ro.observe(b);
    ro.observe(content);
    return () => ro.disconnect();
  });

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
  in:rise|global={{ ready }}
  out:fade|global={EXIT}
  onoutrostart={() => (leaving = true)}
  class="plate solid fixed z-42 flex flex-col {edge ? 'shutter-edge' : ''} bottom-[calc(var(--size-statusbar)_+_env(safe-area-inset-bottom)_+_var(--space-1))] shadow-(--shadow-overlay) {chat ? 'max-h-[calc(100dvh_-_var(--size-statusbar)_-_env(safe-area-inset-bottom)_-_2rem)]' : 'max-h-[min(40rem,calc(100dvh_-_var(--size-statusbar)_-_env(safe-area-inset-bottom)_-_2rem))]'} {chat ? 'h-[min(48rem,calc(100dvh_-_var(--size-statusbar)_-_env(safe-area-inset-bottom)_-_2rem))]' : ''}"
  style="left: {place.left}px; width: {place.width}px"
  onfocusout={focusOut}
  onkeydown={key}
>
  <div class="flex shrink-0 items-center justify-between gap-3 border-b py-1.5 pr-1.5 pl-4 {accent === 'foreman' ? 'foreman shadow-[inset_var(--bar-rule)_0_0_0_var(--gleam)]' : 'border-line'}">
    <h2 id="popover-{id}-title" class="h section min-w-0 truncate">{title}</h2>
    <CloseButton size="sm" label={$t('statusbar.close')} onclick={() => closePopover('close')} />
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (only while it scrolls with no control in reach: WCAG 2.1.1 needs a keyboard way to scroll it) -->
  <div
    bind:this={body}
    role={scrollable ? 'region' : undefined}
    aria-labelledby={scrollable ? `popover-${id}-title` : undefined}
    tabindex={scrollable ? 0 : undefined}
    class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 focus-visible:-outline-offset-2 {chat ? 'flex flex-col' : ''}"
  >
    <div bind:this={content} class={chat ? 'flex min-h-0 flex-1 flex-col' : undefined}>{@render children()}</div>
  </div>
</div>
