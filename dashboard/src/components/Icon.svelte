<!-- A machined Smithy line icon from src/lib/ui/icons.ts. Decorative: its button or link carries the name. Size comes from
     `ic` (18px) and `.btn .ic` (15px). -->
<script lang="ts">
  import { ICONS, type IconDef, type IconName } from '../lib/ui/icons.ts';

  let { name, class: cls = '' }: { name: IconName; class?: string } = $props();
  const def = $derived<IconDef>(ICONS[name]);
</script>

<svg class="ic {cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  {#each def as s, i (i)}
    {#if s.el === 'path'}<path d={s.d} />{:else if s.el === 'circle'}<circle cx={s.cx} cy={s.cy} r={s.r} fill={s.fill === 'current' ? 'currentColor' : s.fill === 'ground' ? 'var(--surface, var(--bg))' : undefined} />{:else}<rect x={s.x} y={s.y} width={s.width} height={s.height} rx={s.rx} />{/if}
  {/each}
</svg>
