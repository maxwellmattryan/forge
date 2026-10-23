<!-- The drawer's Agents tab: the current round's agents (plus any still running), newest first, and the chosen agent's
     Claude Code transcript below the list, followed live while it runs. Transcript text is untrusted and renders through
     SessionLog's rules. Keyed by job id in the Drawer, so the choice resets with the job. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import Empty from './Empty.svelte';
  import SessionLog from './SessionLog.svelte';
  import { roundAgents } from '../lib/agent-activity.ts';
  import { ticker } from '../lib/clock.svelte.ts';
  import type { JobDetail } from '../lib/types.ts';
  import { dur, tokensShort } from '../lib/util.ts';
  import { t } from '../lib/locale.ts';

  let { job, detail, active }: { job: string; detail: Pick<JobDetail, 'agents'>; active: boolean } = $props();
  const rows = $derived(roundAgents(detail, ticker.now));
  /** The chosen row; null follows the newest agent with a transcript. */
  let pick = $state<string | null>(null);
  const role = $derived(pick !== null && rows.some((r) => r.role === pick) ? pick : (rows.find((r) => r.transcript)?.role ?? rows[0]?.role ?? null));
  const row = $derived(rows.find((r) => r.role === role) ?? null);
  const tone = (status: string | null, running: boolean): string => (running ? 'live' : status === 'done' ? 'ok' : status === 'lost' ? 'warn' : 'muted');
</script>

{#if !rows.length}
  <Empty>{$t('agentsTab.empty')}</Empty>
{:else}
  <div class="plate flat"><div class="overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>{$t('agentsTab.role')}</th><th>{$t('agentsTab.status')}</th><th>{$t('common.model')}</th><th class="r">{$t('agentsTab.duration')}</th><th class="r">{$t('common.tokens')}</th></tr></thead>
      <tbody>
        {#each rows as r (r.role)}
          {@const on = r.role === role}
          <tr class={on ? 'bg-raised' : ''}>
            <td><button type="button" class="text-left whitespace-nowrap hover:text-gleam {on ? 'text-gleam' : ''}" aria-current={on ? 'true' : undefined} onclick={() => (pick = r.role)}>{r.role}</button></td>
            <td><Chip tone={tone(r.status, r.running)} text={r.status ?? '—'} /></td>
            <td>{r.model ?? '—'}</td>
            <td class="r num">{dur(r.elapsedMs)}</td>
            <td class="r num">{tokensShort(r.tokens)}</td>
          </tr>
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
