<!-- The Models popover's body, read-only: the builder's summary, one row per configured role and one per review lens
     (GET /api/roster, fetched each time it opens). Settings stays the only place to change a model. Model strings come
     from config.yml and the roster, and render as text. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { S, loadRoster } from '../../lib/app.svelte.ts';
  import { modelSummary, reviewerRows, roleRows, summaryText, type ModelLabel } from '../../lib/statusbar.ts';
  import { t } from '../../lib/locale.ts';

  const models = $derived(S.data?.config?.models ?? {});
  const summary = $derived(modelSummary(models));
  const roles = $derived(roleRows(models));
  const lenses = $derived(reviewerRows(S.roster, models));
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(() => {
    // The last roster stays shown while this one loads.
    loadRoster()
      .then(() => (error = null))
      .catch((e: unknown) => (error = e instanceof Error ? e.message : String(e)))
      .finally(() => (loading = false));
  });
</script>

{#snippet row(name: string, m: ModelLabel)}
  <li class="flex min-w-0 flex-wrap items-baseline gap-x-2 border-b border-line-soft py-1.5 last:border-b-0">
    <span class="mono w-28 shrink-0 truncate" title={name}>{name}</span>
    <span class="text-sm text-fg">{m.label ?? $t('statusbar.model.session')}</span>
    {#if m.raw !== m.label}<span class="mono muted break-all">{m.raw}</span>{/if}
    {#if m.inherited}<span class="text-xs text-muted">{$t('statusbar.model.inherits')}</span>{/if}
  </li>
{/snippet}

<div class="flex flex-col gap-4">
  <p class="text-sm text-fg">{summaryText(summary, $t('statusbar.model.session'), (effort) => $t('statusbar.model.effort', { effort }))}</p>
  <section class="flex flex-col gap-1" aria-labelledby="statusbar-roles">
    <h3 id="statusbar-roles" class="label">{$t('statusbar.model.roles')}</h3>
    <ul>{#each roles as r (r.role)}{@render row(r.role, r.model)}{/each}</ul>
  </section>
  <section class="flex flex-col gap-1" aria-labelledby="statusbar-reviewers">
    <h3 id="statusbar-reviewers" class="label">{$t('statusbar.model.reviewers')}</h3>
    {#if lenses.length}<ul>{#each lenses as r, i (i)}{@render row(r.name, r.model)}{/each}</ul>{/if}
    {#if error}
      <p class="text-sm text-bad break-words">{$t('statusbar.model.failed', { error })}</p>
    {:else if !lenses.length}
      <p class="text-sm text-muted">{loading ? $t('statusbar.model.loading') : $t('statusbar.model.noReviewers')}</p>
    {/if}
  </section>
  <p class="text-xs text-muted">{$t('statusbar.model.edit')}</p>
</div>
