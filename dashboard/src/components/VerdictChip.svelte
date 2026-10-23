<!-- One reviewer's verdict for the current round. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import { verdictTone } from '../lib/job-state.ts';
  import { t } from '../lib/locale.ts';

  let { name, verdict }: { name: string; verdict: string | null | undefined } = $props();
</script>

<Chip tone={verdictTone(verdict)} text={name} title={$t('verdict.title', { name, verdict: verdict ?? $t('verdict.pending') })} />
