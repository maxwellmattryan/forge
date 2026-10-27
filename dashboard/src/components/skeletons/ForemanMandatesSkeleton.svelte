<!-- The Office page's mandate list while it loads: two cards shaped like MandateCard (title, id and state chip, a line of
     scope terms, the progress block, the contract fold, an action row). `bare` drops the Loading wrapper when a page
     skeleton already provides the one status region. -->
<script lang="ts">
  import Loading from '../Loading.svelte';
  import Skeleton from '../Skeleton.svelte';

  let { bare = false }: { bare?: boolean } = $props();
  const CARDS = [{ title: '55%', id: '6rem', term: '70%' }, { title: '40%', id: '5rem', term: '50%' }];
</script>

{#snippet cards()}
  {#each CARDS as c (c.title)}
    <div class="plate p-4 flex flex-col gap-3">
      <div class="flex flex-wrap items-start gap-2">
        <div class="min-w-0 flex-[1_1_16rem] flex flex-col gap-1.5"><Skeleton w={c.title} h="1.1rem" /><Skeleton w={c.id} h="0.6875rem" /></div>
        <Skeleton w="4.5rem" h="1.25rem" />
      </div>
      <div class="grid gap-x-4 gap-y-2 grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]">
        <div class="flex flex-col gap-1.5"><Skeleton w="40%" h="0.625rem" /><Skeleton w={c.term} h="0.75rem" /></div>
        <div class="flex flex-col gap-1.5"><Skeleton w="35%" h="0.625rem" /><Skeleton w="60%" h="0.75rem" /></div>
      </div>
      <div class="flex flex-col gap-1.5">
        <Skeleton w="4rem" h="0.625rem" />
        <Skeleton w="75%" h="0.8rem" />
        <Skeleton w="60%" h="0.8rem" />
      </div>
      <Skeleton w="6rem" h="0.8rem" />
      <div class="flex flex-wrap gap-2"><Skeleton w="4.5rem" h="2rem" /><Skeleton w="4.5rem" h="2rem" /><Skeleton w="4.5rem" h="2rem" /></div>
    </div>
  {/each}
{/snippet}

{#if bare}<div class="flex flex-col gap-3">{@render cards()}</div>{:else}<Loading class="flex flex-col gap-3">{@render cards()}</Loading>{/if}
