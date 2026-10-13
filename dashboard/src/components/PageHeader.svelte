<!-- A view's title row: heading, optional subtitle and right-hand controls. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, sub, right }: { title: string; sub?: Snippet; right?: Snippet } = $props();
</script>

<div class="flex flex-wrap items-end justify-between gap-3 mb-5"><div><h1 class="text-xl font-semibold">{title}</h1>{#if sub}<p class="text-sm text-muted mt-0.5">{@render sub()}</p>{/if}</div><div class="flex flex-wrap items-center gap-2">{@render right?.()}</div></div>
