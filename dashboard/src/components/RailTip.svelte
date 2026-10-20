<!-- The compact rail's tooltip: the hovered or focused control's name, 8px right of it on a solid plate. Hidden from
     assistive tech, because each rail control's aria-label already carries the text. The fixed wrapper places it, as
     Toast's does, so the plate's own position never fights `fixed`. -->
<script lang="ts">
  import { railTip } from '../lib/rail-tip.svelte.ts';
</script>

{#if railTip.shown}
  <div class="fixed z-20 pointer-events-none translate-y-[-50%]" style="top: {railTip.shown.top}px; left: {railTip.shown.left}px">
    <div role="tooltip" aria-hidden="true" class="plate solid whitespace-nowrap px-2 py-1 mono text-[12px] shadow-(--shadow-overlay)">{railTip.shown.text}</div>
  </div>
{/if}
