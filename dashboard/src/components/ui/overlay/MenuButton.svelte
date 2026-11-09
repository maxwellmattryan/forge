<!-- A small button that opens a non-modal dialog under it: the session log's Filter control. With `items` it opens a
     role="menu" instead (a mandate plate's ⋯): no title bar, one role="menuitem" button per item, focus on the first
     when it opens, ArrowUp/ArrowDown wrapping and Home/End (src/lib/ui/overlay/menu.ts menuMove); a disabled item keeps
     focus and announces its hint (aria-disabled, aria-describedby) but does nothing, and choosing an enabled one closes
     the menu, then calls `onselect` with its id. The panel opens in the top layer (popover="manual"), so no scrolling
     or overflow-hidden ancestor (the drawer, the Foreman popover's body, the Agents tab panel) clips it, while staying a DOM descendant of them, so their own
     contains() checks still count it as inside. Manual mode keeps dismissal here instead of the browser's light dismiss,
     which would race App's window Escape handler: Escape closes only this panel and refocuses the button; a press outside
     or focus leaving both closes it (src/lib/ui/overlay/popover.ts dismissal decides the focus); a resize, a scroll that moves the button,
     or the button unmounting closes it too. src/lib/ui/overlay/menu.ts placeMenu decides where it opens. With `iconOnly` the button's
     name shows in a Tooltip (hidden while the panel is open) instead of a native title. -->
<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import Icon from '../Icon.svelte';
  import Tooltip from './Tooltip.svelte';
  import type { IconName } from '../../../lib/ui/icons.ts';
  import { menuMove, placeMenu, type MenuItem } from '../../../lib/ui/overlay/menu.ts';
  import { FOCUSABLE, dismissal } from '../../../lib/ui/overlay/popover.ts';

  let {
    id,
    label,
    title,
    icon,
    text,
    iconOnly = false,
    badge = false,
    extraTitle,
    items,
    onselect,
    children,
  }: {
    id?: string;
    label: string;
    title: string;
    icon?: IconName;
    text?: string;
    iconOnly?: boolean;
    badge?: boolean;
    extraTitle?: string;
    items?: readonly MenuItem[];
    onselect?: (id: string) => void;
    children?: Snippet;
  } = $props();

  const uid = $props.id();
  const panelId = `${uid}-menu`;
  const titleId = `${uid}-title`;

  let trigger = $state<HTMLButtonElement>();
  let panel = $state<HTMLDivElement>();
  let open = $state(false);
  let at = $state<{ left: number; top: number }>({ left: 0, top: 0 });
  // menu-pop grows from the edge nearest the trigger: the panel's right edge meets the trigger's, above or below it.
  let origin = $state('top right');

  const within = (n: Node | null): boolean => n !== null && Boolean(panel?.contains(n) || trigger?.contains(n));

  async function show(): Promise<void> {
    if (!panel || !trigger || open) return;
    panel.showPopover();
    open = true;
    place();
    await tick();
    // A menu's first item; else the first enabled field (the filter's search), else the panel itself.
    (panel.querySelector<HTMLElement>(items ? '[role="menuitem"]' : 'input:not(:disabled)') ?? panel).focus();
  }

  function choose(item: MenuItem): void {
    if (item.disabled) return;
    hide(false);
    onselect?.(item.id);
  }

  function menuKey(e: KeyboardEvent): void {
    if (!items || !panel || e.isComposing) return;
    const buttons = [...panel.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = buttons.findIndex((b) => b === document.activeElement);
    // From the panel itself, ArrowDown lands on the first item and ArrowUp on the last.
    const to = menuMove(buttons.length, at < 0 ? (e.key === 'ArrowUp' ? 0 : -1) : at, e.key);
    if (to < 0) return;
    e.preventDefault();
    buttons[to]?.focus();
  }

  function panelKey(e: KeyboardEvent): void {
    key(e);
    if (!e.defaultPrevented) menuKey(e);
  }

  function place(): void {
    if (!panel || !trigger) return;
    const r = trigger.getBoundingClientRect();
    // Offset sizes: menu-pop opens at scale .96, which would shrink a bounding rect and misplace a menu that opens above.
    at = placeMenu({ top: r.top, bottom: r.bottom, right: r.right, vw: document.documentElement.clientWidth, vh: window.innerHeight, width: panel.offsetWidth, height: panel.offsetHeight });
    origin = at.top < r.top ? 'bottom right' : 'top right';
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
  {id}
  type="button"
  class="btn sm {iconOnly ? 'icon' : ''}"
  aria-label={label}
  title={iconOnly ? undefined : extraTitle ? `${label}. ${extraTitle}` : label}
  aria-haspopup={items ? 'menu' : 'dialog'}
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
  role={items ? 'menu' : 'dialog'}
  aria-label={items ? title : undefined}
  aria-labelledby={items ? undefined : titleId}
  tabindex="-1"
  class="plate solid menu-pop fixed inset-auto m-0 p-0 text-fg hidden open:flex flex-col w-[min(16rem,calc(100vw_-_16px))] max-h-[calc(100dvh_-_16px)] shadow-(--shadow-overlay)"
  style="left: {at.left}px; top: {at.top}px; transform-origin: {origin}"
  onkeydown={panelKey}
  onfocusout={focusOut}
>
  {#if items}
    <div class="min-h-0 overflow-y-auto overscroll-contain p-1 flex flex-col text-[13px]">
      {#each items as item, i (item.id)}
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          class="flex flex-col items-start gap-0.5 px-2 py-1.5 text-left hover:bg-raised focus-visible:bg-raised {item.danger ? 'text-bad' : 'text-fg'} {item.disabled ? 'opacity-40 cursor-default' : ''} {item.separator ? 'mt-1 border-t border-line-soft' : ''}"
          aria-disabled={item.disabled ? 'true' : undefined}
          aria-describedby={item.hint ? `${uid}-hint-${i}` : undefined}
          onclick={() => choose(item)}
        ><span>{item.label}</span>{#if item.hint}<span id="{uid}-hint-{i}" class="text-xs text-muted">{item.hint}</span>{/if}</button>
      {/each}
    </div>
  {:else}
    <div class="flex shrink-0 items-center border-b border-line px-3 py-1.5"><h2 id={titleId} class="h section min-w-0 truncate">{title}</h2></div>
    <div class="min-h-0 overflow-y-auto overscroll-contain p-3 flex flex-col gap-3 text-xs">{@render children?.()}</div>
  {/if}
</div>
{#if iconOnly}<Tooltip anchor={trigger} text={label} off={open} />{/if}
