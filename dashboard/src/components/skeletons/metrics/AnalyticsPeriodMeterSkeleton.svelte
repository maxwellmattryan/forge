<!-- The period meter's shape while the budget loads: title row, spend figure, track, remaining/projected line and today's
     meter. `bare` drops the <Loading> root when AnalyticsSkeleton already announces the wait. -->
<script lang="ts">
  import Loading from '../../ui/feedback/Loading.svelte';
  import Skeleton from '../../ui/feedback/Skeleton.svelte';

  let { bare = false }: { bare?: boolean } = $props();
</script>

{#snippet body()}
  <div class="flex flex-wrap items-center justify-between gap-2"><Skeleton w="9rem" h="0.6875rem" /></div>
  <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1"><Skeleton w="7rem" h="2rem" /><Skeleton w="5rem" h="0.8rem" /></div>
  <div class="track"></div>
  <div class="caption flex flex-wrap gap-x-4 gap-y-1"><Skeleton w="7rem" h="0.75rem" /><Skeleton w="8rem" h="0.75rem" /></div>
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]"><Skeleton w="2.5rem" h="0.625rem" /><Skeleton w="6rem" h="0.75rem" /><div class="track flex-1 min-w-24 max-w-64"></div></div>
{/snippet}

{#if bare}
  <div class="plate p-4 mb-6 flex flex-col gap-3">{@render body()}</div>
{:else}
  <Loading class="plate p-4 mb-6 flex flex-col gap-3">{@render body()}</Loading>
{/if}
