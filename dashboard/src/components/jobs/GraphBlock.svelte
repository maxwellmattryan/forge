<!-- One block of the Pipeline graph (lib/project/pipeline-graph.ts): a box of the block's size in its own sideways
     scroller, its edges as an aria-hidden SVG behind the nodes (dashed until the upstream merges, a heat run while
     `hot` holds the edge, hidden under reduced motion), then one button per node in layout order, so Tab walks it by
     column and row. A node opens its job's drawer, or its issue panel when no live job holds it. Every title, ref and
     state line renders as text. -->
<script lang="ts">
  import Icon from '../ui/Icon.svelte';
  import type { Block, GNode } from '../../lib/project/pipeline-graph.ts';
  import type { StageStep } from '../../lib/jobs/board.ts';
  import type { Tone } from '../../lib/jobs/state.ts';
  import { openDrawer, openIssue } from '../../lib/core/app.svelte.ts';
  import { ticker } from '../../lib/core/clock.svelte.ts';
  import { t } from '../../lib/text/locale.ts';

  /** `hot`: each heating edge's end time (ms since the epoch). */
  let { block, hot }: { block: Block; hot: Record<string, number> } = $props();

  // Whole literals, so Tailwind sees every class.
  const DOT: Record<Tone, string> = { ok: 'dot ok', bad: 'dot bad', warn: 'dot warn', info: 'dot gleam plain', muted: 'dot hollow', live: 'dot gleam', you: 'dot ember' };
  const seg = (x: StageStep): string => (x.status === 'past' ? 'past' : x.status === 'current' ? (x.tone === 'ember' ? 'now ember' : 'now') : '');
  const open = (n: GNode): void => void (n.job ? openDrawer(n.job) : n.ref ? openIssue(n.ref) : undefined);
  const fixed = $derived({
    merged: $t('pipeline.graph.state.merged'),
    cancelled: $t('pipeline.graph.state.cancelled'),
    running: $t('pipeline.graph.state.running'),
    ready: $t('pipeline.graph.state.ready'),
    planned: $t('pipeline.graph.state.planned'),
  });
  const line = (n: GNode): string => {
    const l = n.line;
    if (l.kind === 'stage') return l.state === null ? l.stage : $t('pipeline.graph.state.held', { stage: l.stage, state: l.state });
    if (l.kind === 'waits') return l.more ? $t('pipeline.graph.state.waitsOnMore', { ref: l.ref, count: l.more }) : $t('pipeline.graph.state.waitsOn', { ref: l.ref });
    return fixed[l.kind];
  };
</script>

<!-- p-1: room for a node's focus ring, which the scroller would otherwise clip. -->
<div class="overflow-x-auto overscroll-x-contain max-w-full p-1">
  <div class="relative shrink-0" style="width:{block.width}px;height:{block.height}px">
    <svg class="absolute inset-0 overflow-visible pointer-events-none" width={block.width} height={block.height} aria-hidden="true" focusable="false">
      {#each block.edges as e (e.id)}
        <path class="graph-edge {e.solid ? '' : 'graph-edge-open'} {e.dim ? 'graph-dim' : ''}" d={e.d} />
        {#if (hot[e.id] ?? 0) > ticker.now}<path class="graph-edge-heat motion-reduce:hidden" pathLength="1" d={e.d} />{/if}
      {/each}
    </svg>
    {#each block.nodes as n (n.id)}
      <button
        class="plate clickable {n.dashed ? 'cold' : ''} {n.match ? '' : 'graph-dim'} text-left px-2 py-1 flex flex-col justify-center gap-0.5 min-w-0"
        style="position:absolute;left:{n.x}px;top:{n.y}px;width:{n.w}px;height:{n.h}px"
        title={n.title}
        onclick={() => open(n)}
      >
        <span class="flex items-center gap-1.5 min-w-0">
          <!-- A fixed 14px cell, so the words beside it never shift as the mark changes. -->
          <span class="inline-grid place-items-center size-3.5 shrink-0 [&_.ic]:size-3.5">
            {#if n.mark === 'merged'}<span class="text-ok inline-grid"><Icon name="check" /></span>
            {:else if n.mark === 'running'}<span class="relative inline-flex"><span class="dot gleam plain"></span><svg class="trace" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><circle class="motion-safe:trace-loop" cx="6" cy="6" r="5.5" /></svg></span>
            {:else if n.mark === 'waiting'}<span class="text-muted inline-grid"><Icon name="lock" /></span>
            {:else if n.mark === 'held'}<span class={DOT[n.tone ?? 'muted']}></span>
            {:else}<span class="text-muted inline-grid"><Icon name="circle-dashed" /></span>{/if}
          </span>
          {#if n.title !== n.label}<span class="mono muted text-[11px] shrink-0 max-w-[45%] truncate">{n.label}</span>{/if}
          <span class="text-[13px] leading-4 font-medium text-fg truncate min-w-0">{n.title}</span>
        </span>
        <span class="text-[11px] leading-[14px] truncate {n.mark === 'merged' ? 'text-ok' : 'text-muted'}">{line(n)}</span>
        <!-- 4 + 16 + 2 + 14 + 2 + 2 + 2 + 4 = 46px: fits the compact 48px node with its track. -->
        {#if n.steps}<span class="graph-track mt-0.5" aria-hidden="true">{#each n.steps as x (x.stage)}<i class={seg(x)}></i>{/each}</span>{/if}
      </button>
    {/each}
  </div>
</div>
