<!-- A warning banner: lost connection, newer API, missing config or a load error. Drawn as an ember plate: it waits on you. -->
<script lang="ts">
  import { t } from '../lib/locale.ts';

  let { msg }: { msg: string } = $props();
</script>

<div role="status" class="plate ember flex items-center gap-3 px-4 py-2.5 mx-1.5 mb-4 text-sm"><span class="chip you shrink-0" aria-hidden="true">{$t('common.you')}</span><span class="min-w-0 text-fg">{msg}</span></div>
