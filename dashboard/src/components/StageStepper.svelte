<!-- A job's place in the pipeline: nine dots in three clusters (Plan, Build, Ship). Past steps are filled, future steps
     hollow, and the current step is filled and outlined, in ember when the job needs a human, failed or is blocked.
     While the job is running (`active`), the current step carries a gleam ring that draws on and unwinds (motion-safe;
     under reduced motion a still, closed ring). A screen reader hears one label, e.g. "Stage 5 of 9: Verify". -->
<script lang="ts">
  import { stepPosition, type StageStep } from '../lib/board.ts';
  import { t } from '../lib/locale.ts';

  let { steps, stage, active = false }: { steps: StageStep[]; stage: string; active?: boolean } = $props();
  const clusters = $derived([0, 3, 6].map((i) => steps.slice(i, i + 3)));
  // Whole literals, so Tailwind sees every class.
  const DOT = {
    past: 'dot gleam plain',
    future: 'dot hollow',
    gleam: 'dot gleam plain outline outline-1 outline-offset-1 outline-gleam',
    ember: 'dot ember outline outline-1 outline-offset-1 outline-ember',
  } as const;
  const dotClass = (x: StageStep): string => (x.status === 'current' ? DOT[x.tone] : DOT[x.status]);
</script>

<span role="img" class="flex items-center gap-2 shrink-0" aria-label={$t('pipeline.stepper', { n: stepPosition(steps), total: steps.length, stage })}>
  {#each clusters as cluster, ci (ci)}
    <span class="flex items-center gap-1">{#each cluster as x (x.stage)}{#if active && x.status === 'current' && x.tone === 'gleam'}<span class="relative inline-flex"><span class="dot gleam plain"></span><svg class="trace" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><circle class="motion-safe:trace-loop" cx="6" cy="6" r="5.5" /></svg></span>{:else}<span class={dotClass(x)}></span>{/if}{/each}</span>
  {/each}
</span>
