<!-- The Agents tab's runs panel for one role: every ended agent run, oldest first, with its billing split and, when
     recorded, the estimated context composition at its last request, each as a stacked bar and a legend of tokens and
     shares. Bars are decorative (the legends carry every figure), and tool and MCP server names render as text. Built
     from src/lib/agent-runs.ts. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import { billingParts, compositionParts, runDuration, runsTotal, statusTone, type BarPart } from '../lib/agent-runs.ts';
  import type { AgentRun } from '../lib/types.ts';
  import { dur, pct, tokensShort } from '../lib/util.ts';
  import { t } from '../lib/locale.ts';

  let { runs, running }: { runs: AgentRun[]; running: boolean } = $props();
  const total = $derived(runsTotal(runs));

  function label(p: BarPart): string {
    switch (p.key) {
      case 'cacheRead':
        return $t('agentsTab.runs.parts.cacheRead');
      case 'cacheWrite':
        return $t('agentsTab.runs.parts.cacheWrite');
      case 'input':
        return $t('agentsTab.runs.parts.input');
      case 'output':
        return $t('agentsTab.runs.parts.output');
      case 'unsplit':
        return $t('agentsTab.runs.parts.unsplit');
      case 'forgePrompt':
        return $t('agentsTab.runs.parts.forgePrompt');
      case 'harness':
        return $t('agentsTab.runs.parts.harness');
      case 'carried':
        return $t('agentsTab.runs.parts.carried');
      case 'mcp':
        return $t('agentsTab.runs.parts.mcp', { server: p.name ?? '' });
      case 'otherTools':
        return $t('agentsTab.runs.parts.otherTools');
      case 'assistant':
        return $t('agentsTab.runs.parts.assistant');
      case 'user':
        return $t('agentsTab.runs.parts.user');
      case 'tool':
        return p.name ?? '';
    }
  }
</script>

{#snippet bar(parts: BarPart[])}
  <div class="run-bar" aria-hidden="true">
    {#each parts as p (`${p.key}:${p.name ?? ''}`)}<span class="{p.series} h-full" style="width:{p.share * 100}%"></span>{/each}
  </div>
  <ul class="caption flex flex-wrap gap-x-4 gap-y-1">
    {#each parts as p (`${p.key}:${p.name ?? ''}`)}
      <li class="inline-flex min-w-0 items-center gap-1.5">
        <span class="series-swatch {p.series}" aria-hidden="true"></span>
        <span class={p.key === 'tool' || p.key === 'mcp' ? 'font-mono break-all' : ''}>{label(p)}</span>
        <span class="num">{tokensShort(p.tokens)}</span>
        <span class="muted num">{pct(p.share)}</span>
      </li>
    {/each}
  </ul>
{/snippet}

<div class="flex min-w-0 flex-col gap-3 py-1">
  {#if runs.length}
    <p class="num">{$t('agentsTab.runs.summary', { count: runs.length, tokens: tokensShort(total) })}</p>
    <p class="caption muted">{$t('agentsTab.runs.caption')}</p>
    <ol class="flex flex-col gap-4">
      {#each runs as r, i (i)}
        {@const billing = billingParts(r.usage)}
        {@const composition = compositionParts(r.composition)}
        <li class="flex flex-col gap-2">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="font-medium">{$t('agentsTab.runs.run', { n: i + 1 })}</span>
            {#if r.round !== null}<span class="caption muted">{$t('agentsTab.runs.round', { round: r.round })}</span>{/if}
            <Chip tone={statusTone(r.status, false)} text={r.status ?? '—'} />
            <span class="muted">{r.model ?? '—'}</span>
            <span class="muted num">{dur(runDuration(r))}</span>
            <span class="num ml-auto">{tokensShort(r.usage?.totalTokens ?? null)}</span>
          </div>
          {#if !r.usage}
            <p class="caption muted">{$t('agentsTab.runs.noUsage')}</p>
          {:else}
            {#if billing.length}{@render bar(billing)}{/if}
            {#if r.composition && composition.length}
              <p class="caption">{$t('agentsTab.runs.composition', { total: tokensShort(r.composition.total) })}</p>
              {@render bar(composition)}
            {:else}
              <p class="caption muted">{$t('agentsTab.runs.noComposition')}</p>
            {/if}
          {/if}
        </li>
      {/each}
    </ol>
  {:else if !running}
    <p class="muted">{$t('agentsTab.runs.empty')}</p>
  {/if}
  {#if running}
    <p class="caption muted">{$t('agentsTab.runs.running', { n: runs.length + 1 })}</p>
  {/if}
</div>
