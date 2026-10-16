<!-- Agents: running agents, orchestrator sessions, and the roster and review panel. -->
<script lang="ts">
  import EffortChip from '../components/EffortChip.svelte';
  import Empty from '../components/Empty.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import { ago } from '../lib/util.ts';
  import { effortChip } from '../lib/effort.ts';
  import type { ApiState, Effort, EffortSource } from '../lib/types.ts';
  import { agentSessions, runningAgents } from '../lib/view.ts';
  import { S, openDrawer } from '../lib/app.svelte.ts';
  import { t } from '../lib/locale.ts';

  let { data }: { data: ApiState } = $props();
  const running = $derived(runningAgents(data.jobs));
  const sessions = $derived(agentSessions(data.jobs, Date.now()));
  const r = $derived(S.roster);
  const defaultEffort = $derived(data.config?.effort ?? null);
</script>

{#snippet effortCell(level: Effort | null, source: EffortSource)}
  {#if level}<EffortChip {level} />{:else}<span class="text-xs">{$t('effort.claude')}</span>{/if}
  {#if source === 'panel'}<div class="text-[11px] text-muted">{$t('agents.effortFrom.panel')}</div>
  {:else if source === 'role'}<div class="text-[11px] text-muted">{$t('agents.effortFrom.role')}</div>
  {:else if source === 'config'}<div class="text-[11px] text-muted">{$t('agents.effortFrom.config')}</div>{/if}
{/snippet}

<PageHeader title={$t('agents.title')}>
  {#snippet sub()}{$t('agents.sub')}{/snippet}
</PageHeader>
<h2 class="plate h section w-fit max-w-full px-3 py-1.5 mb-3">{$t('agents.running')}</h2>
{#if running.length}
  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    {#each running as a (`${a.job.id}/${a.role}`)}
      {@const effort = effortChip(a.job.effort, defaultEffort)}
      <button class="plate clickable p-3 text-left" onclick={() => openDrawer(a.job.id)}><div class="flex items-center justify-between gap-2"><span class="font-medium">{a.role}</span><span class="flex flex-wrap justify-end gap-1"><span class="chip gleam">{a.model ?? $t('agents.modelUnknown')}</span><EffortChip level={effort} /></span></div><div class="text-sm text-muted mt-1 line-clamp-1">{a.job.title}</div><div class="text-[11px] text-muted mt-1">{$t('agents.runningMeta', { round: a.round ?? '—', started: ago(a.startedAt) })}</div></button>
    {/each}
  </div>
{:else}
  <Empty>{$t('agents.noRunning')}</Empty>
{/if}
<h2 class="plate h section w-fit max-w-full px-3 py-1.5 mt-8 mb-3">{$t('agents.sessions')}</h2>
{#if sessions.length}
  <div class="plate flat"><div class="overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>{$t('agents.session')}</th><th>{$t('agents.host')}</th><th>{$t('agents.jobs')}</th><th>{$t('agents.lastSeen')}</th></tr></thead>
      <tbody>
        {#each sessions as s (s.session)}
          <tr>
            <td class="font-mono text-xs"><span class="dot {s.live ? 'ok' : 'hollow'} mr-1.5"></span>{s.session}</td>
            <td>{s.host ?? '—'}</td>
            <td>{#each s.jobs as j (j.id)}<button class="hover:text-gleam mr-2" onclick={() => openDrawer(j.id)}>{j.id}</button>{/each}</td>
            <td class="text-muted">{ago(s.heartbeat)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div></div>
{:else}
  <Empty>{$t('agents.noSessions')}</Empty>
{/if}
{#if r}
  <h2 class="plate h section w-fit max-w-full px-3 py-1.5 mt-8 mb-3">{$t('agents.roster')}</h2>
  <p class="plain w-fit max-w-full flex flex-wrap items-center gap-1.5 px-3 py-1.5 text-xs text-muted mb-3">{$t('agents.effortDefault')}{#if defaultEffort}<EffortChip level={defaultEffort} />{:else}<span>{$t('effort.claude')}</span>{/if}</p>
  <div class="plate flat"><div class="overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>{$t('agents.role')}</th><th>{$t('common.model')}</th><th>{$t('agents.effort')}</th><th>{$t('agents.promptHash')}</th><th>{$t('agents.addendum')}</th></tr></thead>
      <tbody>
        {#each r.agents as a, i (i)}
          <tr>
            <td><div class="font-medium">{a.role}</div><div class="text-[11px] text-muted max-w-xl">{a.description}</div></td>
            <td><span class="chip muted">{a.model}</span></td>
            <td>{@render effortCell(a.effort, a.effortSource)}</td>
            <td class="font-mono text-xs text-muted">{a.promptHash}</td>
            <td class="font-mono text-xs text-muted">{a.addendum ?? '—'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div></div>
  <h2 class="plate h section w-fit max-w-full px-3 py-1.5 mt-8 mb-3">{$t('agents.panel')}</h2>
  <div class="plate flat"><div class="overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>{$t('common.lens')}</th><th>{$t('common.model')}</th><th>{$t('agents.effort')}</th><th>{$t('agents.runsWhen')}</th><th>{$t('agents.checklist')}</th><th>{$t('agents.hash')}</th></tr></thead>
      <tbody>
        {#each r.reviewers as v, i (i)}
          <tr>
            <td class="font-medium">{v.name}</td>
            <td><span class="chip muted">{v.model}</span></td>
            <td>{@render effortCell(v.effort, v.effortSource)}</td>
            <td class="text-muted">{v.always ? $t('agents.always') : (v.when ?? $t('agents.whenRelevant'))}</td>
            <td class="font-mono text-xs text-muted">{v.checklist ?? $t('agents.missing')}</td>
            <td class="font-mono text-xs text-muted">{v.checklistHash ?? '—'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div></div>
  {#if r.learnings}<p class="plate w-fit max-w-full px-3 py-1.5 text-xs text-muted mt-3">{$t('agents.learnings')} <code class="mono text-fg">{r.learnings}</code>.</p>{/if}
{/if}
