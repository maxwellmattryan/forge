<!-- A page or section still loading: <Skeleton> bones laid out in the shape of what will come, announced once to a screen
     reader as "Loading…" (or `label`). `class` lays the children out as the real content would be. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '../lib/locale.ts';

  let { label, class: extra = '', children }: { label?: string; class?: string; children: Snippet } = $props();
</script>

<div class={extra} role="status" aria-busy="true"><span class="sr-only">{label ?? $t('common.loading')}</span>{@render children()}</div>
