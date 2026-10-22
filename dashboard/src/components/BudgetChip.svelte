<!-- A board card's budget chip: `budget N%` at 80% of a limit, `over budget` past it, with the worst row in its title;
     nothing below 80%, or for a finished job or one already waiting on its budget. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import { budgetChipModel, unattendedDefault } from '../lib/budget.ts';
  import { S } from '../lib/app.svelte.ts';
  import type { Job } from '../lib/types.ts';

  let { job }: { job: Partial<Job> | null | undefined } = $props();
  const chip = $derived(budgetChipModel(job as Job, S.data?.config?.pipeline?.budget, unattendedDefault(S.data?.config)));
</script>

{#if chip}<Chip tone={chip.tone} text={chip.text} title={chip.title} />{/if}
