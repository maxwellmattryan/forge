<!-- Settings › About: versions from GET /api/about, and links to the repository and docs. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import Banner from '../Banner.svelte';
  import { t } from '../../lib/locale.ts';
  import { safeUrl } from '../../lib/markdown.ts';
  import type { SettingsSession } from '../../lib/settings-session.svelte.ts';

  let { session }: { session: SettingsSession } = $props();

  const a = $derived(session.about);
  const repo = $derived(safeUrl(a?.links.repo));
  const docs = $derived(safeUrl(a?.links.docs));

  onMount(() => {
    session.loadAbout();
  });
</script>

{#snippet fact(label: string, value: unknown, mono = false)}
  <div class="flex flex-col sm:flex-row sm:gap-4 py-2 border-b border-line last:border-b-0 min-w-0"><dt class="text-xs text-muted sm:w-40 shrink-0 sm:pt-0.5">{label}</dt><dd class="text-sm min-w-0 {mono ? 'font-mono break-all' : ''}">{value}</dd></div>
{/snippet}

<div class="p-4 md:p-6 flex flex-col gap-4">
  {#if session.aboutLoading}
    <div class="text-sm text-muted" aria-live="polite">{$t('settings.loading')}</div>
  {:else if session.aboutError}
    <Banner msg={session.aboutError} />
    <button class="btn self-start" onclick={() => session.loadAbout()}>{$t('settings.retry')}</button>
  {:else if a}
    <dl class="sheet px-4">
      {@render fact($t('settings.about.version'), a.forgeVersion)}
      {@render fact($t('settings.about.pluginRoot'), a.pluginRoot, true)}
      {@render fact($t('settings.about.api'), a.apiVersion)}
      {@render fact($t('settings.about.schemas'), $t('settings.about.schemaValues', { config: a.schemaVersions.config, job: a.schemaVersions.job, event: a.schemaVersions.event }))}
      {@render fact($t('settings.about.pricing'), a.pricingAsOf ?? '—')}
      {@render fact($t('settings.about.node'), a.node)}
    </dl>
    <div class="flex flex-wrap gap-2">
      {#if repo}<a class="btn min-h-11 md:min-h-0" href={repo} target="_blank" rel="noopener noreferrer">{$t('settings.about.repo')}</a>{/if}
      {#if docs}<a class="btn min-h-11 md:min-h-0" href={docs} target="_blank" rel="noopener noreferrer">{$t('settings.about.docs')}</a>{/if}
    </div>
  {/if}
</div>
