<!-- The jobs table's Budget cell: the budget chip when there is one, else the worst row's muted percent, else a dash. -->
<script lang="ts">
  import BudgetChip from './BudgetChip.svelte';
  import { budgetCellModel, unattendedDefault } from '../lib/metrics/budget.ts';
  import { S } from '../lib/core/app.svelte.ts';
  import type { Job } from '../lib/core/types.ts';

  let { job }: { job: Partial<Job> | null | undefined } = $props();
  const cell = $derived(budgetCellModel(job as Job, S.data?.config?.pipeline?.budget, unattendedDefault(S.data?.config)));
</script>

{#if cell.kind === 'chip'}<BudgetChip {job} />{:else if cell.kind === 'text'}<span class="text-muted tabular-nums">{cell.text}</span>{:else}—{/if}
