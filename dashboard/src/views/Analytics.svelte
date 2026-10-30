<!-- Analytics: how Forge itself is performing over a time window. -->
<script lang="ts">
  import PageHeader from '../components/shell/PageHeader.svelte';
  import PeriodMeter from '../components/metrics/PeriodMeter.svelte';
  import Select from '../components/ui/Select.svelte';
  import AnalyticsStatsSkeleton from '../components/skeletons/metrics/AnalyticsStatsSkeleton.svelte';
  import { dur, num, pct, tokensShort, usd } from '../lib/core/util.ts';
  import type { ApiState, UsageRow } from '../lib/core/types.ts';
  import { STATS_WINDOWS, jobMs, jobsSummary, topJobsByUsage, usageBars } from '../lib/metrics/analytics.ts';
  import { S, openDrawer, setWindow } from '../lib/core/app.svelte.ts';
  import { t } from '../lib/text/locale.ts';

  // App renders a view only once S.data is loaded.
  const data = $derived(S.data as ApiState);
  const s = $derived(S.stats);
  const jobs = $derived(topJobsByUsage(data.jobs));
</script>

{#snippet kpi(label: string, value: string, sub = '')}
  <div class="plate kpi"><div class="label">{label}</div><div class="v">{value}</div>{#if sub}<div class="caption muted">{sub}</div>{/if}</div>
{/snippet}

{#snippet usageTable(title: string, rows: Record<string, UsageRow>)}
  {@const bars = usageBars(rows)}
  <div class="plate flat"><div class="label callout px-3 pt-3">{title}</div><div class="overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>{$t('analytics.name')}</th><th>{$t('common.runs')}</th><th class="w-1/3">{$t('common.tokens')}</th><th class="r">{$t('common.estCost')}</th></tr></thead>
      <tbody>
        {#each bars as { key, row, width } (key)}
          <tr>
            <td class="font-medium">{key}</td>
            <td class="num">{row.runs}</td>
            <td><div class="flex items-center gap-2"><div class="track flex-1"><div class="fill" style="width:{width}%"></div></div><span class="mono muted num text-[11px]">{tokensShort(row.tokens)}</span></div></td>
            <td class="r num">{usd(row.estCostUsd)}</td>
          </tr>
        {:else}
          <tr><td colspan="4" class="text-muted">{$t('analytics.noUsage')}</td></tr>
        {/each}
      </tbody>
    </table>
  </div></div>
{/snippet}

{#snippet minutesTable(title: string, keyHead: string, rows: Record<string, number>)}
  <div class="plate flat"><div class="label callout px-3 pt-3">{title}</div><div class="overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>{keyHead}</th><th class="r">{$t('analytics.median')}</th></tr></thead>
      <tbody>
        {#each Object.entries(rows) as [key, minutes] (key)}
          <tr><td class="font-medium">{key}</td><td class="r num">{$t('analytics.minutes', { count: minutes })}</td></tr>
        {:else}
          <tr><td colspan="2" class="text-muted">{$t('analytics.noTiming')}</td></tr>
        {/each}
      </tbody>
    </table>
  </div></div>
{/snippet}

<PageHeader title={$t('analytics.title')}>
  {#snippet sub()}{$t('analytics.sub')}{/snippet}
  {#snippet right()}<Select label={$t('analytics.window')} value={S.window} options={STATS_WINDOWS.map(([value, label]) => ({ value, label }))} onchange={setWindow} />{/snippet}
</PageHeader>
<PeriodMeter budget={data.budget} />
{#if !s}
  <AnalyticsStatsSkeleton />
{:else}
  {@const q = s.quality}
  {@const cov = s.cost.reportingCoverage}
  {@const deltaCov = q.humanDeltaCoverage ?? { merged: 0, measured: 0 }}
  {@const outcomes = q.outcomeCoverage ?? { merged: 0, final: 0, open: 0 }}
  {@const js = jobsSummary(s.counts)}
  <div class="grid gap-3 grid-cols-2 lg:grid-cols-3">
    {#if js.key === 'analytics.jobsSubArchived'}
      {@render kpi($t('analytics.jobs'), num(s.counts.total), $t('analytics.jobsSubArchived', js.params))}
    {:else}
      {@render kpi($t('analytics.jobs'), num(s.counts.total), $t('analytics.jobsSub', js.params))}
    {/if}
    {@render kpi($t('analytics.autonomy'), pct(q.autonomyRate ?? null), $t('analytics.autonomySub', { strict: pct(q.autonomyRateStrict ?? null), reverted: pct(q.revertRate ?? null), final: outcomes.final, merged: outcomes.merged }))}
    {@render kpi($t('analytics.firstPass'), pct(q.firstPassReviewRate), $t('analytics.firstPassSub', { rounds: q.avgRounds ?? '—' }))}
    {@render kpi($t('analytics.escalation'), pct(q.escalationRate), $t('analytics.escalationSub', { count: q.humanReworks }))}
    {@render kpi($t('analytics.prFeedback'), pct(q.humanFeedbackOnPrRate), $t('analytics.prFeedbackSub'))}
    {@render kpi($t('analytics.delta'), pct(q.humanDeltaRate ?? null), $t('analytics.deltaSub', { lines: q.medianHumanDeltaLines ?? '—', measured: deltaCov.measured, merged: deltaCov.merged }))}
    {@render kpi($t('analytics.toPr'), s.speed.medianMinutesToPr == null ? '—' : $t('analytics.minutes', { count: s.speed.medianMinutesToPr }), $t('analytics.toPrSub', { minutes: s.speed.medianMinutesToDone ?? '—' }))}
    {@render kpi($t('analytics.verify'), pct(q.verifyFirstPassRate), $t('analytics.verifySub'))}
    {@render kpi($t('common.tokens'), tokensShort(s.cost.totalTokens), $t('analytics.tokensSub', { tokens: tokensShort(s.cost.avgTokensPerJob) }))}
    {@render kpi($t('analytics.cost'), usd(s.cost.estCostUsd), $t('analytics.costSub', { cost: usd(s.cost.avgCostPerJobUsd), withUsage: cov.withUsage, agentRuns: cov.agentRuns, exact: cov.exact }))}
  </div>
  <div class="grid gap-3 lg:grid-cols-2 mt-6">{@render usageTable($t('analytics.byRole'), s.cost.byRole)}{@render usageTable($t('analytics.byModel'), s.cost.byModel)}{@render usageTable($t('analytics.bySession'), s.cost.sessions ?? {})}</div>
  <div class="plate flat mt-6"><div class="label callout px-3 pt-3">{$t('analytics.lenses')}</div><div class="overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>{$t('common.lens')}</th><th>{$t('analytics.reviews')}</th><th>{$t('analytics.askedChanges')}</th><th>{$t('analytics.blockers')}</th><th>{$t('analytics.soleChanges')}</th><th>{$t('analytics.reopened')}</th></tr></thead>
      <tbody>
        {#each Object.entries(s.reviewers) as [k, v] (k)}
          <!-- An older /api/stats has no sole or reopened counts. -->
          <tr><td class="font-medium">{k}</td><td class="num">{v.reviews}</td><td class="num">{pct(v.changeRate)}</td><td class="num">{v.blockers}</td><td class="num">{v.soleChanges ?? 0}</td><td class="num">{v.reopened ?? 0}</td></tr>
        {:else}
          <tr><td colspan="6" class="text-muted">{$t('analytics.noReviews')}</td></tr>
        {/each}
      </tbody>
    </table>
  </div></div>
  <div class="grid gap-3 lg:grid-cols-2 mt-6">{@render minutesTable($t('analytics.stageTime'), $t('analytics.stage'), s.speed.stageMinutes ?? {})}{@render minutesTable($t('analytics.parkedTime'), $t('analytics.waitingOn'), s.speed.waitingMinutes ?? {})}</div>
  {#if jobs.length}
    <div class="plate flat mt-6"><div class="label callout px-3 pt-3">{$t('analytics.byUsage')}</div><div class="overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>{$t('common.job')}</th><th>{$t('common.rounds')}</th><th>{$t('analytics.duration')}</th><th class="r">{$t('common.tokens')}</th><th class="r">{$t('common.estCost')}</th><th>{$t('analytics.usageSource')}</th></tr></thead>
        <tbody>
          {#each jobs as j (j.id)}
            <tr class="clickable" onclick={() => openDrawer(j.id)}>
              <td>{j.title}</td>
              <td class="num">{j.round || '—'}</td>
              <td class="num">{dur(jobMs(j))}</td>
              <td class="r num">{num(j.usage.totalTokens)}</td>
              <td class="r num">{usd(j.usage.estCostUsd)}</td>
              <td class="text-muted">{j.usage.exact ? $t('analytics.transcript') : $t('analytics.reported')}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div></div>
  {/if}
  <p class="plate w-fit max-w-full px-3 py-1.5 text-[11px] text-muted mt-3">{$t('analytics.footnote')}</p>
{/if}
