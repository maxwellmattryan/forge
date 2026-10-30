<!-- The Machine view's cap section while the machine summary loads: three facts (label and value) in the real grid. -->
<script lang="ts">
  import Loading from '../../ui/feedback/Loading.svelte';
  import Skeleton from '../../ui/feedback/Skeleton.svelte';
</script>

<Loading class="grid gap-3 sm:grid-cols-3">
  {#each ['3rem', '2rem', '4.5rem'] as w (w)}
    <div class="flex flex-col gap-0.5"><Skeleton w="4.5rem" h="0.6875rem" /><Skeleton {w} h="1.25rem" /></div>
  {/each}
</Loading>
