<!-- What readiness triage found missing from an item, as one muted line: the Issues row and the issue panel share it. -->
<script lang="ts">
  import { t } from '../lib/text/locale.ts';
  import type { TriageMissing } from '../lib/core/types.ts';

  let { missing }: { missing: TriageMissing[] } = $props();
</script>

<div class="text-xs text-muted mt-1">{$t('issues.missingLabel')} {#each missing as k, m (k)}{#if m}{', '}{/if}{#if k === 'outcome'}{$t('issues.missing.outcome')}{:else if k === 'acceptance'}{$t('issues.missing.acceptance')}{:else if k === 'scope'}{$t('issues.missing.scope')}{:else if k === 'duplicate'}{$t('issues.missing.duplicate')}{:else if k === 'hidden-text'}{$t('issues.missing.hiddenText')}{/if}{/each}</div>
