<!-- The drawer's Dependencies card: "Depends on" and "Blocks" rows, each only when non-empty. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import { blockLinks, depHint, depLinks, type DepLink } from '../lib/deps.ts';
  import { S, openDrawer } from '../lib/app.svelte.ts';
  import type { Job } from '../lib/types.ts';
  import { t } from '../lib/locale.ts';

  let { job }: { job: Partial<Job> } = $props();
  const deps = $derived(depLinks(job, S.data?.jobs ?? []));
  const blocks = $derived(blockLinks(job, S.data?.jobs ?? []));
</script>

{#snippet row(label: string, links: DepLink[])}
  {#if links.length}
    <div class="flex items-start gap-2"><div class="label w-20 shrink-0 pt-2">{label}</div><div class="flex flex-wrap gap-2 min-w-0">{#each links as l, i (i)}<button title={depHint(l)} class="btn sm font-mono" onclick={() => openDrawer(l.id)}>{l.id} <Chip tone={l.tone} text={l.state} /></button>{/each}</div></div>
  {/if}
{/snippet}

{#if deps.length || blocks.length}
  <div class="plate p-4 flex flex-col gap-2.5"><h3 class="h section">{$t('deps.title')}</h3>{@render row($t('deps.dependsOn'), deps)}{@render row($t('deps.blocks'), blocks)}</div>
{/if}
