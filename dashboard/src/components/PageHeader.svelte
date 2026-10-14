<!-- A view's title row: heading, optional subtitle on a dimension line, right-hand controls, then the palette's header trigger.
     The heading takes focus (tabindex -1) when the palette closes and its opener is gone. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import CommandTrigger from './CommandTrigger.svelte';

  let { title, sub, right }: { title: string; sub?: Snippet; right?: Snippet } = $props();
</script>

<!-- dim-line is nowrap; the inner span lets a long sub wrap between the end ticks instead of clipping, and the hairlines keep a minimum length so the line still reads as a dimension. -->
<div class="flex flex-wrap items-end justify-between gap-4 mb-5"><div class="flex min-w-0 flex-col gap-2"><h1 class="h page" tabindex="-1">{title}</h1>{#if sub}<p class="dim-line max-w-[72ch] before:min-w-4 after:min-w-4"><span class="end"></span><span class="min-w-0 whitespace-normal">{@render sub()}</span><span class="end"></span></p>{/if}</div><div class="flex flex-wrap items-center gap-2.5">{@render right?.()}<CommandTrigger variant="header" /></div></div>
