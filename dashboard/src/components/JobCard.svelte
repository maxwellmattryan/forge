<!-- A board card: title, state, refs, dependencies, progress, verdicts and the usage footer. -->
<script lang="ts">
  import StateChip from './StateChip.svelte';
  import VerdictChip from './VerdictChip.svelte';
  import PrChip from './PrChip.svelte';
  import ProgressBar from './ProgressBar.svelte';
  import DepChips from './DepChips.svelte';
  import { budgetChip } from '../lib/budget.ts';
  import { ago, tokensShort } from '../lib/util.ts';
  import { cardRef, needsHuman, runningRoles } from '../lib/view.ts';
  import { S, openDrawer } from '../lib/app.svelte.ts';
  import type { StateJob } from '../lib/types.ts';
  import { t } from '../lib/locale.ts';

  let { job: j }: { job: StateJob } = $props();
  const verdicts = $derived(j.verdicts?.[j.round] ?? null);
  const running = $derived(runningRoles(j));
  const ref = $derived(cardRef(j));
</script>

<button class="sheet ticks clickable {needsHuman(j) ? 'redline' : ''} w-full text-left p-3 pb-2.5 flex flex-col gap-2" onclick={() => openDrawer(j.id)}>
  <span class="tk"></span>
  <div class="flex items-start justify-between gap-2"><span class="h card flex-1 min-w-0 line-clamp-2">{j.title}</span><StateChip job={j} /></div>
  <div class="mono muted text-[11px] flex flex-wrap items-center gap-1.5">{#if ref !== null}<span>{ref}</span>·{/if}<span class="truncate max-w-40">{j.id}</span></div>
  <DepChips job={j} />
  <ProgressBar progress={j.progress} />
  {#if j.reviewers?.length}
    <div class="flex flex-wrap gap-1">{#each j.reviewers as r, i (i)}<VerdictChip name={r} verdict={verdicts?.[r]} />{/each}</div>
  {/if}
  <div class="label flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px]">
    {#if j.round}<span>{$t('job.round', { round: j.round, max: j.maxRounds })}</span>{/if}<PrChip pr={j.pr} />{@html budgetChip(j, S.data?.config?.pipeline?.budget)}
    {#if running.length}<span class="flex items-center gap-1.5 text-ink"><span class="dot ink size-1.5"></span>{running.join(', ')}</span>{/if}
    <span class="ml-auto normal-case tracking-normal">{$t('job.usage', { tokens: tokensShort(j.usage?.totalTokens), ago: ago(j.updatedAt) })}</span>
  </div>
</button>
