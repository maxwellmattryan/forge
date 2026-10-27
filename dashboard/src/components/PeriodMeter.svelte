<!-- Analytics' period meter: repo spend this UTC month against the effective budget.usdPerMonth, remaining and the
     projected month-end, with today's spend against usdPerDay underneath. Built from /api/state.budget, not the windowed
     stats. The reason is the CLI's own text and renders as text. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import AnalyticsPeriodMeterSkeleton from './skeletons/AnalyticsPeriodMeterSkeleton.svelte';
  import type { RepoBudgetStatus } from '../lib/types.ts';
  import { TONE_MOD, dayMeter, money, monthMeter, spentMoney } from '../lib/repo-budget.ts';
  import { t } from '../lib/locale.ts';

  let { budget }: { budget: RepoBudgetStatus | undefined } = $props();
  const m = $derived(budget ? monthMeter(budget) : null);
  const d = $derived(budget ? dayMeter(budget) : null);
</script>

{#if !budget || !m || !d}
  <AnalyticsPeriodMeterSkeleton />
{:else}
  <section class="plate p-4 mb-6 flex flex-col gap-3" aria-labelledby="period-meter">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 id="period-meter" class="label">{$t('budget.meterTitle', { month: budget.month })}</h2>
      {#if budget.held}<Chip tone="bad" text={$t('budget.holding')} />{:else if budget.reason}<Chip tone="warn" text={$t('budget.warnOnly')} />{/if}
    </div>
    <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span class="font-mono text-[28px] leading-8 font-medium num">{spentMoney(m.spent)}</span>
      <span class="muted">{m.cap === null ? $t('budget.unlimited') : $t('budget.ofCap', { cap: money(m.cap) })}</span>
    </div>
    {#if m.percent !== null}
      <div class="track" role="meter" aria-label={$t('budget.meterLabel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={m.percent} aria-valuetext={$t('budget.valueText', { spent: spentMoney(m.spent), cap: money(m.cap) })}><div class="fill {TONE_MOD[m.tone]}" style="width:{m.percent}%"></div></div>
    {/if}
    <div class="caption muted flex flex-wrap gap-x-4 gap-y-1">
      {#if m.remaining !== null}<span class="num">{$t('budget.remaining', { amount: money(m.remaining) })}</span>{/if}
      <span class="num">{$t('budget.projected', { amount: spentMoney(budget.projectedMonthUsd) })}</span>
    </div>
    {#if budget.reason}<p class="text-[13px] {budget.held ? 'text-bad' : 'text-warn'}">{budget.reason}</p>{/if}
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
      <span class="label text-[10px]">{$t('budget.today')}</span>
      <span class="num">{d.cap === null ? $t('budget.todayUncapped', { spent: spentMoney(d.spent) }) : $t('budget.todayOf', { spent: spentMoney(d.spent), cap: money(d.cap) })}</span>
      {#if d.percent !== null}
        <div class="track flex-1 min-w-24 max-w-64" role="meter" aria-label={$t('budget.dayLabel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={d.percent} aria-valuetext={$t('budget.valueText', { spent: spentMoney(d.spent), cap: money(d.cap) })}><div class="fill {TONE_MOD[d.tone]}" style="width:{d.percent}%"></div></div>
      {/if}
    </div>
  </section>
{/if}
