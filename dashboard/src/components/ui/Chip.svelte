<!-- Every chip in the dashboard: `chip`, the extra classes, then the tone's class (none for a tone TONE_CLASS lacks, such as
     foreman or spark, which go in `extra`), an optional leading icon, then `children` or `text`. It takes no attribute
     spread: the URL guard in dashboard-invariants rejects spreads on native elements. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import { TONE_CLASS } from '../../lib/core/util.ts';
  import type { IconName } from '../../lib/ui/icons.ts';

  let {
    tone,
    text,
    extra = '',
    icon,
    title,
    id,
    role,
    ariaHidden = false,
    children,
  }: { tone?: string; text?: unknown; extra?: string; icon?: IconName; title?: string; id?: string; role?: string; ariaHidden?: boolean; children?: Snippet } = $props();
  const toneClass = $derived(tone && Object.hasOwn(TONE_CLASS, tone) ? TONE_CLASS[tone] : '');
</script>

<span {id} {role} {title} aria-hidden={ariaHidden ? 'true' : undefined} class="chip {extra} {toneClass}">{#if icon}<Icon name={icon} />{/if}{#if children}{@render children()}{:else}{text}{/if}</span>
