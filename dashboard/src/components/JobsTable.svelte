<!-- The pipeline's table layout, in the board's urgency order. The title is a button so Tab plus Enter opens the drawer;
     a click anywhere else on the row opens it too. -->
<script lang="ts">
  import StateChip from './StateChip.svelte';
  import VerdictChip from './VerdictChip.svelte';
  import PrChip from './PrChip.svelte';
  import StageStepper from './StageStepper.svelte';
  import BudgetCell from './BudgetCell.svelte';
  import MandateBadge from './MandateBadge.svelte';
  import { ago, num, usd } from '../lib/util.ts';
  import { cardModel, sortByRank } from '../lib/board.ts';
  import { prChipModel } from '../lib/job-state.ts';
  import { openDrawer } from '../lib/app.svelte.ts';
  import { ticker } from '../lib/clock.svelte.ts';
  import type { StateJob } from '../lib/types.ts';
  import { t } from '../lib/locale.ts';

  let { jobs }: { jobs: StateJob[] } = $props();
  const rows = $derived(sortByRank(jobs));
</script>

<!-- The scroller sits inside the plate, so the plate's cut corners clip it. -->
<div class="plate flat"><div class="overflow-x-auto">
  <table class="tbl">
    <thead><tr><th>{$t('common.job')}</th><th>{$t('table.stage')}</th><th>{$t('table.state')}</th><th>{$t('table.tasks')}</th><th>{$t('table.verdicts')}</th><th>{$t('table.pr')}</th><th class="r">{$t('common.tokens')}</th><th class="r">{$t('common.estCost')}</th><th>{$t('table.budget')}</th><th>{$t('table.updated')}</th></tr></thead>
    <tbody>
      {#each rows as j (j.id)}
        {@const m = cardModel(j)}
        <tr class="clickable" onclick={() => openDrawer(j.id)}>
          <!-- stopPropagation: the row's own click would load the drawer a second time. -->
          <td><button class="h card text-left hover:text-gleam" onclick={(e) => { e.stopPropagation(); openDrawer(j.id); }}>{j.title}</button><div class="mono muted text-[11px] truncate" title={m.refTitle}>{m.ref}</div><MandateBadge mandate={j.mandate} extra="mt-1" /></td>
          <td><div class="flex items-center gap-2"><StageStepper steps={m.steps} stage={m.stage} /><span class="whitespace-nowrap">{m.stage}{#if m.round}{' · '}{$t('job.round', m.round)}{/if}</span></div></td>
          <td><StateChip job={j} /></td>
          <td class="num">{j.progress?.total ? `${j.progress.done}/${j.progress.total}` : '—'}</td>
          <td><div class="flex flex-wrap gap-1">{#each m.lenses ?? [] as l, i (i)}<VerdictChip name={l.name} verdict={l.verdict} />{/each}</div></td>
          <td>{#if prChipModel(j.pr)}<PrChip pr={j.pr} />{:else}—{/if}</td>
          <td class="r num">{num(j.usage?.totalTokens)}</td><td class="r num">{usd(j.usage?.estCostUsd)}</td><td class="whitespace-nowrap"><BudgetCell job={j} /></td>
          <td class="text-muted whitespace-nowrap">{ago(j.updatedAt, ticker.now)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div></div>
