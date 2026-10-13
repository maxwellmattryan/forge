<!-- Analytics: how Forge itself is performing over a time window. -->
<script lang="ts">
  import PageHeader from '../components/PageHeader.svelte';
  import { dur, num, pct, tokensShort, usd } from '../lib/util.ts';
  import type { ApiState, UsageRow } from '../lib/types.ts';
  import { STATS_WINDOWS, jobMs, topJobsByUsage, usageBars } from '../lib/view.ts';
  import { S, openDrawer, setWindow } from '../lib/app.svelte.ts';

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
      <thead><tr><th>Name</th><th>Runs</th><th class="w-1/3">Tokens</th><th class="text-right">Est. cost</th></tr></thead>
      <tbody>
        {#each bars as { key, row, width } (key)}
          <tr>
            <td class="font-medium">{key}</td>
            <td class="tabular-nums">{row.runs}</td>
            <td><div class="flex items-center gap-2"><div class="h-1.5 rounded-full ember-bar" style="width:{width}%"></div><span class="text-[11px] text-muted tabular-nums">{tokensShort(row.tokens)}</span></div></td>
            <td class="text-right tabular-nums">{usd(row.estCostUsd)}</td>
          </tr>
        {:else}
          <tr><td colspan="4" class="text-muted">No usage recorded yet.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
{/snippet}

<PageHeader title="Analytics">
  {#snippet sub()}How Forge itself is performing. Comparable across repos because it measures the process, not the code.{/snippet}
  {#snippet right()}<select value={S.window} onchange={(e) => setWindow(e.currentTarget.value)}>{#each STATS_WINDOWS as [v, l] (v)}<option value={v}>{l}</option>{/each}</select>{/snippet}
</PageHeader>
{#if !s}
  <div class="text-muted text-sm">Loading…</div>
{:else}
  {@const q = s.quality}
  {@const cov = s.cost.reportingCoverage}
  {@const deltaCov = q.humanDeltaCoverage ?? { merged: 0, measured: 0 }}
  <div class="grid gap-3 grid-cols-2 lg:grid-cols-3">
    {@render kpi('Jobs', num(s.counts.total), `${s.counts.active} active · ${s.counts.done} done · ${s.counts.cancelled} cancelled`)}
    {@render kpi('First-pass review', pct(q.firstPassReviewRate), `avg ${q.avgRounds ?? '—'} rounds`)}
    {@render kpi('Escalation rate', pct(q.escalationRate), `${q.humanReworks} human rework(s)`)}
    {@render kpi('Human feedback on PRs', pct(q.humanFeedbackOnPrRate), 'PRs with unresolved threads')}
    {@render kpi('Human delta after push', pct(q.humanDeltaRate ?? null), `median ${q.medianHumanDeltaLines ?? '—'} lines · ${deltaCov.measured} of ${deltaCov.merged} merged measured`)}
    {@render kpi('Median to PR', s.speed.medianMinutesToPr == null ? '—' : `${s.speed.medianMinutesToPr}m`, `to done ${s.speed.medianMinutesToDone ?? '—'}m`)}
    {@render kpi('Verify first-pass', pct(q.verifyFirstPassRate), 'build/lint/test before review')}
    {@render kpi('Tokens', tokensShort(s.cost.totalTokens), `${tokensShort(s.cost.avgTokensPerJob)} per job`)}
    {@render kpi('API-equivalent cost', usd(s.cost.estCostUsd), `${usd(s.cost.avgCostPerJobUsd)} per job · coverage ${cov.withUsage}/${cov.agentRuns} (${cov.exact} exact)`)}
  </div>
  <div class="grid gap-3 lg:grid-cols-2 mt-6">{@render usageTable('By role', s.cost.byRole)}{@render usageTable('By model', s.cost.byModel)}</div>
  <div class="card overflow-x-auto mt-6">
    <div class="px-3 pt-3 text-sm font-semibold">Review lenses</div>
    <table class="tbl">
      <thead><tr><th>Lens</th><th>Reviews</th><th>Asked for changes</th></tr></thead>
      <tbody>
        {#each Object.entries(s.reviewers) as [k, v] (k)}
          <tr><td class="font-medium">{k}</td><td class="tabular-nums">{v.reviews}</td><td class="tabular-nums">{pct(v.changeRate)}</td></tr>
        {:else}
          <tr><td colspan="3" class="text-muted">No reviews yet.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if jobs.length}
    <div class="card overflow-x-auto mt-6">
      <div class="px-3 pt-3 text-sm font-semibold">Jobs by usage</div>
      <table class="tbl">
        <thead><tr><th>Job</th><th>Rounds</th><th>Duration</th><th class="text-right">Tokens</th><th class="text-right">Est. cost</th><th>Usage source</th></tr></thead>
        <tbody>
          {#each jobs as j (j.id)}
            <tr class="hover:bg-raised cursor-pointer" onclick={() => openDrawer(j.id)}>
              <td>{j.title}</td>
              <td class="tabular-nums">{j.round || '—'}</td>
              <td class="tabular-nums">{dur(jobMs(j))}</td>
              <td class="text-right tabular-nums">{num(j.usage.totalTokens)}</td>
              <td class="text-right tabular-nums">{usd(j.usage.estCostUsd)}</td>
              <td class="text-muted">{j.usage.exact ? 'transcript' : 'reported total'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
  <p class="text-[11px] text-muted mt-3">Costs are API list-price equivalents. Subscription plans are not billed per token.</p>
{/if}
