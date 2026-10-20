<!-- An icon-only button: its name is `label` (aria-label and the tooltip's first line), and `hint`, when set, is the
     tooltip's second line and the button's description (aria-describedby on an sr-only span). The tooltip anchors on the
     wrapper, and a disabled button lets pointer events through to it, so a disabled button still says why on hover. -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import Tooltip from './Tooltip.svelte';
  import type { IconName } from '../lib/icons.ts';

  let {
    icon,
    label,
    hint = null,
    onclick,
    disabled = false,
    pressed,
    size = 'sm',
    ghost = false,
    class: cls = '',
  }: {
    icon: IconName;
    label: string;
    hint?: string | null;
    onclick?: (e: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }) => void;
    disabled?: boolean;
    pressed?: boolean;
    size?: 'sm' | 'md';
    ghost?: boolean;
    class?: string;
  } = $props();

  const uid = $props.id();
  const hintId = `${uid}-hint`;
  let wrap = $state<HTMLSpanElement>();
</script>

<span bind:this={wrap} class="inline-flex"><button
    type="button"
    class="btn icon {size === 'sm' ? 'sm' : ''} {ghost ? 'ghost' : ''} {pressed ? 'sel' : ''} {cls} disabled:pointer-events-none"
    aria-label={label}
    aria-pressed={pressed === undefined ? undefined : pressed}
    aria-describedby={hint ? hintId : undefined}
    {disabled}
    {onclick}><Icon name={icon} /></button>{#if hint}<span id={hintId} class="sr-only">{hint}</span>{/if}<Tooltip anchor={wrap} text={label} {hint} /></span>
