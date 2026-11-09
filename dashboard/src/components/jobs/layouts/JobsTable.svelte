<!-- The pipeline's table layout. The title is a button so Tab plus Enter opens the drawer; a click anywhere else on the
     row opens it too. Job, Title, Stage, State and Updated always show (only Job, Title and State below a 40rem
     container); each other column only when some row fills it (src/lib/jobs/board.ts tableColumns). Headers sort (the
     saved per-project `tableSort`, a third click back to the urgency order), JobsTableFilters narrows the rows, and
     Group by mandate (the saved `tableGroup`) splits them into one collapsible tbody per mandate. -->
<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import StateChip from '../StateChip.svelte';
  import VerdictChip from '../VerdictChip.svelte';
  import PrChip from '../PrChip.svelte';
  import StageStepper from '../StageStepper.svelte';
  import JobsTableFilters from './JobsTableFilters.svelte';
  import BudgetCell from '../../metrics/BudgetCell.svelte';
  import MandateBadge from '../../office/MandateBadge.svelte';
  import Icon from '../../ui/Icon.svelte';
  import { ago, num, usd } from '../../../lib/core/util.ts';
  import { cardModel, filterTable, groupByMandate, nextSort, openNeedIds, parseSort, sortPref, sortTable, tableColumns, tableRows } from '../../../lib/jobs/board.ts';
  import type { FilterChip, SortColumn, TableSort } from '../../../lib/jobs/board.ts';
  import { depChipTitle, depLinks } from '../../../lib/jobs/deps.ts';
  import { prChipModel } from '../../../lib/jobs/state.ts';
  import type { JobLike } from '../../../lib/jobs/state.ts';
  import { budgetCellModel, unattendedDefault } from '../../../lib/metrics/budget.ts';
  import { pref } from '../../../lib/settings/prefs.ts';
  import { S, openDrawer } from '../../../lib/core/app.svelte.ts';
  import { ticker } from '../../../lib/core/clock.svelte.ts';
  import type { Job, StateJob } from '../../../lib/core/types.ts';
  import { t } from '../../../lib/text/locale.ts';

  let { jobs }: { jobs: StateJob[] } = $props();
  // App remounts this on a project switch, so reading the prefs at mount is enough.
  let sort = $state<TableSort | null>(parseSort(pref.get('tableSort', '')));
  let group = $state(pref.get('tableGroup', '1') !== '0');
  let chips = $state<FilterChip[]>([]);
  let text = $state('');
  const collapsed = new SvelteSet<string>();

  // Dependencies resolve against every job of the project, not only the page segment's.
  const all = $derived<JobLike[]>(S.data?.jobs ?? jobs);
  const shown = $derived(sortTable(filterTable(jobs, chips, text), sort, all));
  // Columns judge the received jobs, not the filtered rows, so typing in the search never makes them jump. Budget asks
  // the same question BudgetCell does.
  const cols = $derived(tableColumns(jobs, (j) => budgetCellModel(j as Job, S.data?.config?.pipeline?.budget, unattendedDefault(S.data?.config)).kind !== 'none', all));
  const showGroup = $derived(groupByMandate(jobs).some((g) => g.mandate !== null));
  const grouped = $derived(showGroup && group);
  const columnCount = $derived(5 + cols.size);
  const PHONE_HIDDEN = 'hidden @min-[40rem]:table-cell';

  function sortBy(col: SortColumn): void {
    sort = nextSort(sort, col);
    pref.set('tableSort', sortPref(sort));
  }
  function toggleGroup(): void {
    group = !group;
    pref.set('tableGroup', group ? '1' : '0');
  }
  function toggleCollapsed(key: string): void {
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
  }
  function clearFilters(): void {
    chips = [];
    text = '';
  }
  const needLinks = (j: StateJob) => {
    const open = openNeedIds(j, all);
    return depLinks(j, all).filter((l) => open.includes(l.id));
  };
</script>

{#snippet head(col: SortColumn, label: string, cls: string)}
  {@const dir = sort?.col === col ? sort.dir : null}
  <th class={cls} aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}><button type="button" class="inline-flex items-center gap-1 uppercase hover:text-fg" onclick={() => sortBy(col)}>{label}{#if dir}<Icon name={dir === 'asc' ? 'arrow-up' : 'arrow-down'} class="sm" />{/if}</button></th>
{/snippet}

{#snippet row(j: StateJob)}
  {@const m = cardModel(j)}
  {@const needs = needLinks(j)}
  <tr class="clickable" onclick={() => openDrawer(j.id)}>
    <td class="mono muted text-[11px] whitespace-nowrap" title={m.refTitle}>{m.ref}</td>
    <!-- stopPropagation: the row's own click would load the drawer a second time. -->
    <!-- No minimum width on a phone, and a long unbroken title wraps anywhere, so State still fits beside Job and Title. -->
    <td class="@min-[40rem]:min-w-48"><button class="h card block text-left wrap-anywhere hover:text-gleam" onclick={(e) => { e.stopPropagation(); openDrawer(j.id); }}>{j.title}</button>{#if !grouped}<MandateBadge mandate={j.mandate} extra="mt-1" />{/if}</td>
    <td class={PHONE_HIDDEN}><div class="flex items-center gap-2"><StageStepper steps={m.steps} stage={m.stage} /><span class="whitespace-nowrap">{m.stage}</span></div></td>
    <td><StateChip job={j} /></td>
    {#if cols.has('needs')}<td class="{PHONE_HIDDEN} mono text-[11px]" title={needs.length ? needs.map(depChipTitle).join('\n') : undefined}>{needs.length ? needs.map((l) => l.ref ?? l.id).join(' ') : '—'}</td>{/if}
    {#if cols.has('round')}<td class="{PHONE_HIDDEN} num">{m.round ? (m.round.max ? `${m.round.round}/${m.round.max}` : m.round.round) : '—'}</td>{/if}
    {#if cols.has('tasks')}<td class="{PHONE_HIDDEN} num">{j.progress?.total ? `${j.progress.done}/${j.progress.total}` : '—'}</td>{/if}
    {#if cols.has('verdicts')}<td class={PHONE_HIDDEN}><div class="flex flex-wrap gap-1">{#each m.lenses ?? [] as l, i (i)}<VerdictChip name={l.name} verdict={l.verdict} />{/each}</div></td>{/if}
    {#if cols.has('pr')}<td class={PHONE_HIDDEN}>{#if prChipModel(j.pr)}<PrChip pr={j.pr} />{:else}—{/if}</td>{/if}
    {#if cols.has('tokens')}<td class="{PHONE_HIDDEN} r num">{num(j.usage?.totalTokens)}</td>{/if}{#if cols.has('cost')}<td class="{PHONE_HIDDEN} r num">{usd(j.usage?.estCostUsd)}</td>{/if}{#if cols.has('budget')}<td class="{PHONE_HIDDEN} whitespace-nowrap"><BudgetCell job={j} /></td>{/if}
    <td class="{PHONE_HIDDEN} text-muted whitespace-nowrap">{ago(j.updatedAt, ticker.now)}</td>
  </tr>
{/snippet}

<!-- The scroller sits inside the plate, so the plate's cut corners clip it. -->
<div class="plate flat">
  <JobsTableFilters {jobs} bind:chips bind:text {group} ongroup={toggleGroup} {showGroup} />
  <div class="overflow-x-auto">
  <table class="tbl">
    <thead><tr>
      {@render head('job', $t('common.job'), '')}
      {@render head('title', $t('table.title'), '')}
      {@render head('stage', $t('table.stage'), PHONE_HIDDEN)}
      {@render head('state', $t('table.state'), '')}
      {#if cols.has('needs')}{@render head('needs', $t('table.needs'), PHONE_HIDDEN)}{/if}
      {#if cols.has('round')}{@render head('round', $t('table.round'), PHONE_HIDDEN)}{/if}
      {#if cols.has('tasks')}{@render head('tasks', $t('table.tasks'), PHONE_HIDDEN)}{/if}
      {#if cols.has('verdicts')}<th class={PHONE_HIDDEN}>{$t('table.verdicts')}</th>{/if}
      {#if cols.has('pr')}{@render head('pr', $t('table.pr'), PHONE_HIDDEN)}{/if}
      {#if cols.has('tokens')}{@render head('tokens', $t('common.tokens'), `${PHONE_HIDDEN} r`)}{/if}
      {#if cols.has('cost')}{@render head('cost', $t('common.estCost'), `${PHONE_HIDDEN} r`)}{/if}
      {#if cols.has('budget')}<th class={PHONE_HIDDEN}>{$t('table.budget')}</th>{/if}
      {@render head('updated', $t('table.updated'), PHONE_HIDDEN)}
    </tr></thead>
    {#if !shown.length}
      <tbody><tr><td colspan={columnCount}><div class="flex flex-wrap items-center gap-3 text-muted">{$t('table.filter.none')}<button type="button" class="btn sm" onclick={clearFilters}>{$t('table.filter.clear')}</button></div></td></tr></tbody>
    {:else if grouped}
      {#each groupByMandate(shown) as g (g.mandate ?? '')}
        {@const key = g.mandate ?? ''}
        <tbody>
          {#each tableRows([g], collapsed) as r (r.kind === 'group' ? ':group' : r.job.id)}
            {#if r.kind === 'group'}
              <tr><th scope="rowgroup" colspan={columnCount}><button type="button" class="inline-flex items-center gap-2 uppercase hover:text-fg" aria-expanded={r.open} onclick={() => toggleCollapsed(key)}><Icon name="chevron-down" class="sm {r.open ? '' : '-rotate-90'}" />{$t('table.group.mandate')}<span class="text-fg normal-case tracking-normal">{g.mandate ?? $t('table.filter.noMandate')}</span>{' · '}{$t('table.group.count', { jobs: g.jobs.length, merged: g.merged })}</button></th></tr>
            {:else}
              {@render row(r.job)}
            {/if}
          {/each}
        </tbody>
      {/each}
    {:else}
      <tbody>{#each shown as j (j.id)}{@render row(j)}{/each}</tbody>
    {/if}
  </table>
  </div>
</div>
