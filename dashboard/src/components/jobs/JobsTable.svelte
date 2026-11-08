<!-- The pipeline's table layout, in the board's urgency order. The title is a button so Tab plus Enter opens the drawer;
     a click anywhere else on the row opens it too. Job, Stage, State and Updated always show; each other column only
     when some row fills it (src/lib/jobs/board.ts tableColumns). -->
<script lang="ts">
  import StateChip from './StateChip.svelte';
  import VerdictChip from './VerdictChip.svelte';
  import PrChip from './PrChip.svelte';
  import StageStepper from './StageStepper.svelte';
  import BudgetCell from '../metrics/BudgetCell.svelte';
  import MandateBadge from '../office/MandateBadge.svelte';
  import { ago, num, usd } from '../../lib/core/util.ts';
  import { cardModel, sortByRank, tableColumns } from '../../lib/jobs/board.ts';
  import { prChipModel } from '../../lib/jobs/state.ts';
  import { budgetCellModel, unattendedDefault } from '../../lib/metrics/budget.ts';
  import { S, openDrawer } from '../../lib/core/app.svelte.ts';
  import { ticker } from '../../lib/core/clock.svelte.ts';
  import type { Job, StateJob } from '../../lib/core/types.ts';
  import { t } from '../../lib/text/locale.ts';

  let { jobs }: { jobs: StateJob[] } = $props();
  const rows = $derived(sortByRank(jobs));
  // Optional columns show only when a row fills them; Budget asks the same question BudgetCell does.
  const cols = $derived(tableColumns(rows, (j) => budgetCellModel(j as Job, S.data?.config?.pipeline?.budget, unattendedDefault(S.data?.config)).kind !== 'none'));
</script>

<!-- The scroller sits inside the plate, so the plate's cut corners clip it. -->
<div class="plate flat"><div class="overflow-x-auto">
  <table class="tbl">
    <thead><tr><th class="min-w-64">{$t('common.job')}</th><th>{$t('table.stage')}</th><th>{$t('table.state')}</th>{#if cols.has('tasks')}<th>{$t('table.tasks')}</th>{/if}{#if cols.has('verdicts')}<th>{$t('table.verdicts')}</th>{/if}{#if cols.has('pr')}<th>{$t('table.pr')}</th>{/if}{#if cols.has('tokens')}<th class="r">{$t('common.tokens')}</th>{/if}{#if cols.has('cost')}<th class="r">{$t('common.estCost')}</th>{/if}{#if cols.has('budget')}<th>{$t('table.budget')}</th>{/if}<th>{$t('table.updated')}</th></tr></thead>
    <tbody>
      {#each rows as j (j.id)}
        {@const m = cardModel(j)}
        <tr class="clickable" onclick={() => openDrawer(j.id)}>
          <!-- stopPropagation: the row's own click would load the drawer a second time. -->
          <td><button class="h card text-left hover:text-gleam" onclick={(e) => { e.stopPropagation(); openDrawer(j.id); }}>{j.title}</button><div class="mono muted text-[11px] truncate" title={m.refTitle}>{m.ref}</div><MandateBadge mandate={j.mandate} extra="mt-1" /></td>
          <td><div class="flex items-center gap-2"><StageStepper steps={m.steps} stage={m.stage} /><span class="whitespace-nowrap">{m.stage}{#if m.round}{' · '}{$t('job.round', m.round)}{/if}</span></div></td>
          <td><StateChip job={j} /></td>
          {#if cols.has('tasks')}<td class="num">{j.progress?.total ? `${j.progress.done}/${j.progress.total}` : '—'}</td>{/if}
          {#if cols.has('verdicts')}<td><div class="flex flex-wrap gap-1">{#each m.lenses ?? [] as l, i (i)}<VerdictChip name={l.name} verdict={l.verdict} />{/each}</div></td>{/if}
          {#if cols.has('pr')}<td>{#if prChipModel(j.pr)}<PrChip pr={j.pr} />{:else}—{/if}</td>{/if}
          {#if cols.has('tokens')}<td class="r num">{num(j.usage?.totalTokens)}</td>{/if}{#if cols.has('cost')}<td class="r num">{usd(j.usage?.estCostUsd)}</td>{/if}{#if cols.has('budget')}<td class="whitespace-nowrap"><BudgetCell job={j} /></td>{/if}
          <td class="text-muted whitespace-nowrap">{ago(j.updatedAt, ticker.now)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div></div>
