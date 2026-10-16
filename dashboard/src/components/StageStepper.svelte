<!-- A job's place in the pipeline: nine dots in three clusters (Plan, Build, Ship). Past steps are filled, future steps
     hollow, and the current step is filled and outlined, in ember when the job needs a human, failed or is blocked.
     A screen reader hears one label, e.g. "Stage 5 of 9: Verify". -->
<script lang="ts">
  import { stepPosition, type StageStep } from '../lib/view.ts';
  import { t } from '../lib/locale.ts';

  let { steps, stage }: { steps: StageStep[]; stage: string } = $props();
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
    <span class="flex items-center gap-1">{#each cluster as x (x.stage)}<span class={dotClass(x)}></span>{/each}</span>
  {/each}
</span>
