<!-- A view's title row: a riveted plaque holding the heading, an optional stamp line, and right-hand controls. The palette
     opens from the sidebar. The heading takes focus (tabindex -1) when the palette or a popover closes and its opener is gone. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, sub, right }: { title: string; sub?: Snippet; right?: Snippet } = $props();
</script>

<!-- stamp-line is nowrap; the inner span lets a long sub wrap between the rules instead of clipping. -->
<div class="plate riveted flex flex-wrap items-end justify-between gap-4 px-5 py-3.5 mb-5"><div class="flex min-w-0 flex-col gap-2"><h1 class="h page" tabindex="-1">{title}</h1>{#if sub}<p class="stamp-line max-w-[72ch]"><span class="min-w-0 whitespace-normal">{@render sub()}</span></p>{/if}</div><div class="flex flex-wrap items-center gap-2">{@render right?.()}</div></div>
