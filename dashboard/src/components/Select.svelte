<!-- The dashboard's choice field, in place of a native <select>, whose OS menu ignores the Smithy look and the themes.
     A select-only combobox (WAI-ARIA APG): a field-styled button controls a listbox that opens in the top layer
     (popover="manual"), so the drawer, the settings dialog and overflow-hidden parents never clip it. Focus never leaves
     the button and aria-activedescendant names the active option, so the settings focus trap and the drawer's focus
     handling see one control. lib/select.ts decides what each key does, lib/menu.ts placeMenu where the list opens, and
     dismissal follows MenuButton: Escape closes only the list, a press outside, focus leaving, a resize, a scroll that
     moves the button or unmounting close it without a change. -->
<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { CLOSED, selectKey, selectedIndex, openAt, type SelectOption, type SelectState } from '../lib/select.ts';
  import { placeMenu } from '../lib/menu.ts';
  import { FOCUSABLE, dismissal } from '../lib/popover.ts';
  import { t } from '../lib/locale.ts';

  let {
    id,
    value = $bindable(''),
    options,
    onchange,
    label,
    labelledby,
    describedby,
    invalid = false,
    disabled = false,
    class: cls = '',
  }: {
    id?: string;
    value?: string;
    options: readonly SelectOption[];
    onchange?: (value: string) => void;
    label?: string;
    labelledby?: string;
    describedby?: string;
    invalid?: boolean;
    disabled?: boolean;
    class?: string;
  } = $props();

  const uid = $props.id();
  const listId = `${uid}-list`;
  const optId = (i: number): string => `${uid}-opt-${i}`;

  let trigger = $state<HTMLButtonElement>();
  let list = $state<HTMLUListElement>();
  // Raw: lib/select.ts returns the state it was given for a key it ignores, and a proxy would never compare equal to it.
  let st = $state.raw<SelectState>(CLOSED);
  let at = $state<{ left: number; top: number }>({ left: 0, top: 0 });
  let minWidth = $state(0);
  // Space chooses on keydown; the button's own Space activation (a click on keyup) must not reopen the list.
  let swallowClick = false;

  const selected = $derived(selectedIndex(options, value));
  const sel = $derived(selected >= 0 ? options[selected] : undefined);
  const activeId = $derived(st.open && st.active >= 0 ? optId(st.active) : undefined);

  const within = (n: Node | null): boolean => n !== null && Boolean(list?.contains(n) || trigger?.contains(n));

  async function apply(next: SelectState): Promise<void> {
    const was = st.open;
    st = next;
    if (next.open && !was) await show();
    else if (!next.open && was && list?.matches(':popover-open')) list.hidePopover();
    if (next.open) {
      await tick();
      if (next.active >= 0) list?.children[next.active]?.scrollIntoView({ block: 'nearest' });
    }
  }

  async function show(): Promise<void> {
    if (!list || !trigger) return;
    minWidth = trigger.getBoundingClientRect().width;
    list.showPopover();
    await tick();
    place();
  }

  function place(): void {
    if (!list || !trigger) return;
    const r = trigger.getBoundingClientRect();
    const p = list.getBoundingClientRect();
    at = placeMenu({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, align: 'start', vw: document.documentElement.clientWidth, vh: window.innerHeight, width: p.width, height: p.height });
  }

  function close(refocus: boolean): void {
    if (!st.open) return;
    void apply(CLOSED);
    if (refocus) trigger?.focus();
  }

  function choose(i: number): void {
    const o = options[i];
    if (!o || o.disabled || o.value === value) return;
    value = o.value;
    onchange?.(o.value);
  }

  function key(e: KeyboardEvent): void {
    if (disabled) return;
    const step = selectKey(st, e, options, selected, performance.now());
    if (step.handled) {
      e.preventDefault();
      if (e.key === 'Escape') e.stopPropagation();
      if (e.key === ' ') swallowClick = true;
    }
    if (step.commit !== null) choose(step.commit);
    if (step.state !== st) void apply(step.state);
  }

  function keyUp(e: KeyboardEvent): void {
    if (e.key === ' ') setTimeout(() => (swallowClick = false));
  }

  function click(): void {
    if (swallowClick) return;
    if (st.open) close(true);
    else void apply({ ...CLOSED, open: true, active: openAt(options, selected) });
  }

  function pick(i: number): void {
    if (options[i]?.disabled) return;
    choose(i);
    close(true);
  }

  function hover(i: number): void {
    if (!options[i]?.disabled && st.active !== i) st = { ...st, active: i };
  }

  function focusOut(e: FocusEvent): void {
    const to = e.relatedTarget instanceof Node ? e.relatedTarget : null;
    // No relatedTarget (Safari's clicked buttons, a window switch) is not leaving.
    if (to !== null && !within(to)) close(dismissal('focusout', { relatedInside: false }).refocus);
  }

  $effect(() => {
    if (disabled && st.open) close(false);
  });

  // Listeners live only while open.
  $effect(() => {
    if (!st.open) return;
    // Capture phase, so a control that stops the event still counts as outside.
    const down = (e: PointerEvent): void => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target || within(target)) return;
      close(dismissal('outside', { targetFocusable: target.closest(FOCUSABLE) !== null }).refocus);
    };
    // Only a scroll that moves the button; the list scrolling itself does not.
    const scroll = (e: Event): void => {
      const target = e.target;
      if (target instanceof Node && list?.contains(target)) return;
      if (target === document || (target instanceof Node && target.contains(trigger ?? null))) close(false);
    };
    const resize = (): void => close(false);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
    };
  });

  // Unmounting (a tab switch, the drawer re-keyed) takes the list out of the top layer with it.
  $effect(() => () => {
    if (list?.matches(':popover-open')) list.hidePopover();
  });
</script>

<button
  bind:this={trigger}
  {id}
  type="button"
  role="combobox"
  aria-haspopup="listbox"
  aria-expanded={st.open}
  aria-controls={listId}
  aria-activedescendant={activeId}
  aria-invalid={invalid ? 'true' : undefined}
  aria-describedby={describedby}
  aria-label={label}
  aria-labelledby={labelledby}
  {disabled}
  class="input inline-flex items-center justify-between gap-2 text-left {cls}"
  onclick={click}
  onkeydown={key}
  onkeyup={keyUp}
  onfocusout={focusOut}
><span class={sel ? 'truncate' : 'truncate text-muted'} lang={sel?.lang}>{sel?.label ?? $t('select.choose')}</span><Icon name="chevron-down" class="shrink-0" /></button>
<!-- svelte-ignore a11y_click_events_have_key_events (focus stays on the combobox button, which chooses options from the keyboard; mousedown is cancelled so a press never moves focus here) -->
<ul
  bind:this={list}
  id={listId}
  popover="manual"
  role="listbox"
  aria-label={label}
  aria-labelledby={labelledby}
  tabindex="-1"
  class="plate solid fixed inset-auto m-0 p-1 text-fg hidden open:flex flex-col max-w-[calc(100vw_-_16px)] max-h-[min(20rem,calc(100dvh_-_16px))] overflow-y-auto overscroll-contain text-sm shadow-(--shadow-overlay)"
  style="left: {at.left}px; top: {at.top}px; min-width: {minWidth}px"
  onmousedown={(e) => e.preventDefault()}
>
  {#each options as o, i (i)}
    <li
      id={optId(i)}
      role="option"
      aria-selected={i === selected}
      aria-disabled={o.disabled ? 'true' : undefined}
      lang={o.lang}
      class="flex items-center gap-2 px-3 py-1.5 cursor-pointer {i === st.active ? 'bg-raised text-fg shadow-[inset_var(--bar-rule)_0_0_0_var(--gleam)]' : 'text-muted'} {o.disabled ? 'opacity-40 cursor-not-allowed' : ''}"
      onmousemove={() => hover(i)}
      onclick={() => pick(i)}
    >
      {#if i === selected}<Icon name="check" class="shrink-0" />{:else}<span class="ic shrink-0" aria-hidden="true"></span>{/if}<span class="truncate">{o.label}</span>
    </li>
  {/each}
</ul>
