<!-- The live dot: an ink dot with a ping halo while a daemon session is working, a hollow dot otherwise. The halo is the
     dashboard's only looping motion and is motion-safe, so under reduced motion the dot is static. Decorative: the words
     next to it carry the meaning. -->
<script lang="ts">
  let { on }: { on: boolean } = $props();
</script>

{#if on}
  <span class="relative inline-flex shrink-0" aria-hidden="true"><span class="dot ink absolute inset-0 opacity-75 motion-safe:animate-ping"></span><span class="dot ink relative"></span></span>
{:else}
  <span class="dot hollow shrink-0" aria-hidden="true"></span>
{/if}
