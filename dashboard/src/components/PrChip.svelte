<!-- A job's PR number with its merge, conflict and checks state; nothing without a PR. With `repo`, a member repo's PR (`lib#7`). -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import { prChipModel } from '../lib/view.ts';
  import type { JobPr } from '../lib/types.ts';

  let { pr, repo }: { pr: Partial<Omit<JobPr, 'url'>> | null | undefined; repo?: string } = $props();
  const model = $derived(prChipModel(pr, repo));
</script>

{#if model}<Chip tone={model.tone} text={model.text} icon="pull-request" />{/if}
