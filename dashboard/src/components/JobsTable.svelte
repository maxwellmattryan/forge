<!-- The pipeline's table layout, in the board's urgency order until a header is clicked (lib/jobs-table.ts). The filter
     field narrows the rows the Pipeline segment already chose. Sort and filter are this table's own state: switching to
     the board or reloading resets them. The title is a button so Tab plus Enter opens the drawer; a click anywhere else on
     the row opens it too. -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import StateChip from './StateChip.svelte';
  import VerdictChip from './VerdictChip.svelte';
  import PrChip from './PrChip.svelte';
  import StageStepper from './StageStepper.svelte';
  import { budgetCell, unattendedDefault } from '../lib/budget.ts';
  import { absTime, ago, num, usd } from '../lib/util.ts';
  import { cardModel, prChipModel } from '../lib/view.ts';
  import { filterByText, nextSort, sortJobs, type SortKey, type TableSort } from '../lib/jobs-table.ts';
  import { S, openDrawer } from '../lib/app.svelte.ts';
  import { ticker } from '../lib/clock.svelte.ts';
  import type { StateJob } from '../lib/types.ts';
  import { t } from '../lib/locale.ts';

  let { jobs }: { jobs: StateJob[] } = $props();
  let sort = $state<TableSort | null>(null);
  let query = $state('');
  const rows = $derived(sortJobs(filterByText(jobs, query), sort));
  const ariaSort = (key: SortKey): 'ascending' | 'descending' | undefined => (sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined);
</script>

{#snippet sortable(key: SortKey, label: string, cls = '')}
  <th class={cls} aria-sort={ariaSort(key)}><button type="button" onclick={() => (sort = nextSort(sort, key))}>{label}{#if sort?.key === key}<Icon name="chevron-down" class={sort.dir === 'asc' ? 'rotate-180' : ''} />{/if}</button></th>
{/snippet}

<input type="search" class="input sm w-full max-w-xs mb-3" placeholder={$t('table.filter')} aria-label={$t('table.filter')} bind:value={query} />
<!-- One persistent live region: a status element inserted together with its text is often not announced. -->
<p role="status" class={rows.length ? '' : 'plain px-3 py-2 text-sm text-muted'}>{rows.length ? '' : $t('table.noMatch', { query: query.trim() })}</p>
{#if rows.length}
  <!-- The scroller sits inside the plate, so the plate's cut corners clip it. -->
  <div class="plate flat"><div class="overflow-x-auto">
    <table class="tbl">
      <thead><tr>{@render sortable('title', $t('common.job'))}{@render sortable('stage', $t('table.stage'))}{@render sortable('state', $t('table.state'))}<th>{$t('table.tasks')}</th><th>{$t('table.verdicts')}</th><th>{$t('table.pr')}</th>{@render sortable('tokens', $t('common.tokens'), 'r')}{@render sortable('cost', $t('common.estCost'), 'r')}<th>{$t('table.budget')}</th>{@render sortable('updated', $t('table.updated'))}</tr></thead>
      <tbody>
        {#each rows as j (j.id)}
          {@const m = cardModel(j)}
          <tr class="clickable" onclick={() => openDrawer(j.id)}>
            <!-- stopPropagation: the row's own click would load the drawer a second time. -->
            <td><button class="h card text-left hover:text-gleam" onclick={(e) => { e.stopPropagation(); openDrawer(j.id); }}>{j.title}</button><div class="mono muted text-[11px] truncate" title={m.refTitle}>{m.ref}</div></td>
            <td><div class="flex items-center gap-2"><StageStepper steps={m.steps} stage={m.stage} /><span class="whitespace-nowrap">{m.stage}{#if m.round}{' · '}{$t('job.round', m.round)}{/if}</span></div></td>
            <td><StateChip job={j} /></td>
            <td class="num">{j.progress?.total ? `${j.progress.done}/${j.progress.total}` : '—'}</td>
            <td><div class="flex flex-wrap gap-1">{#each m.lenses ?? [] as l, i (i)}<VerdictChip name={l.name} verdict={l.verdict} />{/each}</div></td>
            <td>{#if prChipModel(j.pr)}<PrChip pr={j.pr} />{:else}—{/if}</td>
            <td class="r num">{num(j.usage?.totalTokens)}</td><td class="r num">{usd(j.usage?.estCostUsd)}</td><td class="whitespace-nowrap">{@html budgetCell(j, S.data?.config?.pipeline?.budget, unattendedDefault(S.data?.config))}</td>
            <td class="text-muted whitespace-nowrap" title={absTime(j.updatedAt)}>{ago(j.updatedAt, ticker.now)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div></div>
{/if}
