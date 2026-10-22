<!-- One reviewer's verdict for the current round. -->
<script lang="ts">
  import { TONE_CLASS } from '../lib/util.ts';
  import { verdictTone } from '../lib/job-state.ts';
  import { t } from '../lib/locale.ts';

  let { name, verdict }: { name: string; verdict: string | null | undefined } = $props();
</script>

<span class="chip {TONE_CLASS[verdictTone(verdict)]}" title={$t('verdict.title', { name, verdict: verdict ?? $t('verdict.pending') })}>{name}</span>
