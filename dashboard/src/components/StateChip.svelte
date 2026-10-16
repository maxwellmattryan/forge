<!-- A job's state, or its waiting reason, as a tone chip. A job that needs a human is the ember
     `YOU · <state>` tag; the prefix is aria-hidden so a screen reader hears the state alone. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import { stateText, stateTone } from '../lib/view.ts';
  import { t } from '../lib/locale.ts';
  import type { Job } from '../lib/types.ts';

  let { job }: { job: Partial<Job> } = $props();
  const tone = $derived(stateTone(job));
</script>

{#if tone === 'you'}<span class="chip you"><span aria-hidden="true">{$t('common.you')} ·</span> {stateText(job)}</span>{:else}<Chip {tone} text={stateText(job)} />{/if}
