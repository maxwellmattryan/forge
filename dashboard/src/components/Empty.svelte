<!-- An empty state with the Forge mark. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<div class="sheet border-dashed flex flex-col items-center gap-3 px-4 py-10 text-center text-muted"><img src="/forge.png" alt="" class="mark" /><div>{@render children()}</div></div>
