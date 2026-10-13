<!-- A board card's `after <id>` chips, one per dependency. -->
<script lang="ts">
  import { TONE_CLASS } from '../lib/util.ts';
  import { depHint, depLinks } from '../lib/deps.ts';
  import { S, openDrawer } from '../lib/app.svelte.ts';
  import type { Job } from '../lib/types.ts';
  import { t } from '../lib/locale.ts';

  let { job }: { job: Partial<Job> } = $props();
  const links = $derived(depLinks(job, S.data?.jobs ?? []));

  // Stops the card's own click, as the old closest-[data-action] lookup did.
  function open(e: MouseEvent, id: string): void {
    e.stopPropagation();
    openDrawer(id);
  }
</script>

{#if links.length}
  <div class="flex flex-wrap gap-1">
    {#each links as l, i (i)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (a span, as on main: the card is a button already, and a button can't nest one) -->
      <span title={depHint(l)} class="chip {TONE_CLASS[l.tone]} cursor-pointer hover:underline" onclick={(e) => open(e, l.id)}>{$t('deps.after', { id: l.id })}</span>
    {/each}
  </div>
{/if}
