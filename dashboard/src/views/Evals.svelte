<!-- Evals: the run form, the latest run's KPIs, runs, compare and tasks. -->
<script lang="ts">
  import Chip from '../components/Chip.svelte';
  import CompareTable from '../components/CompareTable.svelte';
  import Empty from '../components/Empty.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import { safeUrl } from '../lib/markdown.ts';
  import { pct, tokensShort, usd } from '../lib/util.ts';
  import type { ApiState } from '../lib/types.ts';
  import { evalRunBody } from '../lib/view.ts';
  import { S, compareRuns, request } from '../lib/app.svelte.ts';

  let { data }: { data: ApiState } = $props();
  const e = $derived(S.evals);
  const runs = $derived(e?.runs ?? []);
  // Typed text and the compare picks survive polls; the picks default to the previous and latest run, as on main.
  let tags = $state('');
  let tasks = $state('');
  let label = $state('');
  let pickA = $state<string>();
  let pickB = $state<string>();
  const cmpA = $derived(pickA ?? (S.compare.a || runs[1]?.id || runs[0]?.id));
  const cmpB = $derived(pickB ?? (S.compare.b || runs[0]?.id));
</script>

{#snippet kpi(label: string, value: string)}
  <div class="kpi"><div class="kpi-label">{label}</div><div class="kpi-value">{value}</div></div>
{/snippet}

<PageHeader title="Evals">
  {#snippet sub()}Repeatable benchmarks of Forge. Runs are stamped with the Forge version and a hash of the repo’s Forge config, so you can tell whether a change helped.{/snippet}
  {#snippet right()}<button class="btn btn-primary" onclick={() => request(evalRunBody({ tags, tasks, label }))}>Run eval</button>{/snippet}
</PageHeader>
{#if !e}
  <div class="text-muted text-sm">Loading…</div>
{:else}
  <div class="card p-4 mb-6 grid gap-3 md:grid-cols-4 items-end">
    <label class="flex flex-col gap-1 text-xs text-muted">Tags (comma separated)<input id="eval-tags" placeholder="replay, ui" bind:value={tags} /></label>
    <label class="flex flex-col gap-1 text-xs text-muted">Tasks (comma separated)<input id="eval-tasks" placeholder="all" bind:value={tasks} /></label>
    <label class="flex flex-col gap-1 text-xs text-muted">Label<input id="eval-label" placeholder="baseline" bind:value={label} /></label>
    <div class="text-[11px] text-muted">{e.tasks.length} task(s) available. {data.config.daemon?.enabled ? 'The daemon is enabled, so runs start automatically.' : 'Runs are queued for your orchestrator session.'}</div>
  </div>
  {#if runs.length}
    {@const latest = runs[0].summary ?? {}}
    <div class="grid gap-3 grid-cols-2 lg:grid-cols-5 mb-6">{@render kpi('Hidden-check pass', pct(latest.checkPassRate))}{@render kpi('Judge score', pct(latest.avgJudgeScore))}{@render kpi('First-pass review', pct(latest.firstPassRate))}{@render kpi('Avg tokens', tokensShort(latest.avgTokens))}{@render kpi('Avg cost', usd(latest.avgCostUsd))}</div>
    <div class="card overflow-x-auto mb-6">
      <div class="px-3 pt-3 text-sm font-semibold">Runs</div>
      <table class="tbl">
        <thead><tr><th>Run</th><th>Status</th><th>Config</th><th>Pass</th><th>Judge</th><th>First pass</th><th>Rounds</th><th>Escalated</th><th class="text-right">Tokens</th><th class="text-right">Cost</th><th class="text-right">Minutes</th></tr></thead>
        <tbody>
          {#each runs as r (r.id)}
            {@const s = r.summary ?? {}}
            <tr>
              <td><div class="font-mono text-xs">{r.id}</div><div class="text-[11px] text-muted">{r.label ?? ''}</div></td>
              <td><Chip tone={r.status === 'done' ? 'ok' : 'accent'} text={r.status} /></td>
              <td class="font-mono text-[11px] text-muted">{r.configHash}<br />v{r.forgeVersion}</td>
              <td class="tabular-nums">{pct(s.checkPassRate)}</td>
              <td class="tabular-nums">{pct(s.avgJudgeScore)}</td>
              <td class="tabular-nums">{pct(s.firstPassRate)}</td>
              <td class="tabular-nums">{s.avgRounds ?? '—'}</td>
              <td class="tabular-nums">{pct(s.escalationRate)}</td>
              <td class="text-right tabular-nums">{tokensShort(s.avgTokens)}</td>
              <td class="text-right tabular-nums">{usd(s.avgCostUsd)}</td>
              <td class="text-right tabular-nums">{s.avgMinutes ?? '—'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="card p-4 mb-6">
      <div class="text-sm font-semibold mb-3">Compare runs</div>
      <div class="flex flex-wrap gap-2 items-center">
        <select id="cmp-a" bind:value={() => cmpA, (v) => (pickA = v)}>{#each runs as r (r.id)}<option value={r.id}>{r.id}{r.label ? ` (${r.label})` : ''}</option>{/each}</select>
        <span class="text-muted">→</span>
        <select id="cmp-b" bind:value={() => cmpB, (v) => (pickB = v)}>{#each runs as r (r.id)}<option value={r.id}>{r.id}{r.label ? ` (${r.label})` : ''}</option>{/each}</select>
        <button class="btn" onclick={() => compareRuns(cmpA ?? '', cmpB ?? '')}>Compare</button>
      </div>
      {#if S.compare.result}<CompareTable result={S.compare.result} />{/if}
    </div>
  {:else}
    <Empty>No eval runs yet. Add tasks with <code class="font-mono">forge eval mine --pr &lt;n&gt;</code> (replays a merged PR, using its tests as the hidden check) or <code class="font-mono">forge eval new</code>, then press Run eval.</Empty>
  {/if}
  {#if e.tasks.length}
    <div class="card overflow-x-auto mt-6">
      <div class="px-3 pt-3 text-sm font-semibold">Tasks</div>
      <table class="tbl">
        <thead><tr><th>Task</th><th>Tags</th><th>Hidden check</th><th>Rubric</th><th>Source</th></tr></thead>
        <tbody>
          {#each e.tasks as t (t.name)}
            {@const u = safeUrl(t.source?.url)}
            <tr>
              <td><div class="font-medium">{t.title}</div><div class="font-mono text-[11px] text-muted">{t.name}</div></td>
              <td>{#each t.tags ?? [] as g, i (i)}<span class="chip bg-raised text-muted mr-1">{g}</span>{/each}</td>
              <td>{#if t.check?.patch || t.check?.files}<Chip tone="ok" text="yes" />{:else}<Chip tone="muted" text="none" />{/if}</td>
              <td>{#if t.rubric}<Chip tone="info" text="judge" />{:else}—{/if}</td>
              <td>{#if u}<a class="text-accent" href={u} target="_blank" rel="noopener">PR #{t.source?.pr}</a>{:else}—{/if}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/if}
