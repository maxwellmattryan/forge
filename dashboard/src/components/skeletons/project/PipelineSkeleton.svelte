<!-- The Pipeline view's shape while the project's first state loads (App.svelte): the header with its filter and layout
     toggles, then the four stage columns, each holding a few card-shaped plates. -->
<script lang="ts">
  import Loading from '../../ui/feedback/Loading.svelte';
  import PageHeader from '../../shell/PageHeader.svelte';
  import Skeleton from '../../ui/feedback/Skeleton.svelte';
  import { t } from '../../../lib/text/locale.ts';

  // Cards per column (plan, build, ship and queued vary) and a title width per card.
  const COLUMNS = $derived([
    { id: 'queued', label: $t('pipeline.group.queued'), cards: [['85%', '60%']] },
    { id: 'plan', label: $t('pipeline.group.plan'), cards: [['90%', '55%'], ['70%', '40%']] },
    { id: 'build', label: $t('pipeline.group.build'), cards: [['80%', '65%'], ['95%', '50%'], ['75%', '45%']] },
    { id: 'ship', label: $t('pipeline.group.ship'), cards: [['88%', '70%'], ['65%', '35%']] },
  ]);
</script>

<Loading>
  <PageHeader title={$t('pipeline.title')}>
    {#snippet sub()}<Skeleton w="22rem" h="0.6875rem" class="max-w-full" />{/snippet}
    {#snippet right()}
      <Skeleton w="19rem" h="2rem" class="max-w-full" />
      <Skeleton w="9rem" h="2rem" />
    {/snippet}
  </PageHeader>
  <div class="grid grid-cols-1 @min-[44rem]:grid-cols-2 @min-[60rem]:grid-cols-4 gap-3">
    {#each COLUMNS as c (c.id)}
      <section class="plate open min-w-0 flex flex-col">
        <header class="plain flex items-center justify-between px-3 py-2 border-b border-line border-dashed"><span class="label text-fg">{c.label}</span><Skeleton w="0.75rem" h="0.6875rem" /></header>
        <div class="flex flex-col gap-2.5 p-2.5">
          {#each c.cards as card, i (i)}
            <div class="plate w-full p-3 pb-2.5 flex flex-col gap-2">
              <Skeleton w={card[0]} h="1rem" />
              <Skeleton w="40%" h="0.6875rem" />
              <div class="flex flex-wrap items-center gap-1.5"><Skeleton w="4.5rem" h="1.25rem" /><Skeleton w="3rem" h="1.25rem" /></div>
              <div class="flex items-center gap-2"><Skeleton w="5rem" h="0.75rem" /><Skeleton w={card[1]} h="0.6875rem" class="max-w-[40%]" /></div>
              <div class="flex items-center justify-between gap-2"><Skeleton w="35%" h="0.625rem" /><Skeleton w="30%" h="0.625rem" /></div>
            </div>
          {/each}
        </div>
      </section>
    {/each}
  </div>
</Loading>
