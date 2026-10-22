<!-- An empty state: a borderless plain block with a small Forge mark. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<div class="plain flex flex-col items-center gap-3 px-4 py-10 text-center text-muted"><img src="/forge.png" alt="" class="size-(--size-icon)" /><div>{@render children()}</div></div>
