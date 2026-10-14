<!-- Analytics: how Forge itself is performing over a time window. -->
<script lang="ts">
  import PageHeader from '../components/PageHeader.svelte';
  import { dur, num, pct, tokensShort, usd } from '../lib/util.ts';
  import type { ApiState, UsageRow } from '../lib/types.ts';
  import { STATS_WINDOWS, jobMs, topJobsByUsage, usageBars } from '../lib/view.ts';
  import { S, openDrawer, setWindow } from '../lib/app.svelte.ts';
  import { t } from '../lib/locale.ts';

  let { data }: { data: ApiState } = $props();
  const s = $derived(S.stats);
  const jobs = $derived(topJobsByUsage(data.jobs));
</script>

{#snippet kpi(label: string, value: string, sub = '')}
  <div class="kpi"><div class="kpi-label">{label}</div><div class="kpi-value">{value}</div>{#if sub}<div class="text-[11px] text-muted">{sub}</div>{/if}</div>
{/snippet}

{#snippet usageTable(title: string, rows: Record<string, UsageRow>)}
  {@const bars = usageBars(rows)}
  <div class="card overflow-x-auto">
    <div class="px-3 pt-3 text-sm font-semibold">{title}</div>
    <table class="tbl">
      <thead><tr><th>{$t('analytics.name')}</th><th>{$t('common.runs')}</th><th class="w-1/3">{$t('common.tokens')}</th><th class="text-right">{$t('common.estCost')}</th></tr></thead>
      <tbody>
        {#each bars as { key, row, width } (key)}
          <tr>
            <td class="font-medium">{key}</td>
            <td class="tabular-nums">{row.runs}</td>
            <td><div class="flex items-center gap-2"><div class="h-1.5 rounded-full ember-bar" style="width:{width}%"></div><span class="text-[11px] text-muted tabular-nums">{tokensShort(row.tokens)}</span></div></td>
            <td class="text-right tabular-nums">{usd(row.estCostUsd)}</td>
          </tr>
        {:else}
          <tr><td colspan="4" class="text-muted">{$t('analytics.noUsage')}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
{/snippet}

<PageHeader title={$t('analytics.title')}>
  {#snippet sub()}{$t('analytics.sub')}{/snippet}
  {#snippet right()}<select class="input" value={S.window} onchange={(e) => setWindow(e.currentTarget.value)}>{#each STATS_WINDOWS as [v, l] (v)}<option value={v}>{l}</option>{/each}</select>{/snippet}
</PageHeader>
{#if !s}
  <div class="text-muted text-sm">{$t('common.loading')}</div>
{:else}
  {@const q = s.quality}
  {@const cov = s.cost.reportingCoverage}
  {@const deltaCov = q.humanDeltaCoverage ?? { merged: 0, measured: 0 }}
  <div class="grid gap-3 grid-cols-2 lg:grid-cols-3">
    {@render kpi($t('analytics.jobs'), num(s.counts.total), $t('analytics.jobsSub', { active: s.counts.active, done: s.counts.done, cancelled: s.counts.cancelled }))}
    {@render kpi($t('analytics.firstPass'), pct(q.firstPassReviewRate), $t('analytics.firstPassSub', { rounds: q.avgRounds ?? '—' }))}
    {@render kpi($t('analytics.escalation'), pct(q.escalationRate), $t('analytics.escalationSub', { count: q.humanReworks }))}
    {@render kpi($t('analytics.prFeedback'), pct(q.humanFeedbackOnPrRate), $t('analytics.prFeedbackSub'))}
    {@render kpi($t('analytics.delta'), pct(q.humanDeltaRate ?? null), $t('analytics.deltaSub', { lines: q.medianHumanDeltaLines ?? '—', measured: deltaCov.measured, merged: deltaCov.merged }))}
    {@render kpi($t('analytics.toPr'), s.speed.medianMinutesToPr == null ? '—' : $t('analytics.minutes', { count: s.speed.medianMinutesToPr }), $t('analytics.toPrSub', { minutes: s.speed.medianMinutesToDone ?? '—' }))}
    {@render kpi($t('analytics.verify'), pct(q.verifyFirstPassRate), $t('analytics.verifySub'))}
    {@render kpi($t('common.tokens'), tokensShort(s.cost.totalTokens), $t('analytics.tokensSub', { tokens: tokensShort(s.cost.avgTokensPerJob) }))}
    {@render kpi($t('analytics.cost'), usd(s.cost.estCostUsd), $t('analytics.costSub', { cost: usd(s.cost.avgCostPerJobUsd), withUsage: cov.withUsage, agentRuns: cov.agentRuns, exact: cov.exact }))}
  </div>
  <div class="grid gap-3 lg:grid-cols-2 mt-6">{@render usageTable($t('analytics.byRole'), s.cost.byRole)}{@render usageTable($t('analytics.byModel'), s.cost.byModel)}</div>
  <div class="card overflow-x-auto mt-6">
    <div class="px-3 pt-3 text-sm font-semibold">{$t('analytics.lenses')}</div>
    <table class="tbl">
      <thead><tr><th>{$t('common.lens')}</th><th>{$t('analytics.reviews')}</th><th>{$t('analytics.askedChanges')}</th></tr></thead>
      <tbody>
        {#each Object.entries(s.reviewers) as [k, v] (k)}
          <tr><td class="font-medium">{k}</td><td class="tabular-nums">{v.reviews}</td><td class="tabular-nums">{pct(v.changeRate)}</td></tr>
        {:else}
          <tr><td colspan="3" class="text-muted">{$t('analytics.noReviews')}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if jobs.length}
    <div class="card overflow-x-auto mt-6">
      <div class="px-3 pt-3 text-sm font-semibold">{$t('analytics.byUsage')}</div>
      <table class="tbl">
        <thead><tr><th>{$t('common.job')}</th><th>{$t('common.rounds')}</th><th>{$t('analytics.duration')}</th><th class="text-right">{$t('common.tokens')}</th><th class="text-right">{$t('common.estCost')}</th><th>{$t('analytics.usageSource')}</th></tr></thead>
        <tbody>
          {#each jobs as j (j.id)}
            <tr class="hover:bg-raised cursor-pointer" onclick={() => openDrawer(j.id)}>
              <td>{j.title}</td>
              <td class="tabular-nums">{j.round || '—'}</td>
              <td class="tabular-nums">{dur(jobMs(j))}</td>
              <td class="text-right tabular-nums">{num(j.usage.totalTokens)}</td>
              <td class="text-right tabular-nums">{usd(j.usage.estCostUsd)}</td>
              <td class="text-muted">{j.usage.exact ? $t('analytics.transcript') : $t('analytics.reported')}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
  <p class="text-[11px] text-muted mt-3">{$t('analytics.footnote')}</p>
{/if}
