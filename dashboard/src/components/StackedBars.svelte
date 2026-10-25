<!-- The Overview's stacked bars: one column per UTC day, stacked by project in its series colour, each column titled with
     its day and every project's value; then the legend table with each project's swatch, total, share and any error
     reading its stats. `empty` replaces the bars when every day is 0. Built from src/lib/overview.ts stackedSeries. -->
<script lang="ts">
  import type { StackColumn, Stacked } from '../lib/overview.ts';
  import { pct } from '../lib/util.ts';
  import { t } from '../lib/locale.ts';

  let { series, label, format, empty }: { series: Stacked; label: string; format: (n: number) => string; empty: string } = $props();

  /** One column's slot in the viewBox: the bar takes 80% of it, centred. */
  const SLOT = 10;
  const width = $derived(Math.max(1, series.columns.length) * SLOT);
  const gap = $derived(series.columns.length > 45 ? 1.5 : 1);
  const barTitle = (c: StackColumn): string => [`${c.day} · ${format(c.total)}`, ...c.segments.map((g) => `${g.project} ${format(g.value)}`)].join('\n');
</script>

<div class="flex flex-col gap-3">
  {#if series.max > 0}
    <svg role="img" aria-label={label} class="block h-40 w-full" viewBox="0 0 {width} 100" preserveAspectRatio="none">
      {#each series.columns as c, i (c.day)}
        <g>
          <title>{barTitle(c)}</title>
          <rect x={i * SLOT} y="0" width={SLOT} height="100" fill="transparent" />
          {#each c.segments as seg (seg.project)}
            <rect class={seg.series} x={i * SLOT + gap} y={seg.y} width={SLOT - gap * 2} height={seg.h} />
          {/each}
        </g>
      {/each}
    </svg>
    <div class="caption muted flex justify-between font-mono num"><span>{series.columns[0]?.day ?? ''}</span><span>{series.columns.at(-1)?.day ?? ''}</span></div>
  {:else}
    <p class="text-sm text-muted">{empty}</p>
  {/if}
  <div class="overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>{$t('overview.project')}</th><th class="r">{$t('overview.total')}</th><th class="r">{$t('overview.share')}</th></tr></thead>
      <tbody>
        {#each series.legend as l (l.project)}
          <tr>
            <td>
              <span class="inline-flex items-center gap-2"><span class="series-swatch {l.series}" aria-hidden="true"></span><span class="font-mono">{l.project}</span></span>
              {#if l.error}<span class="block text-[13px] text-bad">{l.error}</span>{/if}
            </td>
            <td class="r num">{format(l.total)}</td>
            <td class="r num">{pct(l.share)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>
