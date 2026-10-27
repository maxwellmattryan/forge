<!-- A count pinned to the top-right corner of what it wraps (the status bar's bell, the job panel's Thread tab). Ember, because
     it marks something waiting for you. Decorative (aria-hidden), so the caller speaks the count in its own sr-only text.
     `extra` styles the wrapper: a text colour, or right padding so the badge clears a word. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Chip from './Chip.svelte';

  let { count, extra = '', children }: { count: number; extra?: string; children: Snippet } = $props();
</script>

<span class="relative inline-flex {extra}">{@render children()}{#if count > 0}<Chip tone="you" extra="badge num" ariaHidden text={count} />{/if}</span>
