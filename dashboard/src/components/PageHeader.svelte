<!-- A view's title row: a riveted, hammered plaque (part of the frame) holding the heading, an optional subtitle, and
     right-hand controls. `sub` is prose (a muted sans sentence); `facts` is a stamp line of short facts (Pipeline's
     counts, Backlog's tracker). The palette opens from the sidebar. The heading takes focus (tabindex -1) when the
     palette or a popover closes and its opener is gone. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, sub, facts, right }: { title: string; sub?: Snippet; facts?: Snippet; right?: Snippet } = $props();
</script>

<!-- stamp-line is nowrap; the inner span lets long facts wrap between the rules instead of clipping. -->
<div class="plate riveted hammered flex flex-wrap items-end justify-between gap-4 px-5 py-3.5 mb-5"><div class="flex min-w-0 flex-col gap-2"><h1 class="h page" tabindex="-1">{title}</h1>{#if facts}<p class="stamp-line max-w-[72ch]"><span class="min-w-0 whitespace-normal">{@render facts()}</span></p>{/if}{#if sub}<p class="max-w-[72ch] text-[13px] leading-5 text-muted">{@render sub()}</p>{/if}</div><div class="flex flex-wrap items-center gap-2">{@render right?.()}</div></div>
