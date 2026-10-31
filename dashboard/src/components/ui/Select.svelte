<!-- The dashboard's single-choice dropdown, in place of a native <select>, whose OS menu ignores the Smithy look and the
     themes. A select-only combobox (WAI-ARIA APG): a field-styled button (or, with variant="button", a small toolbar
     button) controls a listbox that opens in the top layer (popover="manual"), so the drawer, the settings dialog and
     overflow-hidden parents never clip it. The list is a compact menu panel that fades and grows from the trigger edge it
     opened against (`menu-pop` in style.css); its first and last rows follow the plate's cut corners (`menu-list`).
     Entries are dense rows: a check column, then the label with an optional icon, hint line and an option `badge` (an
     ember dot after the label), or the caller's `entry` snippet; `separator` rules an entry off and consecutive entries
     of one `group` sit under its name; an `action` entry calls onchange but never becomes the value, and
     its icon takes the check column it never needs, so its label lines up with the others'. Focus never leaves the
     button and aria-activedescendant names the active option, so the settings focus trap and the drawer's focus handling
     see one control. src/lib/ui/select.ts decides what each key does, src/lib/ui/overlay/menu.ts placeMenu where the list opens, and
     dismissal follows MenuButton: Escape closes only the list, a press outside, focus leaving, a resize, a scroll that
     moves the button or unmounting close it without a change. The exported toggle() opens or closes the list from outside
     (a keyboard shortcut) along the click's own path, and `keyshortcuts` names that shortcut in aria-keyshortcuts. -->
<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import type { IconName } from '../../lib/ui/icons.ts';
  import { CLOSED, selectKey, selectedIndex, openAt, type SelectOption, type SelectState } from '../../lib/ui/select.ts';
  import { placeMenu } from '../../lib/ui/overlay/menu.ts';
  import { FOCUSABLE, dismissal } from '../../lib/ui/overlay/popover.ts';
  import { t } from '../../lib/text/locale.ts';

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
    entry,
    variant = 'field',
    icon,
    text,
    placeholder,
    title,
    keyshortcuts,
    badge = false,
    badgeTone = 'spark',
    align = 'start',
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
    /** Renders every entry's content after the check column, in place of the icon, label and hint. */
    entry?: Snippet<[SelectOption, number]>;
    variant?: 'field' | 'button';
    /** The button variant's leading icon. */
    icon?: IconName;
    /** The trigger's text in place of the chosen entry's label. */
    text?: string;
    /** The muted trigger text while no entry is chosen, in place of the generic "Choose…". */
    placeholder?: string;
    title?: string;
    /** The trigger's `aria-keyshortcuts`: a shortcut elsewhere that calls toggle(). */
    keyshortcuts?: string;
    /** A dot on the trigger: the button variant's corner dot, as MenuButton's, or the field variant's dot before the chevron. */
    badge?: boolean;
    /** The trigger dot's colour: spark (the default), or ember for something waiting on you. */
    badgeTone?: 'spark' | 'ember';
    align?: 'start' | 'end';
    class?: string;
  } = $props();

  const uid = $props.id();
  const listId = `${uid}-list`;
  const optId = (i: number): string => `${uid}-opt-${i}`;
  const groupId = (r: number): string => `${uid}-grp-${r}`;

  let trigger = $state<HTMLButtonElement>();
  let list = $state<HTMLUListElement>();
  // Raw: src/lib/ui/select.ts returns the state it was given for a key it ignores, and a proxy would never compare equal to it.
  let st = $state.raw<SelectState>(CLOSED);
  let at = $state<{ left: number; top: number }>({ left: 0, top: 0 });
  let minWidth = $state(0);
  let origin = $state('top left');
  // Space chooses on keydown; the button's own Space activation (a click on keyup) must not reopen the list.
  let swallowClick = false;

  const selected = $derived(selectedIndex(options, value));
  const sel = $derived(selected >= 0 ? options[selected] : undefined);
  const activeId = $derived(st.open && st.active >= 0 ? optId(st.active) : undefined);
  /** Runs of options: a run of one defined group renders under its name; ungrouped options render as they are. Indices stay flat. */
  const runs = $derived.by(() => {
    const out: { group: string | undefined; start: number; count: number }[] = [];
    options.forEach((o, i) => {
      const last = out.at(-1);
      if (last && last.group === o.group) last.count++;
      else out.push({ group: o.group, start: i, count: 1 });
    });
    return out;
  });

  const within = (n: Node | null): boolean => n !== null && Boolean(list?.contains(n) || trigger?.contains(n));

  async function apply(next: SelectState): Promise<void> {
    const was = st.open;
    st = next;
    if (next.open && !was) await show();
    else if (!next.open && was && list?.matches(':popover-open')) list.hidePopover();
    if (next.open) {
      await tick();
      if (next.active >= 0) document.getElementById(optId(next.active))?.scrollIntoView({ block: 'nearest' });
    }
  }

  async function show(): Promise<void> {
    if (!list || !trigger) return;
    minWidth = variant === 'field' ? trigger.getBoundingClientRect().width : 0;
    list.showPopover();
    await tick();
    place();
  }

  function place(): void {
    if (!list || !trigger) return;
    const r = trigger.getBoundingClientRect();
    // offset sizes: the opening scale would shrink a bounding rect and misplace a list that opens above.
    at = placeMenu({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, align, vw: document.documentElement.clientWidth, vh: window.innerHeight, width: list.offsetWidth, height: list.offsetHeight });
    origin = `${at.top < r.top ? 'bottom' : 'top'} ${align === 'end' ? 'right' : 'left'}`;
  }

  function close(refocus: boolean): void {
    if (!st.open) return;
    void apply(CLOSED);
    if (refocus) trigger?.focus();
  }

  function choose(i: number): void {
    const o = options[i];
    if (!o || o.disabled) return;
    if (o.action) {
      onchange?.(o.value);
      return;
    }
    if (o.value === value) return;
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

  /** Opens the list as a click does (focus on the button, the chosen entry active), or closes it when open; a disabled Select does nothing. */
  export function toggle(): void {
    if (disabled || !trigger) return;
    trigger.focus();
    if (st.open) close(true);
    else void apply({ ...CLOSED, open: true, active: openAt(options, selected) });
  }

  function click(): void {
    if (swallowClick) return;
    toggle();
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
  {title}
  aria-keyshortcuts={keyshortcuts}
  {disabled}
  class="{variant === 'button' ? 'btn sm' : 'input inline-flex items-center justify-between gap-2 text-left'} {cls}"
  onclick={click}
  onkeydown={key}
  onkeyup={keyUp}
  onfocusout={focusOut}
>{#if variant === 'button' && icon}<Icon name={icon} />{/if}<span class={sel || text !== undefined ? 'truncate' : 'truncate text-muted'} lang={text === undefined ? sel?.lang : undefined}>{text ?? sel?.label ?? placeholder ?? $t('select.choose')}</span>{#if variant !== 'button' && badge}<span class="{badgeTone === 'ember' ? 'dot ember' : 'dot spark'} ml-auto size-2 shrink-0" aria-hidden="true"></span>{/if}<Icon name="chevron-down" class="shrink-0" />{#if variant === 'button' && badge}<span class="{badgeTone === 'ember' ? 'dot ember' : 'dot spark'} absolute -top-1 -right-1 size-2" aria-hidden="true"></span>{/if}</button>
<ul
  bind:this={list}
  id={listId}
  popover="manual"
  role="listbox"
  aria-label={label}
  aria-labelledby={labelledby}
  tabindex="-1"
  class="plate solid menu-pop menu-list fixed inset-auto m-0 text-fg hidden open:flex flex-col max-w-[calc(100vw_-_16px)] max-h-[min(20rem,calc(100dvh_-_16px))] overflow-y-auto overscroll-contain text-sm shadow-(--shadow-overlay) {variant === 'button' ? 'w-[min(16rem,calc(100vw_-_16px))]' : ''}"
  style="left: {at.left}px; top: {at.top}px; min-width: {minWidth}px; transform-origin: {origin}"
  onmousedown={(e) => e.preventDefault()}
>
  {#each runs as run, r (run.start)}
    {#if run.group === undefined}
      {#each options.slice(run.start, run.start + run.count) as o, k (run.start + k)}{@render row(o, run.start + k)}{/each}
    {:else}
      <li role="group" aria-labelledby={groupId(r)} class="flex flex-col">
        <div id={groupId(r)} class="label px-2 pt-1.5 pb-0.5" role="presentation">{run.group}</div>
        <ul role="none" class="flex flex-col">
          {#each options.slice(run.start, run.start + run.count) as o, k (run.start + k)}{@render row(o, run.start + k)}{/each}
        </ul>
      </li>
    {/if}
  {/each}
</ul>

{#snippet row(o: SelectOption, i: number)}
  <!-- svelte-ignore a11y_click_events_have_key_events (focus stays on the combobox button, which chooses options from the keyboard; the list cancels mousedown so a press never moves focus here) -->
  <li
    id={optId(i)}
    role="option"
    aria-selected={i === selected}
    aria-disabled={o.disabled ? 'true' : undefined}
    lang={o.lang}
    class="flex items-start gap-2 px-2 py-1 {i === st.active ? 'bg-raised text-fg shadow-[inset_var(--bar-rule)_0_0_0_var(--gleam)]' : 'text-fg'} {o.disabled ? 'opacity-40' : ''} {o.separator ? 'mt-1 pt-1 border-t border-line-soft' : ''}"
    onmousemove={() => hover(i)}
    onclick={() => pick(i)}
  >
    {#if i === selected}<Icon name="check" class="shrink-0" />{:else if o.action && o.icon && !entry}<Icon name={o.icon} class="shrink-0" />{:else}<span class="ic shrink-0" aria-hidden="true"></span>{/if}{#if entry}{@render entry(o, i)}{:else}{#if o.icon && !o.action}<Icon name={o.icon} class="shrink-0" />{/if}<span class="flex min-w-0 flex-col"><span class="flex min-w-0 items-center gap-1.5"><span class="truncate">{o.label}</span>{#if o.badge}<span class="dot ember size-2 shrink-0" aria-hidden="true"></span>{/if}</span>{#if o.hint}<span class="text-xs text-muted whitespace-normal">{o.hint}</span>{/if}</span>{/if}
  </li>
{/snippet}
