<!-- The Overview while the machine's project list loads: the project-card grid, the two graph sections and the machine section. -->
<script lang="ts">
  import Loading from '../../ui/feedback/Loading.svelte';
  import Skeleton from '../../ui/feedback/Skeleton.svelte';
  import OverviewGraphSkeleton from './OverviewGraphSkeleton.svelte';
  import { t } from '../../../lib/text/locale.ts';

  const names = ['9rem', '7rem', '11rem', '8rem'];
  const latest = ['75%', '60%', '85%', '50%'];
</script>

<Loading>
  <div class="grid gap-3 md:grid-cols-2 2xl:grid-cols-3 mb-6">
    {#each names as n, i}
      <article class="plate p-4 flex flex-col gap-3 min-w-0">
        <header class="flex items-baseline justify-between gap-3"><Skeleton w={n} h="1rem" /></header>
        <dl class="grid grid-cols-2 gap-x-4 gap-y-3">
          <div class="flex flex-col gap-0.5"><dt class="label">{$t('overview.active')}</dt><Skeleton w="1.5rem" h="1.5rem" /></div>
          <div class="flex flex-col gap-0.5"><dt class="label">{$t('overview.waiting')}</dt><Skeleton w="2rem" h="1.5rem" /></div>
          <div class="flex flex-col gap-0.5"><dt class="label">{$t('overview.foreman')}</dt><Skeleton w="4.5rem" h="1.25rem" /></div>
          <div class="flex flex-col gap-0.5"><dt class="label">{$t('overview.sessions')}</dt><Skeleton w="2.5rem" h="1.5rem" /></div>
        </dl>
        <div class="flex flex-col gap-0.5 min-w-0">
          <span class="label">{$t('overview.latest')}</span>
          <Skeleton w={latest[i]} h="0.875rem" />
        </div>
      </article>
    {/each}
  </div>
  <div class="grid gap-3 lg:grid-cols-2 mb-6">
    <section class="plate p-4 flex flex-col gap-3 min-w-0">
      <h2 class="label callout">{$t('overview.shippedTitle')}</h2>
      <OverviewGraphSkeleton />
    </section>
    <section class="plate p-4 flex flex-col gap-3 min-w-0">
      <h2 class="label callout">{$t('overview.costTitle')}</h2>
      <OverviewGraphSkeleton />
    </section>
  </div>
  <section class="plate p-4 flex flex-col gap-3">
    <h2 class="label callout">{$t('overview.machineTitle')}</h2>
    <div class="grid gap-4 md:grid-cols-3">
      <div class="flex flex-col gap-2 min-w-0">
        <span class="label">{$t('overview.machineCap')}</span>
        <Skeleton w="5rem" h="0.875rem" />
        <Skeleton h="0.5rem" />
        <Skeleton w="40%" h="0.6875rem" />
      </div>
      <div class="kpi p-0"><span class="label">{$t('overview.spendToday')}</span><Skeleton w="5rem" h="1.75rem" /><span class="caption muted">{$t('overview.spendSub')}</span></div>
      <div class="kpi p-0"><span class="label">{$t('overview.spendMonth')}</span><Skeleton w="5rem" h="1.75rem" /><span class="caption muted">{$t('overview.spendSub')}</span></div>
    </div>
  </section>
</Loading>
