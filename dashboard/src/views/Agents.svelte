<!-- Agents: running agents, orchestrator sessions, and the roster and review panel. -->
<script lang="ts">
  import Empty from '../components/Empty.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import { ago } from '../lib/util.ts';
  import type { ApiState } from '../lib/types.ts';
  import { agentSessions, runningAgents } from '../lib/view.ts';
  import { S, openDrawer } from '../lib/app.svelte.ts';

  let { data }: { data: ApiState } = $props();
  const running = $derived(runningAgents(data.jobs));
  const sessions = $derived(agentSessions(data.jobs, Date.now()));
  const r = $derived(S.roster);
</script>

<PageHeader title="Agents">
  {#snippet sub()}Who is working on what, and the roster every job draws from.{/snippet}
</PageHeader>
<h2 class="text-sm font-semibold mb-3">Running now</h2>
{#if running.length}
  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    {#each running as a (`${a.job.id}/${a.role}`)}
      <button class="card p-3 text-left hover:border-accent/50" onclick={() => openDrawer(a.job.id)}><div class="flex items-center justify-between"><span class="font-medium">{a.role}</span><span class="chip bg-accent/15 text-accent">{a.model ?? 'model?'}</span></div><div class="text-sm text-muted mt-1 line-clamp-1">{a.job.title}</div><div class="text-[11px] text-muted mt-1">round {a.round ?? '—'} · started {ago(a.startedAt)}</div></button>
    {/each}
  </div>
{:else}
  <Empty>No agents running.</Empty>
{/if}
<h2 class="text-sm font-semibold mt-8 mb-3">Orchestrator sessions</h2>
{#if sessions.length}
  <div class="card overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>Session</th><th>Host</th><th>Jobs</th><th>Last seen</th></tr></thead>
      <tbody>
        {#each sessions as s (s.session)}
          <tr>
            <td class="font-mono text-xs"><span class="inline-block size-1.5 rounded-full {s.live ? 'bg-ok' : 'bg-muted'} mr-1.5"></span>{s.session}</td>
            <td>{s.host ?? '—'}</td>
            <td>{#each s.jobs as j (j.id)}<button class="hover:text-accent mr-2" onclick={() => openDrawer(j.id)}>{j.id}</button>{/each}</td>
            <td class="text-muted">{ago(s.heartbeat)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else}
  <Empty>No sessions own a job right now.</Empty>
{/if}
{#if r}
  <h2 class="text-sm font-semibold mt-8 mb-3">Roster</h2>
  <div class="card overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>Role</th><th>Model</th><th>Prompt hash</th><th>Repo addendum</th></tr></thead>
      <tbody>
        {#each r.agents as a, i (i)}
          <tr>
            <td><div class="font-medium">{a.role}</div><div class="text-[11px] text-muted max-w-xl">{a.description}</div></td>
            <td><span class="chip bg-raised">{a.model}</span></td>
            <td class="font-mono text-xs text-muted">{a.promptHash}</td>
            <td class="font-mono text-xs text-muted">{a.addendum ?? '—'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <h2 class="text-sm font-semibold mt-8 mb-3">Review panel</h2>
  <div class="card overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>Lens</th><th>Model</th><th>Runs when</th><th>Checklist</th><th>Hash</th></tr></thead>
      <tbody>
        {#each r.reviewers as v, i (i)}
          <tr>
            <td class="font-medium">{v.name}</td>
            <td><span class="chip bg-raised">{v.model}</span></td>
            <td class="text-muted">{v.always ? 'always' : (v.when ?? 'when relevant')}</td>
            <td class="font-mono text-xs text-muted">{v.checklist ?? 'missing'}</td>
            <td class="font-mono text-xs text-muted">{v.checklistHash ?? '—'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if r.learnings}<p class="text-xs text-muted mt-3">Every agent also reads <code class="font-mono">{r.learnings}</code>.</p>{/if}
{/if}
