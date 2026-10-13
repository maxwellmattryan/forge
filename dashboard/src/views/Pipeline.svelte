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
  {#snippet sub()}{$t('pipeline.active', { count: counts.active })} · {$t('pipeline.base')} <code class="font-mono text-xs">{data.config.base}</code> · {$t('pipeline.tracker', { tracker: data.config.tracker })}{/snippet}
  {#snippet right()}
    <div class="flex flex-wrap gap-1.5">
      {#each FILTERS as f (f)}<button class="btn {S.filter === f ? 'border-accent/60 text-fg' : 'text-muted'}" onclick={() => setFilter(f)}>{filterLabel[f]} <span class="text-muted tabular-nums">{counts[f]}</span></button>{/each}
    </div>
    <div class="flex rounded-lg border border-line overflow-hidden">
      {#each LAYOUTS as l (l)}<button class="px-2.5 py-1.5 text-sm flex items-center gap-1.5 {S.layout === l ? 'bg-raised text-fg' : 'text-muted'}" onclick={() => setLayout(l)}><Icon name={l} />{layoutLabel[l]}</button>{/each}
    </div>
    <button class="btn btn-primary" onclick={() => req({ type: 'next' })}>{$t('common.runNext')}</button>
  {/snippet}
</PageHeader>
{#if !jobs.length}
  <Empty>{$t('pipeline.empty')} <code class="font-mono">{$t('pipeline.cmdFeature')}</code> {$t('pipeline.or')} <code class="font-mono">{$t('pipeline.cmdNext')}</code>.</Empty>
{:else if S.layout === 'table'}
  <JobsTable {jobs} />
{:else}
  <div class="flex gap-3 overflow-x-auto pb-4 -mx-4 px-4 md:mx-0 md:px-0">
    {#each boardStages(jobs) as stage (stage)}
      {@const list = jobs.filter((j) => j.stage === stage)}
      <section class="w-72 shrink-0 card bg-panel/60 flex flex-col max-h-[calc(100vh-180px)]">
        <header class="flex items-center justify-between px-3 py-2.5 border-b border-line"><span class="text-sm font-medium">{STAGE_LABEL[stage as Stage]}</span><span class="text-xs text-muted tabular-nums">{list.length}</span></header>
        <div class="flex flex-col gap-2 p-2 overflow-y-auto">
          {#each list as j (j.id)}<JobCard job={j} />{:else}<div class="text-xs text-muted px-1 py-3 text-center">—</div>{/each}
        </div>
      </section>
    {/each}
  </div>
{/if}
