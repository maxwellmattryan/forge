<!-- Pipeline: filters, the board/table toggle, and every job in one of four stage groups (plus Done when the filter
     holds finished jobs), so the whole board fits a desktop without scrolling sideways. -->
<script lang="ts">
  import Empty from '../components/ui/feedback/Empty.svelte';
  import Icon from '../components/ui/Icon.svelte';
  import JobCard from '../components/jobs/JobCard.svelte';
  import JobsTable from '../components/jobs/JobsTable.svelte';
  import PageHeader from '../components/shell/PageHeader.svelte';
  import type { ApiState } from '../lib/core/types.ts';
  import { boardColumns, filterJobs, pipelineCounts, type BoardGroupId } from '../lib/jobs/board.ts';
  import { workingCount } from '../lib/sessions/live.ts';
  import { S, req, setFilter, setLayout } from '../lib/core/app.svelte.ts';
  import { t } from '../lib/text/locale.ts';
  import { slideMarker } from '../lib/ui/marker.ts';

  // App renders a view only once S.data is loaded.
  const data = $derived(S.data as ApiState);
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
  const groupLabel = $derived<Record<BoardGroupId, string>>({
    queued: $t('pipeline.group.queued'),
    plan: $t('pipeline.group.plan'),
    build: $t('pipeline.group.build'),
    ship: $t('pipeline.group.ship'),
    done: $t('pipeline.group.done'),
  });
  const columns = $derived(boardColumns(jobs));
  const open = $derived(columns.filter((c) => c.id !== 'done'));
  const done = $derived(columns.find((c) => c.id === 'done'));
</script>

<PageHeader title={$t('pipeline.title')}>
  {#snippet sub()}{$t('pipeline.active', { count: counts.active })} · <Icon name="branch" />{$t('pipeline.base')} <code class="font-mono">{data.config.base}</code> · <Icon name={data.config.tracker === 'github' ? 'github' : 'tracker'} />{$t('pipeline.tracker', { tracker: data.config.tracker })}{/snippet}
  {#snippet right()}
    <!-- Wraps on a phone: the riveted header clips what overflows it. -->
    <div class="seg slide-marker flex-wrap gap-y-1" {@attach slideMarker('.sel', 'fill')}>
      {#each FILTERS as f (f)}{@const on = S.filter === f}<button class="btn {on ? 'sel' : ''}" aria-pressed={on} onclick={() => setFilter(f)}>{filterLabel[f]} <span class="num {on ? '' : 'muted'}">({counts[f]})</span></button>{/each}
    </div>
    <div class="seg slide-marker" {@attach slideMarker('.sel', 'fill')}>
      {#each LAYOUTS as l (l)}{@const on = S.layout === l}<button class="btn {on ? 'sel' : ''}" aria-pressed={on} onclick={() => setLayout(l)}><Icon name={l} />{layoutLabel[l]}</button>{/each}
    </div>
<!--    <button class="btn primary flush" onclick={() => req({ type: 'next' })}>{$t('common.runNext')}</button>-->
  {/snippet}
</PageHeader>
{#if !jobs.length}
  <Empty>{$t('pipeline.empty')} <code class="mono text-fg">{$t('pipeline.cmdFeature')}</code> {$t('pipeline.or')} <code class="mono text-fg">{$t('pipeline.cmdNext')}</code>.</Empty>
{:else if S.layout === 'table'}
  <JobsTable {jobs} />
{:else}
  <div class="grid grid-cols-1 @min-[44rem]:grid-cols-2 @min-[60rem]:grid-cols-4 gap-3">
    {#each open as c (c.id)}
      {@const w = workingCount(c.jobs, data.daemons)}
      <!-- min-w-0: a long truncated title or chip must not widen its grid track. -->
      <section class="plate open min-w-0 flex flex-col @min-[60rem]:max-h-[calc(100vh-180px)]">
        <header class="plain flex items-center justify-between px-3 py-2 border-b border-line border-dashed"><span class="label text-fg">{groupLabel[c.id]}</span><span class="flex items-center gap-2">{#if w}<span class="label text-gleam">{$t('live.columnWorking', { count: w })}</span>{/if}<span class="mono muted num text-[11px]">{c.jobs.length}</span></span></header>
        <!-- p-2.5: room for a card's focus ring, which the scroller would otherwise clip. -->
        <div class="flex flex-col gap-2.5 p-2.5 overflow-y-auto overscroll-contain">
          {#each c.jobs as j (j.id)}<JobCard job={j} />{:else}<div class="plain caption muted text-center py-3">—</div>{/each}
        </div>
      </section>
    {/each}
  </div>
  {#if done}
    <section class="plate open mt-3">
      <header class="plain flex items-center justify-between px-3 py-2 border-b border-line border-dashed"><span class="label text-fg">{groupLabel.done}</span><span class="mono muted num text-[11px]">{done.jobs.length}</span></header>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(236px,1fr))] gap-2.5 p-2.5">
        {#each done.jobs as j (j.id)}<JobCard job={j} />{/each}
      </div>
    </section>
  {/if}
{/if}
