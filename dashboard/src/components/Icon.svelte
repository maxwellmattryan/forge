<!-- A Drafting line icon from lib/icons.ts. Decorative: its button or link carries the name. Size comes from `ic` (18px) and `.btn .ic` (15px). -->
<script lang="ts">
  import { ICONS, type IconName, type IconShape } from '../lib/icons.ts';

  let { name, class: cls = '' }: { name: IconName; class?: string } = $props();
  const def = $derived(ICONS[name]);
</script>

<svg class="ic {cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  {#snippet shape(s: IconShape)}
    {#if s.el === 'path'}<path d={s.d} />{:else if s.el === 'circle'}<circle cx={s.cx} cy={s.cy} r={s.r} fill={s.fill === 'current' ? 'currentColor' : s.fill === 'ground' ? 'var(--surface, var(--bg))' : undefined} />{:else}<rect x={s.x} y={s.y} width={s.width} height={s.height} />{/if}
  {/snippet}
  {#each def.main as s, i (i)}{@render shape(s)}{/each}
  {#if def.cx.length}<g class="cx" stroke-dasharray="2 2" opacity=".6">{#each def.cx as s, i (i)}{@render shape(s)}{/each}</g>{/if}
</svg>
