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

  let { job: j }: { job: StateJob } = $props();
  const verdicts = $derived(j.verdicts?.[j.round] ?? null);
  const running = $derived(runningRoles(j));
  const ref = $derived(cardRef(j));
</script>

<button class="text-left card bg-panel hover:border-accent/50 p-3 flex flex-col gap-2 {needsHuman(j) ? 'border-warn/50' : ''}" onclick={() => openDrawer(j.id)}>
  <div class="flex items-start justify-between gap-2"><span class="text-sm font-medium leading-5 line-clamp-2">{j.title}</span><StateChip job={j} /></div>
  <div class="flex flex-wrap items-center gap-1.5 text-[11px] text-muted font-mono">{#if ref !== null}<span>{ref}</span>·{/if}<span class="truncate max-w-40">{j.id}</span></div>
  <DepChips job={j} />
  <ProgressBar progress={j.progress} />
  {#if j.reviewers?.length}
    <div class="flex flex-wrap gap-1">{#each j.reviewers as r, i (i)}<VerdictChip name={r} verdict={verdicts?.[r]} />{/each}</div>
  {/if}
  <div class="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
    {#if j.round}<span>round {j.round}/{j.maxRounds}</span>{/if}<PrChip pr={j.pr} />{@html budgetChip(j, S.data?.config?.pipeline?.budget)}
    {#if running.length}<span class="text-accent">● {running.join(', ')}</span>{/if}
    <span class="ml-auto">{tokensShort(j.usage?.totalTokens)} tok · {ago(j.updatedAt)}</span>
  </div>
</button>
