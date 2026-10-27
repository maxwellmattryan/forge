<!-- Project: the configured components by repo, their backing services and dependency edges, with a job's
     components and their downstream consumers highlighted (issue #175). Read-only. -->
<script lang="ts">
  import Empty from '../components/Empty.svelte';
  import Loading from '../components/Loading.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Select from '../components/Select.svelte';
  import StateChip from '../components/StateChip.svelte';
  import ProjectEnvironmentsSkeleton from '../components/skeletons/ProjectEnvironmentsSkeleton.svelte';
  import ProjectGraphSkeleton from '../components/skeletons/ProjectGraphSkeleton.svelte';
  import type { ApiState, Job } from '../lib/types.ts';
  import { S, openDrawer } from '../lib/app.svelte.ts';
  import { projectRows } from '../lib/environment.ts';
  import { BACKING_KEY, edgeKey, highlight, jobOptions, layoutProject, type GraphNode } from '../lib/project-graph.ts';
  import { t } from '../lib/locale.ts';

  // App renders a view only once S.data is loaded.
  const data = $derived(S.data as ApiState);
  const g = $derived(S.project);
  // Running environments (GET /api/environments, loaded with the page's 15 s view poll). Read-only: the controls live in
  // each job's Environment card.
  const envs = $derived(S.environments);
  const envRows = $derived(projectRows(envs?.rows));
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
<section class="mb-6" aria-labelledby="project-environments-title">
  <h2 class="plate h section w-fit max-w-full px-3 py-1.5 mb-3" id="project-environments-title">{$t('project.environments.title')}</h2>
  {#if S.environmentsError}<p class="plate px-3 py-2 mb-3 text-sm text-muted selectable">{$t('project.environments.failed', { error: S.environmentsError })}</p>{/if}
  {#if envs && envs.docker !== 'ok'}<p class="plate px-3 py-2 mb-3 text-sm text-warn">{$t('project.environments.dockerDown')}</p>{/if}
  {#if !envs}
    {#if !S.environmentsError}<Loading><ProjectEnvironmentsSkeleton /></Loading>{/if}
  {:else if envRows.length === 0}
    <Empty>{$t('project.environments.empty')}</Empty>
  {:else}
    <div class="plate flat"><div class="overflow-x-auto">
      <table class="tbl" aria-label={$t('project.environments.aria')}>
        <thead>
          <tr>
            <th>{$t('project.environments.table.job')}</th>
            <th>{$t('project.environments.table.state')}</th>
            <th>{$t('project.environments.table.devPort')}</th>
            <th class="text-right">{$t('project.environments.table.devCpu')}</th>
            <th class="text-right">{$t('project.environments.table.devMem')}</th>
            <th class="text-right">{$t('project.environments.table.containers')}</th>
            <th class="text-right">{$t('project.environments.table.cpu')}</th>
            <th class="text-right">{$t('project.environments.table.mem')}</th>
          </tr>
        </thead>
        <tbody>
          {#each envRows as r (r.key)}
            {@const id = r.job}
            <tr>
              <td>{#if id !== null}<button class="text-left hover:text-gleam" onclick={() => openDrawer(id, null, 'details')}>{r.title}</button>{:else}<span class="text-muted">{$t('project.environments.shared')}</span>{/if}</td>
              <td>{#if r.state}<StateChip job={{ state: r.state as Job['state'] }} />{:else}—{/if}</td>
              <td class="mono text-xs">{r.devPort}</td>
              <td class="mono text-xs text-right">{r.devCpu}</td>
              <td class="mono text-xs text-right">{r.devMem}</td>
              <td class="mono text-xs text-right">{r.containers}</td>
              <td class="mono text-xs text-right">{r.cpu}</td>
              <td class="mono text-xs text-right">{r.mem}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div></div>
  {/if}
</section>
{#if !g || !layout}
  <Loading><ProjectGraphSkeleton /></Loading>
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
