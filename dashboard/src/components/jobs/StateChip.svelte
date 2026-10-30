<!-- A job's state, or its waiting reason, as a tone chip. A job that needs a human is the ember
     `YOU · <state>` tag; the prefix is aria-hidden so a screen reader hears the state alone. -->
<script lang="ts">
  import Chip from '../ui/Chip.svelte';
  import { stateText, stateTone } from '../../lib/jobs/state.ts';
  import { t } from '../../lib/text/locale.ts';
  import type { Job } from '../../lib/core/types.ts';

  let { job }: { job: Partial<Job> } = $props();
  const tone = $derived(stateTone(job));
</script>

<!-- One element across tones, so a tone change transitions (chip's base transition) instead of remounting. -->
<Chip {tone}>{#if tone === 'you'}<span aria-hidden="true">{$t('common.you')} ·</span>{' '}{/if}{stateText(job)}</Chip>
