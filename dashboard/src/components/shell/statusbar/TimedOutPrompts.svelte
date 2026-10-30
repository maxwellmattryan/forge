<!-- The Needs-you popover's Timed out list, collapsed: the tool calls the supervisor denied because nobody answered their
     prompt within daemon.permissionTimeoutMinutes, newest first, from every pool session's last 10. Each entry names its
     session (a job id opens its drawer, as a pending prompt's does), the tool, the exact input that was denied, the agent's
     description and when it was asked and denied. It is a record, not a decision: no buttons, and no count in the badge.
     The tool, input and description are session output, i.e. untrusted, and render as text. -->
<script lang="ts">
  import Chip from '../../ui/Chip.svelte';
  import { ago } from '../../../lib/core/util.ts';
  import { INBOX_SCOPE, OFFICE_SCOPE, sharedScope } from '../../../lib/core/types.ts';
  import { promptInput, timedOutPrompts } from '../../../lib/sessions/permissions.ts';
  import { S, openDrawer } from '../../../lib/core/app.svelte.ts';
  import { ticker } from '../../../lib/core/clock.svelte.ts';
  import { t } from '../../../lib/text/locale.ts';

  const entries = $derived(timedOutPrompts(S.data?.daemons ?? null));
</script>

{#if entries.length}
  <details class="plate flat">
    <summary class="label p-3 focus-visible:-outline-offset-2">{$t('permission.timedOut.heading', { count: entries.length })}</summary>
    <ul class="needs-list border-t border-line">
      {#each entries as { scope: s, prompt: p } (`${s}/${p.id}`)}
        <li class="needs-row">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <Chip tone="muted" text={$t('permission.timedOut.chip')} />
            {#if s === INBOX_SCOPE}<span class="text-muted">{$t('permission.inbox')}</span>
            {:else if s === OFFICE_SCOPE}<span class="text-muted">{$t('statusbar.foreman.officeLog')}</span>
            {:else if sharedScope(s)}<span class="mono text-muted">{s}</span>
            {:else}<button class="mono text-fg underline decoration-dotted truncate max-w-full" title={s} onclick={() => openDrawer(s, null, 'log')}>{s}</button>{/if}
            <span class="text-fg">{$t('permission.timedOut.denied', { tool: p.tool })}</span>
            <span class="flex-1"></span>
            <span class="text-muted">{$t('permission.timedOut.times', { asked: ago(p.at, ticker.now), denied: ago(p.deniedAt, ticker.now) })}</span>
          </div>
          <pre class="max-h-48 overflow-auto border border-line-soft px-2.5 py-2 mono whitespace-pre-wrap break-all">{promptInput(p)}</pre>
          {#if p.description}<p class="text-xs text-muted break-words"><span class="font-medium text-fg">{$t('permission.agentSays')}</span> {p.description}</p>{/if}
        </li>
      {/each}
    </ul>
  </details>
{/if}
