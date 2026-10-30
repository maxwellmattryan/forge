<!-- A board card's `after <ref title | id>` chips, one per dependency, each truncated to the card's width with the full id in its title. -->
<script lang="ts">
  import Chip from '../ui/Chip.svelte';
  import { depChipTitle, depLabel, depLinks } from '../../lib/jobs/deps.ts';
  import { S, openDrawer } from '../../lib/core/app.svelte.ts';
  import type { Job } from '../../lib/core/types.ts';
  import { t } from '../../lib/text/locale.ts';

  let { job }: { job: Partial<Job> } = $props();
  const links = $derived(depLinks(job, S.data?.jobs ?? []));

  // Stops the card's own click, as the old closest-[data-action] lookup did.
  function open(e: MouseEvent, id: string): void {
    e.stopPropagation();
    openDrawer(id);
  }
</script>

{#if links.length}
  <div class="basis-full min-w-0 flex flex-wrap gap-1">
    {#each links as l, i (i)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (a span, as on main: the card is a button already, and a button can't nest one). It keeps its own pointer class: style.css's base pointer rule matches buttons and roles, never a bare span, and the chip must not depend on what card it sits in) -->
      <span class="inline-flex max-w-full min-w-0" onclick={(e) => open(e, l.id)}><Chip tone={l.tone} title={depChipTitle(l)} extra="max-w-full min-w-0 cursor-pointer hover:underline"><span class="truncate">{$t('deps.after', { label: depLabel(l) })}</span></Chip></span>
    {/each}
  </div>
{/if}
