<!-- The drawer's Agents tab: the current round's agents (plus any still running), newest first, and the chosen agent's
     Claude Code transcript below the list, followed live while it runs. Each role button also opens or closes that
     row's runs panel (AgentRuns), several at once; its Tokens are the sum of the role's runs. Transcript text is
     untrusted and renders through SessionLog's rules. Keyed by job id in the Drawer, so the choice resets with the job. -->
<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import AgentRuns from './AgentRuns.svelte';
  import Chip from '../ui/Chip.svelte';
  import Empty from '../ui/feedback/Empty.svelte';
  import Icon from '../ui/Icon.svelte';
  import SessionLog from '../logs/SessionLog.svelte';
  import { roundAgents } from '../../lib/sessions/agent-activity.ts';
  import { statusTone } from '../../lib/metrics/agent-runs.ts';
  import { ticker } from '../../lib/core/clock.svelte.ts';
  import type { JobDetail } from '../../lib/core/types.ts';
  import { dur, tokensShort } from '../../lib/core/util.ts';
  import { t } from '../../lib/text/locale.ts';

  let { job, detail, active }: { job: string; detail: Pick<JobDetail, 'agents'>; active: boolean } = $props();
  const rows = $derived(roundAgents(detail, ticker.now));
  /** The chosen row; null follows the newest agent with a transcript. */
  let pick = $state<string | null>(null);
  /** The roles whose runs panel is open. */
  const open = new SvelteSet<string>();
  const role = $derived(pick !== null && rows.some((r) => r.role === pick) ? pick : (rows.find((r) => r.transcript)?.role ?? rows[0]?.role ?? null));
  const row = $derived(rows.find((r) => r.role === role) ?? null);

  /** The role button picks the role's transcript and opens or closes its runs panel. */
  function toggle(r: string): void {
    pick = r;
    if (open.has(r)) open.delete(r);
    else open.add(r);
  }
</script>

{#if !rows.length}
  <Empty>{$t('agentsTab.empty')}</Empty>
{:else}
  <!-- A size container, so a runs panel fits the visible width even when the table scrolls sideways (phone widths). -->
  <div class="plate flat"><div class="@container overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>{$t('agentsTab.role')}</th><th>{$t('agentsTab.status')}</th><th>{$t('common.model')}</th><th class="r">{$t('agentsTab.duration')}</th><th class="r">{$t('common.tokens')}</th></tr></thead>
      <tbody>
        {#each rows as r, i (r.role)}
          {@const on = r.role === role}
          {@const expanded = open.has(r.role)}
          <tr class={on ? 'bg-raised' : ''}>
            <td>
              <button
                type="button"
                class="inline-flex items-center gap-1 text-left whitespace-nowrap hover:text-gleam {on ? 'text-gleam' : ''}"
                aria-current={on ? 'true' : undefined}
                aria-expanded={expanded ? 'true' : 'false'}
                aria-controls="agent-runs-{i}"
                onclick={() => toggle(r.role)}><Icon name="chevron-down" class={expanded ? 'shrink-0' : 'shrink-0 -rotate-90'} />{r.role}</button>
            </td>
            <td><Chip tone={statusTone(r.status, r.running)} text={r.status ?? '—'} /></td>
            <td>{r.model ?? '—'}</td>
            <td class="r num">{dur(r.elapsedMs)}</td>
            <td class="r num">{tokensShort(r.tokens)}</td>
          </tr>
          <tr id="agent-runs-{i}" class="fold-row" data-open={expanded ? '' : undefined}><td colspan="5"><div class="fold"><div class="max-w-[calc(100cqw-24px)]"><AgentRuns runs={r.runs ?? []} running={r.running} /></div></div></td></tr>
        {/each}
      </tbody>
    </table>
  </div></div>
  {#if row && role !== null}
    {#if row.transcript}
      {#key role}<SessionLog scope={job} {active} transcript={{ job, agent: role, label: $t('agentsTab.transcript', { role }) }} finished={row.status === 'done' && !row.running} />{/key}
    {:else}
      <Empty>{$t('agentsTab.noTranscript')}</Empty>
    {/if}
  {/if}
{/if}
