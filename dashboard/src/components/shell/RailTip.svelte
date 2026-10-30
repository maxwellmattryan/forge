<!-- The compact rail's tooltip: the hovered or focused control's name, 8px right of it on a solid plate. Hidden from
     assistive tech, because each rail control's aria-label already carries the text. The fixed wrapper places it, as
     Toast's does, so the plate's own position never fights `fixed`. z-36 puts it over the status bar (z-25), which starts
     at the sidebar's edge right where the bottom control's tip (Settings) appears; the drawer needs no ordering, because
     the tip hides while the drawer covers the page. -->
<script lang="ts">
  import { railTip } from '../../lib/shell/rail-tip.svelte.ts';
</script>

{#if railTip.shown}
  <div class="fixed z-36 pointer-events-none translate-y-[-50%]" style="top: {railTip.shown.top}px; left: {railTip.shown.left}px">
    <div role="tooltip" aria-hidden="true" class="plate solid whitespace-nowrap px-2 py-1 mono text-[12px] shadow-(--shadow-overlay)">{railTip.shown.text}</div>
  </div>
{/if}
