<!-- tasks.md progress: a bar and done/total; nothing without tasks. -->
<script lang="ts">
  import { progressWidth } from '../lib/job-state.ts';
  import type { Progress } from '../lib/types.ts';

  let { progress }: { progress: Progress | null | undefined } = $props();
  const width = $derived(progressWidth(progress));
</script>

{#if progress && width !== null}
  <div class="flex items-center gap-2"><div class="track flex-1"><div class="fill" style="width:{width}%"></div></div><span class="mono muted num text-[11px]">{progress.done}/{progress.total}</span></div>
{/if}
