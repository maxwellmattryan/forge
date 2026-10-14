<!-- Pipeline: filters, the board/table toggle, and every job by stage. -->
<script lang="ts">
  import Empty from '../components/Empty.svelte';
  import Icon from '../components/Icon.svelte';
  import JobCard from '../components/JobCard.svelte';
  import JobsTable from '../components/JobsTable.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import { STAGE_LABEL } from '../lib/labels.ts';
  import type { ApiState, Stage } from '../lib/types.ts';
  import { boardStages, filterJobs, pipelineCounts } from '../lib/view.ts';
  import { S, req, setFilter, setLayout } from '../lib/app.svelte.ts';
  import { t } from '../lib/locale.ts';

  let { data }: { data: ApiState } = $props();
  const counts = $derived(pipelineCounts(data.jobs));
  const jobs = $derived(filterJobs(data.jobs, S.filter));
  const FILTERS = ['active', 'waiting', 'done', 'all'] as const;
  const LAYOUTS = ['board', 'table'] as const;
  const filterLabel = $derived<Record<(typeof FILTERS)[number], string>>({
    active: $t('pipeline.filter.active'),
    waiting: $t('pipeline.filter.waiting'),
    done: $t('pipeline.filter.done'),
    all: $t('pipeline.filter.all'),
  });
  const layoutLabel = $derived<Record<(typeof LAYOUTS)[number], string>>({ board: $t('pipeline.layout.board'), table: $t('pipeline.layout.table') });
</script>

<PageHeader title={$t('pipeline.title')}>
  {#snippet sub()}{$t('pipeline.active', { count: counts.active })} · {$t('pipeline.base')} <code class="font-mono">{data.config.base}</code> · {$t('pipeline.tracker', { tracker: data.config.tracker })}{/snippet}
  {#snippet right()}
    <div class="seg">
      {#each FILTERS as f (f)}{@const on = S.filter === f}<button class="btn sm {on ? 'sel' : ''}" aria-pressed={on} onclick={() => setFilter(f)}>{filterLabel[f]} <span class="num {on ? 'opacity-70' : 'muted'}">{counts[f]}</span></button>{/each}
    </div>
    <div class="seg">
      {#each LAYOUTS as l (l)}{@const on = S.layout === l}<button class="btn sm {on ? 'sel' : ''}" aria-pressed={on} onclick={() => setLayout(l)}><Icon name={l} />{layoutLabel[l]}</button>{/each}
    </div>
    <button class="btn primary" onclick={() => req({ type: 'next' })}>{$t('common.runNext')}</button>
  {/snippet}
</PageHeader>
{#if !jobs.length}
  <Empty>{$t('pipeline.empty')} <code class="mono text-fg">{$t('pipeline.cmdFeature')}</code> {$t('pipeline.or')} <code class="mono text-fg">{$t('pipeline.cmdNext')}</code>.</Empty>
{:else if S.layout === 'table'}
  <JobsTable {jobs} />
{:else}
  <div class="flex gap-3 overflow-x-auto pb-4 -mx-4 px-4 md:mx-0 md:px-0">
    {#each boardStages(jobs) as stage (stage)}
      {@const list = jobs.filter((j) => j.stage === stage)}
      <section class="sheet dashed w-(--size-board-column) shrink-0 flex flex-col max-h-[calc(100vh-180px)]">
        <header class="flex items-center justify-between px-3 py-2 border-b border-dashed border-line"><span class="label text-fg">{STAGE_LABEL[stage as Stage]}</span><span class="mono muted num text-[11px]">{list.length}</span></header>
        <!-- At least p-2.5: a redline card's outline sits 3px outside it and the scroller would clip it. -->
        <div class="flex flex-col gap-2.5 p-2.5 overflow-y-auto">
          {#each list as j (j.id)}<JobCard job={j} />{:else}<div class="caption muted text-center py-3">—</div>{/each}
        </div>
      </section>
    {/each}
  </div>
{/if}
