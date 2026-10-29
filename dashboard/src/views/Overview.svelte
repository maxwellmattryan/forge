<!-- Overview: one card per registered project from GET /api/projects (S.machine), what waits on you first; then the jobs
     shipped and cost per UTC day stacked by project (GET /api/projects/stats, S.overview, over the overviewWindow pref);
     then the machine cap and today's and this month's spend. A card's name opens its Pipeline, and its waiting count
     opens it on the Waiting filter (written to that project's filter pref before the navigation). A missing or
     unavailable project is plain text with its chip. Job titles are job text and render as text. -->
<script lang="ts">
  import Banner from '../components/Banner.svelte';
  import Chip from '../components/Chip.svelte';
  import Empty from '../components/Empty.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Loading from '../components/Loading.svelte';
  import OverviewCardsSkeleton from '../components/skeletons/OverviewCardsSkeleton.svelte';
  import OverviewGraphSkeleton from '../components/skeletons/OverviewGraphSkeleton.svelte';
  import Select from '../components/Select.svelte';
  import StackedBars from '../components/StackedBars.svelte';
  import { S, setOverviewWindow } from '../lib/core/app.svelte.ts';
  import { OVERVIEW_WINDOWS, overviewCards, stackedSeries, type OverviewCard } from '../lib/metrics/overview.ts';
  import { pref } from '../lib/settings/prefs.ts';
  import { ago, num, usd } from '../lib/core/util.ts';
  import { ticker } from '../lib/core/clock.svelte.ts';
  import { t } from '../lib/text/locale.ts';

  const cards = $derived(overviewCards(S.machine));
  const shipped = $derived(S.overview ? stackedSeries(S.overview, 'shipped') : null);
  const cost = $derived(S.overview ? stackedSeries(S.overview, 'costUsd') : null);
  const spend = $derived(
    S.overview ? S.overview.projects.reduce((n, p) => ({ day: n.day + p.dayUsd, month: n.month + p.monthUsd }), { day: 0, month: 0 }) : null,
  );
  const cap = $derived(S.machine?.machine ?? null);
  const capPercent = $derived(cap && cap.maxConcurrent > 0 ? Math.min(100, Math.round((cap.live / cap.maxConcurrent) * 100)) : 0);

  const foremanText = (f: OverviewCard['foreman']): string =>
    f === 'none' ? $t('overview.foremanNone') : f === 'idle' ? $t('overview.foremanIdle') : f === 'busy' ? $t('overview.foremanBusy') : f === 'stopping' ? $t('overview.foremanStopping') : $t('overview.foremanOff');
  const foremanTone = (f: OverviewCard['foreman']): string => (f === 'busy' ? 'gleam' : f === 'idle' ? 'ok' : f === 'stopping' ? 'warn' : 'muted');
</script>

{#snippet fact(label: string)}
  <dt class="label">{label}</dt>
{/snippet}

{#snippet card(c: OverviewCard)}
  <article class="plate p-4 flex flex-col gap-3 min-w-0">
    <header class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 min-w-0">
      {#if c.openable}
        <a class="font-mono text-[15px] font-medium text-fg underline-offset-2 hover:underline truncate" href="#/p/{c.name}/pipeline">{c.name}</a>
      {:else}
        <span class="font-mono text-[15px] font-medium text-muted truncate">{c.name}</span>
        <Chip tone={c.state === 'missing' ? 'warn' : 'muted'} text={c.state === 'missing' ? $t('switcher.missing') : $t('switcher.unavailable')} />
      {/if}
    </header>
    {#if c.openable}
      <dl class="grid grid-cols-2 gap-x-4 gap-y-3">
        <div class="flex flex-col gap-0.5">{@render fact($t('overview.active'))}<dd class="font-mono text-lg num">{c.active}</dd></div>
        <div class="flex flex-col gap-0.5">
          {@render fact($t('overview.waiting'))}
          <dd class="font-mono text-lg num">
            {#if c.waitingHref}
              <a href="#/p/{c.name}/pipeline" aria-label={$t('overview.waitingLink', { project: c.name })} onclick={() => pref.setFor(c.name, 'filter', 'waiting')}><Chip tone="you" text={c.waiting} /></a>
            {:else}0{/if}
          </dd>
        </div>
        <div class="flex flex-col gap-0.5">{@render fact($t('overview.foreman'))}<dd><Chip tone={foremanTone(c.foreman)} text={foremanText(c.foreman)} /></dd></div>
        <div class="flex flex-col gap-0.5">{@render fact($t('overview.sessions'))}<dd class="font-mono text-lg num">{c.daemon ? `${c.daemon.live}/${c.daemon.maxConcurrent}` : '—'}</dd></div>
      </dl>
      <div class="flex flex-col gap-0.5 min-w-0">
        {@render fact($t('overview.latest'))}
        {#if c.latest}
          <p class="flex items-baseline gap-2 min-w-0 text-sm"><span class="truncate text-fg" title={c.latest.title}>{c.latest.title}</span><span class="caption muted whitespace-nowrap num">{ago(c.latest.at, ticker.now)}</span></p>
        {:else}
          <p class="text-sm text-muted">{$t('overview.noActivity')}</p>
        {/if}
      </div>
    {:else}
      <p class="truncate font-mono text-xs text-muted" title={c.path}>{c.path}</p>
    {/if}
  </article>
{/snippet}

{#snippet graph(id: string, title: string, label: string, s: ReturnType<typeof stackedSeries> | null, format: (n: number) => string, empty: string)}
  <section class="plate p-4 flex flex-col gap-3 min-w-0" aria-labelledby={id}>
    <h2 {id} class="label callout">{title}</h2>
    {#if s}
      <StackedBars series={s} {label} {format} {empty} />
    {:else if !S.overviewError}
      <Loading><OverviewGraphSkeleton /></Loading>
    {/if}
  </section>
{/snippet}

<PageHeader title={$t('overview.title')}>
  {#snippet sub()}{$t('overview.sub')}{/snippet}
  {#snippet right()}<Select label={$t('overview.window')} value={S.overviewWindow} options={OVERVIEW_WINDOWS.map(([value, label]) => ({ value, label }))} onchange={setOverviewWindow} />{/snippet}
</PageHeader>
{#if S.machineLost}<Banner msg={S.machineLost} />{/if}
{#if S.machine?.error}<Banner msg={$t('overview.indexError', { error: S.machine.error })} />{/if}
{#if !S.machine}
  {#if S.machineOnline !== false}<OverviewCardsSkeleton />{/if}
{:else if !cards.length}
  <Empty>{$t('overview.empty')}</Empty>
{:else}
  <h2 class="sr-only">{$t('overview.projects')}</h2>
  <div class="grid gap-3 md:grid-cols-2 2xl:grid-cols-3 mb-6">
    {#each cards as c (c.name)}{@render card(c)}{/each}
  </div>
  {#if S.overviewError}<p class="plate w-fit px-3 py-1.5 mb-3 text-sm text-bad">{$t('overview.statsError', { error: S.overviewError })}</p>{/if}
  <div class="grid gap-3 lg:grid-cols-2 mb-6">
    {@render graph('overview-shipped', $t('overview.shippedTitle'), $t('overview.shippedLabel'), shipped, num, $t('overview.noShipped'))}
    {@render graph('overview-cost', $t('overview.costTitle'), $t('overview.costLabel'), cost, usd, $t('overview.noCost'))}
  </div>
  <section class="plate p-4 flex flex-col gap-3" aria-labelledby="overview-machine">
    <h2 id="overview-machine" class="label callout">{$t('overview.machineTitle')}</h2>
    <div class="grid gap-4 md:grid-cols-3">
      <div class="flex flex-col gap-2 min-w-0">
        <span class="label">{$t('overview.machineCap')}</span>
        {#if cap}
          <span class="font-mono text-sm num">{$t('overview.machineLive', { live: cap.live, cap: cap.maxConcurrent })}</span>
          <div class="track" role="meter" aria-label={$t('overview.machineMeter')} aria-valuemin={0} aria-valuemax={cap.maxConcurrent} aria-valuenow={cap.live} aria-valuetext={$t('overview.machineLive', { live: cap.live, cap: cap.maxConcurrent })}><div class="fill {capPercent >= 100 ? 'warn' : ''}" style="width:{capPercent}%"></div></div>
          <span class="caption muted">{cap.source === 'auto' ? $t('machine.sourceAuto') : $t('machine.sourceSettings')}</span>
        {/if}
      </div>
      <div class="kpi p-0">
        <span class="label">{$t('overview.spendToday')}</span>
        <span class="v">{spend ? usd(spend.day) : '—'}</span>
        <span class="caption muted">{$t('overview.spendSub')}</span>
      </div>
      <div class="kpi p-0">
        <span class="label">{$t('overview.spendMonth')}</span>
        <span class="v">{spend ? usd(spend.month) : '—'}</span>
        <span class="caption muted">{$t('overview.spendSub')}</span>
      </div>
    </div>
  </section>
{/if}
