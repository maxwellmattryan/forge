<!-- A job's PR number with its merge, conflict and checks state; nothing without a PR. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import { prChipModel } from '../lib/view.ts';
  import type { JobPr } from '../lib/types.ts';

  let { pr }: { pr: Partial<JobPr> | null | undefined } = $props();
  const model = $derived(prChipModel(pr));
</script>

{#if model}<Chip tone={model.tone} text={model.text} />{/if}
