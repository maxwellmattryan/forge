<!-- Project: the configured components by repo, their backing services and dependency edges, with a job's
     components and their downstream consumers highlighted (issue #175). Read-only. -->
<script lang="ts">
  import Empty from '../components/Empty.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Select from '../components/Select.svelte';
  import type { ApiState } from '../lib/types.ts';
  import { S } from '../lib/app.svelte.ts';
  import { BACKING_KEY, edgeKey, highlight, jobOptions, layoutProject, type GraphNode } from '../lib/project-graph.ts';
  import { t } from '../lib/locale.ts';

  let { data }: { data: ApiState } = $props();
  const g = $derived(S.project);
  const options = $derived(jobOptions(data.jobs));
  // Local to the view: a reload starts with no job.
  let picked = $state<string>('');
  $effect(() => {
    if (picked && !options.some((o) => o.id === picked)) picked = '';
  });
  const job = $derived(options.find((o) => o.id === picked) ?? null);
  const rootLabel = $derived(data.repo?.name || $t('project.thisRepo'));
  const layout = $derived(g ? layoutProject(g, rootLabel, $t('project.backing')) : null);
  const hl = $derived(g && job ? highlight(g, job.services) : null);
  const lit = $derived(hl?.matched ? hl : null);
  const repoCount = $derived(layout ? layout.bands.filter((b) => b.key !== BACKING_KEY).length : 0);

  type NodeState = 'touched' | 'consumer' | 'dim' | 'plain';
  function nodeState(n: GraphNode): NodeState {
    if (!lit) return 'plain';
    if (n.kind === 'component' && lit.touched.has(n.full)) return 'touched';
    if (n.kind === 'component' && lit.consumers.has(n.full)) return 'consumer';
    return 'dim';
  }
  // Whole literals, so Tailwind sees every class.
  function edgeClass(type: string, on: boolean): string {
    if (type === 'runtime') return on ? 'graph-edge graph-edge-runtime graph-edge-lit' : lit ? 'graph-edge graph-edge-runtime graph-dim' : 'graph-edge graph-edge-runtime';
    return on ? 'graph-edge graph-edge-lit' : lit ? 'graph-edge graph-dim' : 'graph-edge';
  }
  function kindLabel(kind: string | null): string {
    if (kind === 'library') return $t('project.kind.library');
    if (kind === 'service') return $t('project.kind.service');
    if (kind === 'app') return $t('project.kind.app');
    return $t('project.kind.backing');
  }
  function rowState(name: string): string {
    if (lit?.touched.has(name)) return $t('project.table.touched');
    if (lit?.consumers.has(name)) return $t('project.table.consumer');
    return '—';
  }
  const dependsOn = (name: string): string =>
    (g?.edges ?? [])
      .filter((e) => e.from === name)
      .map((e) => `${e.to} (${e.type})`)
      .join(', ') || '—';
</script>

<PageHeader title={$t('project.title')}>
  {#snippet sub()}{$t('project.sub')}{/snippet}
</PageHeader>
{#if !g || !layout}
  <Empty>{$t('project.loading')}</Empty>
{:else if g.components.length === 0}
  <Empty>{$t('project.empty')}</Empty>
{:else}
  <div class="flex flex-wrap items-end gap-3 mb-3">
    <div class="plate flex flex-col gap-1 px-3 py-2 text-xs text-muted">
      <span id="project-job-label">{$t('project.job')}</span>
      <Select id="project-job" labelledby="project-job-label" bind:value={picked} options={[{ value: '', label: $t('project.noJob') }, ...options.map((o) => ({ value: o.id, label: o.label }))]} />
    </div>
    {#if job && !hl?.matched}<p class="plate px-3 py-2 text-sm text-muted">{$t('project.noMatch')}</p>{/if}
  </div>
  {#if g.problems > 0}<p class="plate px-3 py-2 mb-3 text-sm text-warn">{$t('project.problems', { count: g.problems })}</p>{/if}
  <div class="plate overflow-x-auto p-3 mb-3">
    <svg
      width={layout.width}
      height={layout.height}
      viewBox="0 0 {layout.width} {layout.height}"
      role="img"
      aria-label={$t('project.aria', { components: g.components.length, repos: repoCount, backing: g.backing.length })}
      class="block max-w-none"
    >
      <defs>
        <marker id="pg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="graph-arrow" /></marker>
        <marker id="pg-arrow-lit" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="graph-arrow lit" /></marker>
      </defs>
      {#each layout.bands as b (b.key)}
        <g class="graph-band"><rect x={b.x} y={b.y} width={b.w} height={b.h} rx="2" /><text x={b.x + 16} y={b.y + 18}>{b.label}</text></g>
      {/each}
      {#each layout.edges as e (`${e.from}|${e.target}|${e.to}|${e.type}`)}
        {@const on = Boolean(lit && e.target === 'component' && lit.edges.has(edgeKey(e)))}
        <path d={e.d} class={edgeClass(e.type, on)} marker-end={on ? 'url(#pg-arrow-lit)' : 'url(#pg-arrow)'} />
      {/each}
      {#each layout.nodes as n (n.id)}
        {@const st = nodeState(n)}
        <g class={st === 'touched' ? 'graph-node graph-touched' : st === 'consumer' ? 'graph-node graph-consumer' : st === 'dim' ? 'graph-node graph-dim' : 'graph-node'}>
          <title>{n.full}</title>
          <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={n.kind === 'backing' ? 14 : 2} />
          <text class="name" x={n.x + 12} y={n.y + 19}>{n.label}</text>
          <text class="kind" x={n.x + 12} y={n.y + 34}>{kindLabel(n.componentKind)}</text>
        </g>
      {/each}
    </svg>
  </div>
  <div class="plate flex flex-wrap items-center gap-x-5 gap-y-2 px-3 py-2 mb-6 text-xs text-muted" role="group" aria-label={$t('project.legend.title')}>
    <span class="flex items-center gap-2"><svg width="28" height="8" aria-hidden="true"><path d="M1 4H27" class="graph-edge" /></svg>{$t('project.legend.build')}</span>
    <span class="flex items-center gap-2"><svg width="28" height="8" aria-hidden="true"><path d="M1 4H27" class="graph-edge graph-edge-runtime" /></svg>{$t('project.legend.runtime')}</span>
    <span class="flex items-center gap-2"><svg width="18" height="14" aria-hidden="true" class="graph-node graph-touched"><rect x="1" y="1" width="16" height="12" rx="2" /></svg>{$t('project.legend.touched')}</span>
    <span class="flex items-center gap-2"><svg width="18" height="14" aria-hidden="true" class="graph-node graph-consumer"><rect x="1" y="1" width="16" height="12" rx="2" /></svg>{$t('project.legend.consumer')}</span>
  </div>
  <div class="plate flat"><div class="overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>{$t('project.table.component')}</th><th>{$t('project.table.repo')}</th><th>{$t('project.table.kind')}</th><th>{$t('project.table.dependsOn')}</th><th>{$t('project.table.highlight')}</th></tr></thead>
      <tbody>
        {#each g.components as c (c.name)}
          <tr>
            <td class="font-mono text-xs">{c.name}</td>
            <td>{c.repo ?? rootLabel}</td>
            <td>{kindLabel(c.kind)}</td>
            <td class="font-mono text-xs">{dependsOn(c.name)}</td>
            <td>{rowState(c.name)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div></div>
{/if}
