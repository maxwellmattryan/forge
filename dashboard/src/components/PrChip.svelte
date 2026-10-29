<!-- A job's PR number with its merge, conflict and checks state; nothing without a PR. With `repo`, a member repo's PR (`lib#7`).
     With a safe URL it opens the PR in a new tab, and the GitHub hover card describes it. `inButton` is for the board card,
     itself one button that can't hold a link: there the chip is a span carrying `data-gh-href`, pointer-only like DepChips. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import { prChipModel } from '../lib/jobs/state.ts';
  import { safeUrl } from '../lib/text/markdown.ts';
  import type { JobPr } from '../lib/core/types.ts';

  let { pr, repo, inButton = false }: { pr: (Partial<Omit<JobPr, 'url'>> & { url?: string | null }) | null | undefined; repo?: string; inButton?: boolean } = $props();
  const model = $derived(prChipModel(pr, repo));
  const href = $derived(safeUrl(pr?.url));

  // Stops the card's own click (it would open the drawer) and the button's default, then leaves for GitHub.
  function open(e: MouseEvent): void {
    e.stopPropagation();
    e.preventDefault();
    if (href) window.open(href, '_blank', 'noopener,noreferrer');
  }
</script>

{#if model}
  {#if !href}<Chip tone={model.tone} text={model.text} icon="pull-request" />
  {:else if !inButton}<a {href} target="_blank" rel="noopener noreferrer" class="inline-flex no-underline" onclick={(e) => e.stopPropagation()}><Chip tone={model.tone} text={model.text} icon="pull-request" extra="cursor-pointer hover:underline" /></a>
  {:else}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (a span, as DepChips: the card is a button already, and a button can't nest a link; the drawer's header chip is the keyboard's way to the PR) -->
    <span data-gh-href={href} class="inline-flex" onclick={open}><Chip tone={model.tone} text={model.text} icon="pull-request" extra="cursor-pointer hover:underline" /></span>
  {/if}
{/if}
