<!-- Evals: the run form, the latest run's KPIs, runs, compare and tasks. -->
<script lang="ts">
  import Chip from '../components/Chip.svelte';
  import CompareTable from '../components/CompareTable.svelte';
  import Empty from '../components/Empty.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Select from '../components/Select.svelte';
  import { safeUrl } from '../lib/markdown.ts';
  import { pct, tokensShort, usd } from '../lib/util.ts';
  import type { ApiState } from '../lib/types.ts';
  import { evalRunBody } from '../lib/requests.ts';
  import { S, compareRuns, request } from '../lib/app.svelte.ts';
  import { t } from '../lib/locale.ts';

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
  const runOptions = $derived(runs.map((r) => ({ value: r.id, label: `${r.id}${r.label ? ` (${r.label})` : ''}` })));
</script>

{#snippet kpi(label: string, value: string)}
  <div class="plate kpi"><div class="label">{label}</div><div class="v">{value}</div></div>
{/snippet}

<PageHeader title={$t('evals.title')}>
  {#snippet sub()}{$t('evals.sub')}{/snippet}
  {#snippet right()}<button class="btn primary" onclick={() => request(evalRunBody({ tags, tasks, label }))}>{$t('evals.run')}</button>{/snippet}
</PageHeader>
{#if !e}
  <div class="plate w-fit px-3 py-1.5 text-sm text-muted">{$t('common.loading')}</div>
{:else}
  <div class="plate p-4 mb-6 grid gap-3 md:grid-cols-4 items-end">
    <label class="flex flex-col gap-1 text-xs text-muted">{$t('evals.tags')}<input id="eval-tags" placeholder={$t('evals.tagsPlaceholder')} bind:value={tags} /></label>
    <label class="flex flex-col gap-1 text-xs text-muted">{$t('evals.tasks')}<input id="eval-tasks" placeholder={$t('evals.tasksPlaceholder')} bind:value={tasks} /></label>
    <label class="flex flex-col gap-1 text-xs text-muted">{$t('evals.label')}<input id="eval-label" placeholder={$t('evals.labelPlaceholder')} bind:value={label} /></label>
    <div class="text-[11px] text-muted">{$t('evals.available', { count: e.tasks.length })} {data.config.daemon?.enabled ? $t('evals.daemonOn') : $t('evals.daemonOff')}</div>
  </div>
  {#if runs.length}
    {@const latest = runs[0].summary ?? {}}
    <div class="grid gap-3 grid-cols-2 lg:grid-cols-5 mb-6">{@render kpi($t('evals.checkPass'), pct(latest.checkPassRate))}{@render kpi($t('evals.judgeScore'), pct(latest.avgJudgeScore))}{@render kpi($t('evals.firstPass'), pct(latest.firstPassRate))}{@render kpi($t('evals.avgTokens'), tokensShort(latest.avgTokens))}{@render kpi($t('evals.avgCost'), usd(latest.avgCostUsd))}</div>
    <div class="plate flat mb-6"><div class="label callout px-3 pt-3">{$t('common.runs')}</div><div class="overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>{$t('evals.runCol')}</th><th>{$t('evals.status')}</th><th>{$t('evals.config')}</th><th>{$t('evals.pass')}</th><th>{$t('evals.judge')}</th><th>{$t('evals.firstPassCol')}</th><th>{$t('common.rounds')}</th><th>{$t('evals.escalated')}</th><th class="r">{$t('common.tokens')}</th><th class="r">{$t('evals.cost')}</th><th class="r">{$t('evals.minutes')}</th></tr></thead>
        <tbody>
          {#each runs as r (r.id)}
            {@const s = r.summary ?? {}}
            <tr>
              <td><div class="font-mono text-xs">{r.id}</div><div class="text-[11px] text-muted">{r.label ?? ''}</div></td>
              <td><Chip tone={r.status === 'done' ? 'ok' : 'live'} text={r.status} /></td>
              <td class="font-mono text-[11px] text-muted">{r.configHash}<br />v{r.forgeVersion}</td>
              <td class="num">{pct(s.checkPassRate)}</td>
              <td class="num">{pct(s.avgJudgeScore)}</td>
              <td class="num">{pct(s.firstPassRate)}</td>
              <td class="num">{s.avgRounds ?? '—'}</td>
              <td class="num">{pct(s.escalationRate)}</td>
              <td class="r num">{tokensShort(s.avgTokens)}</td>
              <td class="r num">{usd(s.avgCostUsd)}</td>
              <td class="r num">{s.avgMinutes ?? '—'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div></div>
    <div class="plate p-4 mb-6">
      <div class="label callout mb-3">{$t('evals.compareRuns')}</div>
      <div class="flex flex-wrap gap-2 items-center">
        <Select id="cmp-a" label={$t('evals.runA')} bind:value={() => cmpA ?? '', (v) => (pickA = v)} options={runOptions} />
        <span class="text-muted">→</span>
        <Select id="cmp-b" label={$t('evals.runB')} bind:value={() => cmpB ?? '', (v) => (pickB = v)} options={runOptions} />
        <button class="btn" onclick={() => compareRuns(cmpA ?? '', cmpB ?? '')}>{$t('evals.compare')}</button>
      </div>
      {#if S.compare.result}<CompareTable result={S.compare.result} />{/if}
    </div>
  {:else}
    <Empty>{$t('evals.empty')} <code class="mono text-fg">{$t('evals.cmdMine')}</code> {$t('evals.emptyMine')} <code class="mono text-fg">{$t('evals.cmdNew')}</code>{$t('evals.emptyEnd')}</Empty>
  {/if}
  {#if e.tasks.length}
    <div class="plate flat mt-6"><div class="label callout px-3 pt-3">{$t('evals.taskList')}</div><div class="overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>{$t('evals.task')}</th><th>{$t('evals.tagsCol')}</th><th>{$t('evals.hiddenCheck')}</th><th>{$t('evals.rubric')}</th><th>{$t('evals.source')}</th></tr></thead>
        <tbody>
          {#each e.tasks as task (task.name)}
            {@const u = safeUrl(task.source?.url)}
            <tr>
              <td><div class="font-medium">{task.title}</div><div class="font-mono text-[11px] text-muted">{task.name}</div></td>
              <td>{#each task.tags ?? [] as g, i (i)}<Chip tone="muted" extra="mr-1" text={g} />{/each}</td>
              <td>{#if task.check?.patch || task.check?.files}<Chip tone="ok" text={$t('evals.yes')} />{:else}<Chip tone="muted" text={$t('evals.none')} />{/if}</td>
              <td>{#if task.rubric}<Chip tone="info" text={$t('evals.judgeChip')} />{:else}—{/if}</td>
              <td>{#if u}<a class="text-gleam" href={u} target="_blank" rel="noopener">{$t('evals.pr', { number: task.source?.pr })}</a>{:else}—{/if}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div></div>
  {/if}
{/if}
