<!-- A job's state, or its waiting reason, as a tone chip. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import { stateText, stateTone } from '../lib/view.ts';
  import type { Job } from '../lib/types.ts';

  let { job }: { job: Partial<Job> } = $props();
</script>

<Chip tone={stateTone(job)} text={stateText(job)} />
