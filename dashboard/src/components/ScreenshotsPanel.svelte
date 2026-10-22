<!-- The drawer's Screenshots card: a tile per file in the job's screenshots/ dir, each opening the image in a new tab;
     nothing without files. Names are agent-chosen, so they render as text and the URLs go through safeUrl. -->
<script lang="ts">
  import { screenshotTiles } from '../lib/screenshots.ts';
  import { safeUrl } from '../lib/markdown.ts';
  import { t } from '../lib/locale.ts';

  let { jobId, files }: { jobId: string; files: string[] } = $props();
  const tiles = $derived(screenshotTiles(jobId, files));
</script>

{#if tiles.length}
  <div class="plate p-4 flex flex-col gap-3"><div class="flex items-center justify-between gap-2"><h3 class="h section">{$t('drawer.screenshotsCard')}</h3><span class="label">{files.length}</span></div><div class="grid grid-cols-2 md:grid-cols-3 gap-2">{#each tiles as tile, i (i)}{@const href = safeUrl(tile.url)}<a class="plate clickable block min-w-0 p-1" href={href} target="_blank" rel="noopener"><img loading="lazy" alt={tile.name} class="w-full h-32 object-contain bg-panel" src={href}><div class="mt-1 truncate font-mono text-[11px] text-muted">{tile.name}</div></a>{/each}</div></div>
{/if}
