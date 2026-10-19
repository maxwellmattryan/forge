<!-- A small button that opens a non-modal dialog under it: the session log's Permissions, Effort and Filter controls.
     The panel opens in the top layer (popover="manual"), so no scrolling or overflow-hidden ancestor (the drawer, the
     Foreman popover's body, the Agents tab panel) clips it, while staying a DOM descendant of them, so their own
     contains() checks still count it as inside. Manual mode keeps dismissal here instead of the browser's light dismiss,
     which would race App's window Escape handler: Escape closes only this panel and refocuses the button; a press outside
     or focus leaving both closes it (lib/popover.ts dismissal decides the focus); a resize, a scroll that moves the button,
     or the button unmounting closes it too. lib/menu.ts placeMenu decides where it opens. -->
<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import type { IconName } from '../lib/icons.ts';
  import { placeMenu } from '../lib/menu.ts';
  import { FOCUSABLE, dismissal } from '../lib/popover.ts';

  let {
    label,
    title,
    icon,
    text,
    iconOnly = false,
    badge = false,
    extraTitle,
    children,
  }: { label: string; title: string; icon?: IconName; text?: string; iconOnly?: boolean; badge?: boolean; extraTitle?: string; children: Snippet } = $props();

  const uid = $props.id();
  const panelId = `${uid}-menu`;
  const titleId = `${uid}-title`;

  let trigger = $state<HTMLButtonElement>();
  let panel = $state<HTMLDivElement>();
  let open = $state(false);
  let at = $state<{ left: number; top: number }>({ left: 0, top: 0 });

  const within = (n: Node | null): boolean => n !== null && Boolean(panel?.contains(n) || trigger?.contains(n));

  async function show(): Promise<void> {
    if (!panel || !trigger || open) return;
    panel.showPopover();
    open = true;
    place();
    await tick();
    // The checked radio of a choice, else the first enabled field (the filter's search), else the panel itself.
    const first = panel.querySelector<HTMLElement>('input[type="radio"]:checked:not(:disabled)') ?? panel.querySelector<HTMLElement>('input:not(:disabled)');
    (first ?? panel).focus();
  }

  function place(): void {
    if (!panel || !trigger) return;
    const r = trigger.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    at = placeMenu({ top: r.top, bottom: r.bottom, right: r.right, vw: document.documentElement.clientWidth, vh: window.innerHeight, width: p.width, height: p.height });
  }

  function hide(refocus: boolean): void {
    if (!open) return;
    open = false;
    if (panel?.matches(':popover-open')) panel.hidePopover();
    if (refocus) trigger?.focus();
  }

  function key(e: KeyboardEvent): void {
    if (!open || e.key !== 'Escape' || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    hide(dismissal('escape').refocus);
  }

  function focusOut(e: FocusEvent): void {
    const to = e.relatedTarget instanceof Node ? e.relatedTarget : null;
    // No relatedTarget (Safari's clicked buttons, a control that disabled itself) is not leaving.
    if (to !== null && !within(to)) hide(dismissal('focusout', { relatedInside: false }).refocus);
  }

  // Listeners live only while open, so a closed menu costs nothing on a busy log.
  $effect(() => {
    if (!open) return;
    // Capture phase, so a control that stops the event still counts as outside.
    const down = (e: PointerEvent): void => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target || within(target)) return;
      hide(dismissal('outside', { targetFocusable: target.closest(FOCUSABLE) !== null }).refocus);
    };
    // Only a scroll that moves the button: the log pane beside it scrolls on every new line while following.
    const scroll = (e: Event): void => {
      const target = e.target;
      if (target instanceof Node && panel?.contains(target)) return;
      if (target === document || (target instanceof Node && target.contains(trigger ?? null))) hide(false);
    };
    const resize = (): void => hide(false);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
    };
  });

  // Unmounting (a tab switch, the drawer re-keyed) takes the panel out of the top layer with it.
  $effect(() => () => {
    if (panel?.matches(':popover-open')) panel.hidePopover();
  });
</script>

<button
  bind:this={trigger}
  type="button"
  class="btn sm {iconOnly ? 'icon' : ''}"
  aria-label={label}
  title={extraTitle ? `${label}. ${extraTitle}` : label}
  aria-haspopup="dialog"
  aria-expanded={open}
  aria-controls={panelId}
  onclick={() => (open ? hide(false) : show())}
  onkeydown={key}
  onfocusout={focusOut}
>{#if icon}<Icon name={icon} />{/if}{#if !iconOnly && text}<span>{text}</span>{/if}{#if badge}<span class="dot spark absolute -top-1 -right-1 size-2" aria-hidden="true"></span>{/if}</button>
<div
  bind:this={panel}
  id={panelId}
  popover="manual"
  role="dialog"
  aria-labelledby={titleId}
  tabindex="-1"
  class="plate solid fixed inset-auto m-0 p-0 text-fg hidden open:flex flex-col w-[min(16rem,calc(100vw_-_16px))] max-h-[calc(100dvh_-_16px)] shadow-(--shadow-overlay)"
  style="left: {at.left}px; top: {at.top}px"
  onkeydown={key}
  onfocusout={focusOut}
>
  <div class="flex shrink-0 items-center border-b border-line px-3 py-1.5"><h2 id={titleId} class="h section min-w-0 truncate">{title}</h2></div>
  <div class="min-h-0 overflow-y-auto overscroll-contain p-3 flex flex-col gap-3 text-xs">{@render children()}</div>
</div>
