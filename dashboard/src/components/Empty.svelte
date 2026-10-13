<!-- An empty state with the Forge mark. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<div class="card px-4 py-10 text-center text-sm text-muted"><img src="/forge.png" alt="" class="size-10 mx-auto mb-3 rounded-lg opacity-80" />{@render children()}</div>
