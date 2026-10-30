<!-- A board card's budget chip: `budget N%` at 80% of a limit, `over budget` past it, with the worst row in its title;
     nothing below 80%, or for a finished job or one already waiting on its budget. The chip sits in a plain span, as it
     always has: as the flex item, the span's line box sets the state row's height, so dropping it would shift the card. -->
<script lang="ts">
  import Chip from '../ui/Chip.svelte';
  import { budgetChipModel, unattendedDefault } from '../../lib/metrics/budget.ts';
  import { S } from '../../lib/core/app.svelte.ts';
  import type { Job } from '../../lib/core/types.ts';

  let { job }: { job: Partial<Job> | null | undefined } = $props();
  const chip = $derived(budgetChipModel(job as Job, S.data?.config?.pipeline?.budget, unattendedDefault(S.data?.config)));
</script>

{#if chip}<span><Chip tone={chip.tone} text={chip.text} title={chip.title} /></span>{/if}
