<!-- The Overview's stacked bars while the stats load: columns of varying heights on an axis, the day labels and the legend
     table. Bones only: the caller wraps it in a <Loading>. -->
<script lang="ts">
  import Skeleton from '../../ui/feedback/Skeleton.svelte';

  const heights = [45, 70, 55, 85, 40, 65, 90, 50, 75, 60, 35, 80, 55, 70];
</script>

<div class="flex flex-col gap-3">
  <div class="h-40 w-full flex items-end gap-1">
    {#each heights as h}<Skeleton class="flex-1" h="{h}%" />{/each}
  </div>
  <div class="flex justify-between"><Skeleton w="4.5rem" h="0.6875rem" /><Skeleton w="4.5rem" h="0.6875rem" /></div>
  <div class="flex flex-col gap-2">
    <Skeleton w="45%" h="0.8rem" />
    <Skeleton w="60%" h="0.8rem" />
  </div>
</div>
