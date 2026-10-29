<!-- What a gate's buttons do to the PR: a merge gate on an open PR shows the PR chip and says the PR waits on this
     decision before it can merge; a held push says nothing has left the machine yet. Nothing for any other gate. -->
<script lang="ts">
  import PrChip from './PrChip.svelte';
  import { gatePrNote } from '../lib/gates/inbox.ts';
  import type { JobLike } from '../lib/jobs/state.ts';
  import { t } from '../lib/text/locale.ts';

  let { job }: { job: JobLike } = $props();
  const note = $derived(gatePrNote(job));
</script>

{#if note?.kind === 'open'}
  <div class="flex flex-wrap items-center gap-2"><PrChip pr={note.pr} /><span class="muted text-[12px]">{$t('inbox.gatePrOpen')}</span></div>
{:else if note?.kind === 'held'}
  <div class="muted text-[12px]">{$t('inbox.pushHeld')}</div>
{/if}
