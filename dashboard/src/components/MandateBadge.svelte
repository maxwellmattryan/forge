<!-- A job's mandate as a chip on its board card and table row: the id as plain text (never a link, since the card is a
     button), titled "Mandate <id>". Nothing renders for a job without a valid mandate id, so neither layout changes shape. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import { mandateBadge } from '../lib/foreman.ts';
  import { t } from '../lib/locale.ts';

  let { mandate, extra = '' }: { mandate: unknown; extra?: string } = $props();
  const badge = $derived(mandateBadge({ mandate }));
</script>

{#if badge}<Chip extra="foreman normal-case tracking-normal {extra}" icon="foreman" title={$t('job.mandateBadge', { id: badge.id })} text={badge.id} />{/if}
