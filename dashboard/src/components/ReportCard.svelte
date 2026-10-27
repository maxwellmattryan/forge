<!-- A mandate's report card on its MandateCard: one card only (shownCard: the live one, or a closed mandate's closing
     summary card), with a source line saying which. An empty card is one muted line; otherwise a term grid of what
     merged, how it scored, how much review and human help it took and what happened after the merges, then the score and
     outcome counts. A figure still waiting on a measurement is a pending chip whose title says what it waits on, and one
     with nothing to measure is a dash read out as "nothing to measure": neither ever shows as 0. Spend is left out, as
     Progress shows the same figures. Every value is a number or a date and renders as Svelte text. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import { WAIT_LABEL } from '../lib/labels.ts';
  import { cardDate, figureView, gateCounts, shownCard } from '../lib/report-card.ts';
  import { num, pct } from '../lib/util.ts';
  import { t } from '../lib/locale.ts';
  import type { CardFigure, MandateRow } from '../lib/types.ts';

  let { m }: { m: MandateRow } = $props();

  const shown = $derived(shownCard(m));
  const c = $derived(shown.card);
  const source = $derived(
    shown.source === 'live' || shown.at === null
      ? $t('foreman.card.live')
      : shown.source === 'close'
        ? $t('foreman.card.atClose', { date: cardDate(shown.at) })
        : $t('foreman.card.final', { date: cardDate(shown.at) }),
  );
  const gates = $derived(gateCounts(c.interventions.byGate).map((g) => `${g.key === 'none' ? $t('foreman.card.noGate') : WAIT_LABEL[g.key]} ${num(g.count)}`));
  const pendingScores = $derived($t('foreman.card.pendingScores', { count: c.scores.pending }));
  const pendingOutcomes = $derived($t('foreman.card.pendingOutcomes', { count: c.outcomes.open }));
  const headingId = $derived(`mandate-card-${m.id}`);
</script>

{#snippet nothing()}<span aria-hidden="true">—</span><span class="sr-only">{$t('foreman.card.none')}</span>{/snippet}

{#snippet fig(f: CardFigure, text: (n: number) => string, pendingTitle?: string)}
  {@const v = figureView(f)}
  {#if v.kind === 'value'}{text(v.value)}{:else if v.kind === 'pending'}<Chip tone="info" title={pendingTitle} text={$t('foreman.card.pending')} />{:else}{@render nothing()}{/if}
{/snippet}

<section class="flex flex-col gap-1" aria-labelledby={headingId}>
  <div class="flex flex-wrap items-baseline gap-x-2">
    <h4 id={headingId} class="label text-[10px]">{$t('foreman.card.title')}</h4>
    <span class="text-muted text-[11px]">{source}</span>
  </div>
  {#if c.jobs.total === 0}
    <p class="text-[13px] text-muted">{$t('foreman.card.empty')}</p>
  {:else}
    <dl class="grid gap-x-4 gap-y-2 grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]">
      <div class="min-w-0"><dt class="label text-[10px]">{$t('foreman.card.merged')}</dt><dd class="mono text-[12px] break-words">{$t('foreman.card.mergedValue', { merged: num(c.jobs.merged), total: num(c.jobs.total) })}</dd></div>
      <div class="min-w-0"><dt class="label text-[10px]">{$t('foreman.card.median')}</dt><dd class="mono text-[12px] break-words">{@render fig(c.scores.median, (n) => $t('foreman.card.scoreValue', { score: String(n) }), pendingScores)}</dd></div>
      <div class="min-w-0"><dt class="label text-[10px]">{$t('foreman.card.below3')}</dt><dd class="mono text-[12px] break-words">{@render fig(c.scores.below3, num, pendingScores)}</dd></div>
      <div class="min-w-0"><dt class="label text-[10px]">{$t('foreman.card.avgRounds')}</dt><dd class="mono text-[12px] break-words">{@render fig(c.review.avgRounds, String)}</dd></div>
      <div class="min-w-0"><dt class="label text-[10px]">{$t('foreman.card.firstPass')}</dt><dd class="mono text-[12px] break-words">{@render fig(c.review.firstPassRate, pct)}</dd></div>
      <div class="min-w-0">
        <dt class="label text-[10px]">{$t('foreman.card.interventions')}</dt>
        <dd class="mono text-[12px] break-words">{num(c.interventions.total)}</dd>
        {#if gates.length}<dd class="text-muted text-[11px] break-words">{gates.join(' · ')}</dd>{/if}
      </div>
      <div class="min-w-0"><dt class="label text-[10px]">{$t('foreman.card.reverted')}</dt><dd class="mono text-[12px] break-words">{@render fig(c.outcomes.reverted, num, pendingOutcomes)}</dd></div>
      <div class="min-w-0"><dt class="label text-[10px]">{$t('foreman.card.followedUp')}</dt><dd class="mono text-[12px] break-words">{@render fig(c.outcomes.followedUp, num, pendingOutcomes)}</dd></div>
      <div class="min-w-0"><dt class="label text-[10px]">{$t('foreman.card.finalAt')}</dt><dd class="mono text-[12px] break-words">{#if c.outcomes.finalAt}{cardDate(c.outcomes.finalAt)}{:else}{@render nothing()}{/if}</dd></div>
    </dl>
    <p class="text-muted text-[12px] num">{$t('foreman.card.scoreCounts', { scored: num(c.scores.scored), pending: num(c.scores.pending), held: num(c.scores.held), failed: num(c.scores.failed), unscored: num(c.scores.unscored) })}</p>
    <p class="text-muted text-[12px] num">{$t('foreman.card.outcomeCounts', { final: num(c.outcomes.final), open: num(c.outcomes.open), unmeasured: num(c.outcomes.unmeasured) })}</p>
  {/if}
</section>
