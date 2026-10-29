<!-- The Evals body while its data loads: the run form plate, the five KPI tiles and the runs table.
     Shared by EvalsSkeleton and the view's own loading state. -->
<script lang="ts">
  import Loading from '../../ui/feedback/Loading.svelte';
  import Skeleton from '../../ui/feedback/Skeleton.svelte';
  import { t } from '../../../lib/text/locale.ts';

  const rows = [0, 1, 2, 3, 4];
</script>

<Loading class="block">
  <div class="plate p-4 mb-6 grid gap-3 md:grid-cols-4 items-end">
    {#each [0, 1, 2] as i (i)}
      <div class="flex flex-col gap-1"><Skeleton w="4rem" h="0.75rem" /><Skeleton h="2rem" /></div>
    {/each}
    <Skeleton w="70%" h="0.6875rem" />
  </div>
  <div class="grid gap-3 grid-cols-2 lg:grid-cols-5 mb-6">
    <div class="plate kpi"><div class="label">{$t('evals.checkPass')}</div><Skeleton w="55%" h="1.75rem" class="mt-1" /></div>
    <div class="plate kpi"><div class="label">{$t('evals.judgeScore')}</div><Skeleton w="55%" h="1.75rem" class="mt-1" /></div>
    <div class="plate kpi"><div class="label">{$t('evals.firstPass')}</div><Skeleton w="55%" h="1.75rem" class="mt-1" /></div>
    <div class="plate kpi"><div class="label">{$t('evals.avgTokens')}</div><Skeleton w="55%" h="1.75rem" class="mt-1" /></div>
    <div class="plate kpi"><div class="label">{$t('evals.avgCost')}</div><Skeleton w="55%" h="1.75rem" class="mt-1" /></div>
  </div>
  <div class="plate flat mb-6"><div class="label callout px-3 pt-3">{$t('common.runs')}</div><div class="overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>{$t('evals.runCol')}</th><th>{$t('evals.status')}</th><th>{$t('evals.config')}</th><th>{$t('evals.pass')}</th><th>{$t('evals.judge')}</th><th>{$t('evals.firstPassCol')}</th><th>{$t('common.rounds')}</th><th>{$t('evals.escalated')}</th><th class="r">{$t('common.tokens')}</th><th class="r">{$t('evals.cost')}</th><th class="r">{$t('evals.minutes')}</th></tr></thead>
      <tbody>
        {#each rows as i (i)}
          <tr>
            <td><Skeleton w="7rem" h="0.75rem" /><Skeleton w="4rem" h="0.6875rem" class="mt-1" /></td>
            <td><Skeleton w="3.5rem" h="1.25rem" /></td>
            <td><Skeleton w="4rem" h="0.6875rem" /><Skeleton w="2.5rem" h="0.6875rem" class="mt-1" /></td>
            {#each [0, 1, 2, 3, 4] as c (c)}<td><Skeleton w="2.5rem" /></td>{/each}
            <td class="r"><Skeleton w="2.5rem" class="ml-auto" /></td>
            <td class="r"><Skeleton w="2.5rem" class="ml-auto" /></td>
            <td class="r"><Skeleton w="2rem" class="ml-auto" /></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div></div>
</Loading>
