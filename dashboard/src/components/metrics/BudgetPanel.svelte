<!-- A job's budget, one row per limit: used / limit with a bar in the row's tone. The drawer's Budget card has a heading
     and the checked line; `compact` (the budget gate's inbox card) is the rows alone. -->
<script lang="ts">
  import { budgetPanelModel, unattendedDefault } from '../../lib/metrics/budget.ts';
  import { S } from '../../lib/core/app.svelte.ts';
  import type { Job } from '../../lib/core/types.ts';
  import { t } from '../../lib/text/locale.ts';

  let { job, compact = false }: { job: Partial<Job> | null | undefined; compact?: boolean } = $props();
  const model = $derived(budgetPanelModel(job as Job, S.data?.config?.pipeline?.budget, { compact, jobDefault: unattendedDefault(S.data?.config) }));
</script>

{#snippet rows()}
  <!-- The value and the space before the note stay one text node: split, Chrome shapes the row a pixel differently. -->
  <div class="flex flex-col">{#each model.rows as row (row.key)}<div class="grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3 gap-y-1 py-1"><div class="label">{row.label}</div><div class="text-sm tabular-nums text-right md:text-left break-words {row.bad ? 'text-bad' : ''}">{#if row.note}{row.value} <span class="text-muted">{row.note}</span>{:else}{row.value}{/if}</div>{#if row.bar}<div class="col-span-2 md:col-span-1 track"><div class="fill {row.bar.tone}" style="width:{row.bar.width}%"></div></div>{:else}<div class="hidden md:block"></div>{/if}</div>{/each}</div>
{/snippet}

{#if compact}{@render rows()}{:else}<div class="plate p-4 flex flex-col gap-2"><div class="flex flex-wrap items-center justify-between gap-2"><h3 class="h section">{$t('drawer.budgetCard')}</h3><span class="label">{model.checked}</span></div>{@render rows()}</div>{/if}
