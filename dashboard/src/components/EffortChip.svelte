<!-- A reasoning effort level as a chip ("High effort"): warn for xhigh and max, which cost the most. Nothing for null, like
     PrChip without a PR, so a card's slots never branch on job state. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import { effortTone } from '../lib/jobs/effort.ts';
  import type { Effort } from '../lib/core/types.ts';
  import { t } from '../lib/text/locale.ts';

  let { level }: { level: Effort | null } = $props();
  const name = $derived<Record<Effort, string>>({ low: $t('effort.levels.low'), medium: $t('effort.levels.medium'), high: $t('effort.levels.high'), xhigh: $t('effort.levels.xhigh'), max: $t('effort.levels.max') });
</script>

{#if level}<Chip tone={effortTone(level)} text={$t('effort.chip', { level: name[level] })} />{/if}
