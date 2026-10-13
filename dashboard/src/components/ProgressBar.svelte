<!-- tasks.md progress: a bar and done/total; nothing without tasks. -->
<script lang="ts">
  import { progressWidth } from '../lib/view.ts';
  import type { Progress } from '../lib/types.ts';

  let { progress }: { progress: Progress | null | undefined } = $props();
  const width = $derived(progressWidth(progress));
</script>

{#if progress && width !== null}
  <div class="flex items-center gap-2"><div class="h-1.5 flex-1 rounded-full bg-raised overflow-hidden"><div class="h-full ember-bar" style="width:{width}%"></div></div><span class="text-[11px] text-muted tabular-nums">{progress.done}/{progress.total}</span></div>
{/if}
