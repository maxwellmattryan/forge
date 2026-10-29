<!-- A warning banner: lost connection, newer API, missing config or a load error. Drawn as an ember plate: it waits on you. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import { t } from '../lib/text/locale.ts';

  let { msg }: { msg: string } = $props();
</script>

<div role="status" class="plate ember flex items-center gap-3 px-4 py-2.5 mx-1.5 mb-4 text-sm"><Chip tone="you" extra="shrink-0" ariaHidden text={$t('common.you')} /><span class="min-w-0 text-fg">{msg}</span></div>
