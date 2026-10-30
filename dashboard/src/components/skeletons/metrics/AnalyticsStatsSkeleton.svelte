<!-- The windowed stats body's shape while /api/stats loads: the KPI grid, the three usage tables, the lens table, the
     top-jobs table and the footnote. `bare` drops the <Loading> root when AnalyticsSkeleton already announces the wait. -->
<script lang="ts">
  import Loading from '../../ui/feedback/Loading.svelte';
  import Skeleton from '../../ui/feedback/Skeleton.svelte';
  import { t } from '../../../lib/text/locale.ts';

  let { bare = false }: { bare?: boolean } = $props();
  const subs = ['70%', '90%', '55%', '65%', '45%', '85%', '60%', '50%', '75%', '95%'];
  const nameW = ['45%', '60%', '35%'];
</script>

{#snippet usageTable(title: string)}
  <div class="plate flat"><div class="label callout px-3 pt-3">{title}</div><div class="overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>{$t('analytics.name')}</th><th>{$t('common.runs')}</th><th class="w-1/3">{$t('common.tokens')}</th><th class="r">{$t('common.estCost')}</th></tr></thead>
      <tbody>
        {#each nameW as w (w)}
          <tr>
            <td><Skeleton {w} h="0.8rem" /></td>
            <td><Skeleton w="1.5rem" h="0.8rem" /></td>
            <td><div class="flex items-center gap-2"><div class="track flex-1"></div><Skeleton w="2rem" h="0.6875rem" /></div></td>
            <td><Skeleton w="3rem" h="0.8rem" class="ml-auto" /></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div></div>
{/snippet}

{#snippet body()}
  <div class="grid gap-3 grid-cols-2 lg:grid-cols-3">
    <div class="plate kpi"><div class="label">{$t('analytics.jobs')}</div><div class="v"><Skeleton w="4rem" h="1.75rem" class="my-0.5" /></div><Skeleton w={subs[0]} h="0.75rem" class="mt-0.5" /></div>
    <div class="plate kpi"><div class="label">{$t('analytics.autonomy')}</div><div class="v"><Skeleton w="4rem" h="1.75rem" class="my-0.5" /></div><Skeleton w={subs[1]} h="0.75rem" class="mt-0.5" /></div>
    <div class="plate kpi"><div class="label">{$t('analytics.firstPass')}</div><div class="v"><Skeleton w="4rem" h="1.75rem" class="my-0.5" /></div><Skeleton w={subs[2]} h="0.75rem" class="mt-0.5" /></div>
    <div class="plate kpi"><div class="label">{$t('analytics.escalation')}</div><div class="v"><Skeleton w="4rem" h="1.75rem" class="my-0.5" /></div><Skeleton w={subs[3]} h="0.75rem" class="mt-0.5" /></div>
    <div class="plate kpi"><div class="label">{$t('analytics.prFeedback')}</div><div class="v"><Skeleton w="4rem" h="1.75rem" class="my-0.5" /></div><Skeleton w={subs[4]} h="0.75rem" class="mt-0.5" /></div>
    <div class="plate kpi"><div class="label">{$t('analytics.delta')}</div><div class="v"><Skeleton w="4rem" h="1.75rem" class="my-0.5" /></div><Skeleton w={subs[5]} h="0.75rem" class="mt-0.5" /></div>
    <div class="plate kpi"><div class="label">{$t('analytics.toPr')}</div><div class="v"><Skeleton w="4rem" h="1.75rem" class="my-0.5" /></div><Skeleton w={subs[6]} h="0.75rem" class="mt-0.5" /></div>
    <div class="plate kpi"><div class="label">{$t('analytics.verify')}</div><div class="v"><Skeleton w="4rem" h="1.75rem" class="my-0.5" /></div><Skeleton w={subs[7]} h="0.75rem" class="mt-0.5" /></div>
    <div class="plate kpi"><div class="label">{$t('common.tokens')}</div><div class="v"><Skeleton w="4rem" h="1.75rem" class="my-0.5" /></div><Skeleton w={subs[8]} h="0.75rem" class="mt-0.5" /></div>
    <div class="plate kpi"><div class="label">{$t('analytics.cost')}</div><div class="v"><Skeleton w="4rem" h="1.75rem" class="my-0.5" /></div><Skeleton w={subs[9]} h="0.75rem" class="mt-0.5" /></div>
  </div>
  <div class="grid gap-3 lg:grid-cols-2 mt-6">
    {@render usageTable($t('analytics.byRole'))}{@render usageTable($t('analytics.byModel'))}{@render usageTable($t('analytics.bySession'))}
  </div>
  <div class="plate flat mt-6"><div class="label callout px-3 pt-3">{$t('analytics.lenses')}</div><div class="overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>{$t('common.lens')}</th><th>{$t('analytics.reviews')}</th><th>{$t('analytics.askedChanges')}</th></tr></thead>
      <tbody>
        {#each nameW as w (w)}
          <tr><td><Skeleton {w} h="0.8rem" /></td><td><Skeleton w="1.5rem" h="0.8rem" /></td><td><Skeleton w="2.5rem" h="0.8rem" /></td></tr>
        {/each}
      </tbody>
    </table>
  </div></div>
  <div class="plate flat mt-6"><div class="label callout px-3 pt-3">{$t('analytics.byUsage')}</div><div class="overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>{$t('common.job')}</th><th>{$t('common.rounds')}</th><th>{$t('analytics.duration')}</th><th class="r">{$t('common.tokens')}</th><th class="r">{$t('common.estCost')}</th><th>{$t('analytics.usageSource')}</th></tr></thead>
      <tbody>
        {#each ['70%', '55%', '80%', '60%'] as w (w)}
          <tr>
            <td><Skeleton {w} h="0.8rem" /></td>
            <td><Skeleton w="1rem" h="0.8rem" /></td>
            <td><Skeleton w="3rem" h="0.8rem" /></td>
            <td><Skeleton w="3.5rem" h="0.8rem" class="ml-auto" /></td>
            <td><Skeleton w="3rem" h="0.8rem" class="ml-auto" /></td>
            <td><Skeleton w="4rem" h="0.8rem" /></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div></div>
  <div class="plate w-fit max-w-full px-3 py-1.5 mt-3"><Skeleton w="24rem" h="0.6875rem" class="max-w-full" /></div>
{/snippet}

{#if bare}
  <div>{@render body()}</div>
{:else}
  <Loading>{@render body()}</Loading>
{/if}
