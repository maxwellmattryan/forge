<!-- The Pipeline's Graph layout (issue #714): a plate per open mandate, its plan's issues by dependency depth with each
     live job on its issue, then a "No mandate" plate of the other jobs as dependsOn chains and lone nodes. On mount it
     loads the mandates and each open mandate's plan in parallel, again every 15 s while the tab is visible; a reply for
     another project is dropped, and a failed plan keeps the last good one. Job state comes from the 2 s state poll, so
     marks and edges move between plan fetches. A merge seen after the page settled heats the edges it satisfies once.
     Each plate's header ends with its mandate's controls (components/office/MandateControls.svelte: state chip,
     play/pause, the ⋯ menu); its Edit opens MandateEditor here, outside the plate, and closing it refocuses the ⋯ button.
     The model is lib/project/pipeline-graph.ts; mandate, plan and job text renders as text. -->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import GraphBlock from './GraphBlock.svelte';
  import MandateControls from '../../office/MandateControls.svelte';
  import MandateEditor from '../../office/MandateEditor.svelte';
  import Chip from '../../ui/Chip.svelte';
  import Empty from '../../ui/feedback/Empty.svelte';
  import Loading from '../../ui/feedback/Loading.svelte';
  import Skeleton from '../../ui/feedback/Skeleton.svelte';
  import { S, loadMandates } from '../../../lib/core/app.svelte.ts';
  import { currentProject } from '../../../lib/core/project.ts';
  import type { MandatePlanResponse, MandateRow } from '../../../lib/core/types.ts';
  import { fetchMandatePlan, isUnreadable, STATE_TONE } from '../../../lib/office/foreman.ts';
  import { HEAT_COOL_MS, graphMarks, heatedEdges, newlyMerged, openMandates, pipelineGraph, type GraphMark } from '../../../lib/project/pipeline-graph.ts';
  import { PLAN_SIZE, PLAN_SIZE_COMPACT } from '../../../lib/project/plan-layout.ts';
  import { settled } from '../../../lib/ui/motion.ts';
  import { t } from '../../../lib/text/locale.ts';

  const PLAN_POLL_MS = 15_000;
  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  let plans = $state.raw<Record<string, MandatePlanResponse>>({});
  let planErrors = $state.raw<Record<string, string>>({});
  /** The first mandates load settled (or an earlier page left a list). */
  let loaded = $state(S.mandates !== null);

  async function load(alive: () => boolean): Promise<void> {
    const project = currentProject();
    await loadMandates();
    if (!alive() || currentProject() !== project) return;
    loaded = true;
    const open = openMandates(S.mandates?.mandates ?? null);
    await Promise.all(
      open.map(async (m) => {
        try {
          const plan = await fetchMandatePlan(m.id);
          if (!alive() || currentProject() !== project) return;
          plans = { ...plans, [m.id]: plan };
          if (Object.hasOwn(planErrors, m.id)) planErrors = Object.fromEntries(Object.entries(planErrors).filter(([k]) => k !== m.id));
        } catch (e) {
          if (alive() && currentProject() === project) planErrors = { ...planErrors, [m.id]: message(e) };
        }
      }),
    );
  }

  $effect(() => {
    let live = true;
    const alive = (): boolean => live;
    untrack(() => void load(alive));
    const timer = setInterval(() => document.visibilityState === 'visible' && void load(alive), PLAN_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  });

  const jobs = $derived(S.data?.jobs ?? []);
  const graph = $derived(pipelineGraph({ jobs, mandates: S.mandates?.mandates ?? null, plans, planErrors, filter: S.filter, size: S.pane.md ? PLAN_SIZE : PLAN_SIZE_COMPACT }));
  const empty = $derived(jobs.length === 0 && graph.plates.length === 0);
  const mandatesError = $derived(S.mandates === null ? S.mandatesError : null);

  // A plate's readable row carries its controls; with none (unreadable, or gone since the plan) the plate keeps its chip.
  const rowOf = (id: string): MandateRow | null => S.mandates?.mandates.find((m): m is MandateRow => m.id === id && !isUnreadable(m)) ?? null;
  /** The mandate whose editor is open, from a plate's ⋯ › Edit mandate. */
  let editing = $state<string | null>(null);
  const editingRow = $derived(editing === null ? null : rowOf(editing));
  async function closeEditor(): Promise<void> {
    const id = editing;
    editing = null;
    await tick();
    document.getElementById(`mandate-menu-${id}`)?.focus();
  }

  // Heat: the edges leaving a node that merged since the last render, once the page has settled. `prev` is plain, not
  // state, so storing it never re-runs this.
  let prev: Map<string, GraphMark> | null = null;
  let hot = $state.raw<Record<string, number>>({});
  $effect(() => {
    const marks = graphMarks(graph);
    untrack(() => {
      const now = Date.now();
      if (prev !== null && settled(now, S.readyAt)) {
        const edges = heatedEdges(graph, newlyMerged(prev, marks));
        if (edges.length) hot = { ...Object.fromEntries(Object.entries(hot).filter(([, end]) => end > now)), ...Object.fromEntries(edges.map((id) => [id, now + HEAT_COOL_MS])) };
      }
      prev = marks;
    });
  });
</script>

{#if !loaded}
  <Loading class="flex flex-col gap-3">
    <div class="plate p-3 flex flex-col gap-3"><Skeleton w="14rem" h="1rem" /><div class="flex gap-3"><Skeleton w="220px" h="56px" /><Skeleton w="220px" h="56px" /></div></div>
  </Loading>
{:else if empty}
  <Empty>{$t('pipeline.empty')} <code class="mono text-fg">{$t('pipeline.cmdFeature')}</code> {$t('pipeline.or')} <code class="mono text-fg">{$t('pipeline.cmdNext')}</code>.</Empty>
{:else}
  <div class="flex flex-col gap-3 min-w-0">
    {#if mandatesError}<p class="plain caption muted px-1 break-words">{$t('pipeline.graph.mandatesError', { error: mandatesError })}</p>{/if}
    {#each graph.plates as p (p.id)}
      {@const row = rowOf(p.id)}
      <section class="plate open min-w-0" aria-label={$t('pipeline.graph.plateLabel', { title: p.title })}>
        <header class="plain flex flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-2 border-b border-line border-dashed">
          <span class="label text-fg shrink-0">{$t('pipeline.graph.mandate')}</span>
          <h2 class="h card min-w-0 truncate">{p.title}</h2>
          {#if p.status !== 'loading'}<span class="mono muted num text-[11px] shrink-0">{$t('pipeline.graph.merged', { merged: p.merged, total: p.total })}</span>{/if}
          {#if row}<MandateControls m={row} onedit={() => (editing = row.id)} />
          {:else}<span class="ml-auto shrink-0"><Chip tone={STATE_TONE[p.state]} text={p.state} /></span>{/if}
        </header>
        {#if p.problems.length}
          <div class="plain flex flex-col px-3 pt-2">
            {#each p.problems as detail, i (i)}<span class="caption muted break-words">{detail}</span>{/each}
            {#if p.moreProblems}<span class="caption muted">{$t('pipeline.graph.moreProblems', { count: p.moreProblems })}</span>{/if}
          </div>
        {/if}
        {#if p.status === 'loading'}
          <Loading class="p-3 flex gap-3"><Skeleton w="220px" h="56px" /><Skeleton w="220px" h="56px" /></Loading>
        {:else}
          {#if p.status === 'error' && p.error !== null}<p class="plain caption muted px-3 pt-2 break-words">{$t('pipeline.graph.planError', { error: p.error })}</p>{/if}
          {#if p.block.nodes.length}<div class="p-2"><GraphBlock block={p.block} {hot} /></div>
          {:else if p.status === 'ready'}<p class="plain caption muted px-3 py-3">{$t('pipeline.graph.noIssues')}</p>{/if}
        {/if}
      </section>
    {/each}
    {#if graph.loose.count}
      <section class="plate open min-w-0" aria-label={$t('pipeline.graph.noMandate')}>
        <header class="plain flex items-center justify-between gap-2 px-3 py-2 border-b border-line border-dashed">
          <h2 class="label text-fg shrink-0">{$t('pipeline.graph.noMandate')}</h2>
          <span class="mono muted num text-[11px] shrink-0">{$t('pipeline.graph.jobs', { count: graph.loose.count })}</span>
        </header>
        <div class="flex flex-col gap-1 p-2 min-w-0">
          {#each graph.loose.chains as b (b.nodes[0].id)}<GraphBlock block={b} {hot} />{/each}
          {#if graph.loose.lone.length}
            <div class="flex flex-wrap gap-x-2 min-w-0">
              {#each graph.loose.lone as b (b.nodes[0].id)}<GraphBlock block={b} {hot} />{/each}
            </div>
          {/if}
        </div>
      </section>
    {/if}
  </div>
{/if}
{#if editingRow && S.mandates}<MandateEditor mandates={S.mandates} row={editingRow} onclose={closeEditor} />{/if}
