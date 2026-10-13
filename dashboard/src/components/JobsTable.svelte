<!-- The pipeline's table layout. -->
<script lang="ts">
  import StateChip from './StateChip.svelte';
  import VerdictChip from './VerdictChip.svelte';
  import PrChip from './PrChip.svelte';
  import { budgetCell } from '../lib/budget.ts';
  import { STAGE_LABEL } from '../lib/labels.ts';
  import { ago, num, usd } from '../lib/util.ts';
  import { prChipModel } from '../lib/view.ts';
  import { S, openDrawer } from '../lib/app.svelte.ts';
  import type { StateJob } from '../lib/types.ts';
  import { t } from '../lib/locale.ts';

  let { jobs }: { jobs: StateJob[] } = $props();
</script>

<div class="card overflow-x-auto">
  <table class="tbl">
    <thead><tr><th>{$t('common.job')}</th><th>{$t('table.stage')}</th><th>{$t('table.state')}</th><th>{$t('table.round')}</th><th>{$t('table.tasks')}</th><th>{$t('table.verdicts')}</th><th>{$t('table.pr')}</th><th class="text-right">{$t('common.tokens')}</th><th class="text-right">{$t('common.estCost')}</th><th>{$t('table.budget')}</th><th>{$t('table.updated')}</th></tr></thead>
    <tbody>
      {#each jobs as j (j.id)}
        {@const v = j.verdicts?.[j.round]}
        <tr class="hover:bg-raised cursor-pointer" onclick={() => openDrawer(j.id)}>
          <td><div class="font-medium">{j.title}</div><div class="text-[11px] text-muted font-mono">{j.id}</div></td>
          <td>{STAGE_LABEL[j.stage] ?? j.stage}</td><td><StateChip job={j} /></td>
          <td class="tabular-nums">{j.round ? `${j.round}/${j.maxRounds}` : '—'}</td>
          <td class="tabular-nums">{j.progress?.total ? `${j.progress.done}/${j.progress.total}` : '—'}</td>
          <td><div class="flex flex-wrap gap-1">{#each j.reviewers ?? [] as r, i (i)}<VerdictChip name={r} verdict={v?.[r]} />{/each}</div></td>
          <td>{#if prChipModel(j.pr)}<PrChip pr={j.pr} />{:else}—{/if}</td>
          <td class="text-right tabular-nums">{num(j.usage?.totalTokens)}</td><td class="text-right tabular-nums">{usd(j.usage?.estCostUsd)}</td><td class="whitespace-nowrap">{@html budgetCell(j, S.data?.config?.pipeline?.budget)}</td>
          <td class="text-muted whitespace-nowrap">{ago(j.updatedAt)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
