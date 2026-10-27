<!-- The Foreman popover's body. On: a short identity block (and, with the daemon off, how to start it; with an office
     session error, that error on one line), the office session's permission prompts when it has any, then the gate
     activity list: forge dash's gate runs, newest first (the 50 kept), under a header that says how many run of
     foreman.assistants.parallel and why new runs are paused. Each row is the gate, its job (which opens the drawer) or
     its mandate, an outcome chip, the reason on one line, when it started and its tokens, with the dollars only in a
     title. The list follows /api/state's refreshes. Off: what the Foreman is and how to turn it on by hand.
     foreman.enabled is locked in Settings and forge config set, so nothing here writes config. A reason is model or
     policy text and every value here renders as text, never markup. Both states end their identity block with Open chat,
     which lands on the Foreman page's Chats tab (chats don't need foreman.enabled) and closes the popover. -->
<script lang="ts">
  import Chip from '../Chip.svelte';
  import Icon from '../Icon.svelte';
  import PermissionPrompts from '../PermissionPrompts.svelte';
  import { OFFICE_SCOPE } from '../../lib/types.ts';
  import type { ForemanIndicator } from '../../lib/statusbar.ts';
  import { gateRunRows, gateRunsHeader, type GateRunShown } from '../../lib/gate-runs.ts';
  import { clock } from '../../lib/util.ts';
  import { S, openDrawer } from '../../lib/app.svelte.ts';
  import { closePopover } from '../../lib/popover.svelte.ts';
  import { t } from '../../lib/locale.ts';

  let { foreman }: { foreman: ForemanIndicator } = $props();

  const gates = $derived(foreman.on ? foreman.gates : null);
  const header = $derived(gateRunsHeader(gates));
  const rows = $derived(gateRunRows(gates));
  const outcome = $derived<Record<GateRunShown, string>>({
    approve: $t('statusbar.foreman.gates.outcome.approve'),
    revise: $t('statusbar.foreman.gates.outcome.revise'),
    rework: $t('statusbar.foreman.gates.outcome.rework'),
    'no-action': $t('statusbar.foreman.gates.outcome.noAction'),
    escalated: $t('statusbar.foreman.gates.outcome.escalated'),
    reserved: $t('statusbar.foreman.gates.outcome.reserved'),
    refused: $t('statusbar.foreman.gates.outcome.refused'),
    stale: $t('statusbar.foreman.gates.outcome.stale'),
    requeued: $t('statusbar.foreman.gates.outcome.requeued'),
    failed: $t('statusbar.foreman.gates.outcome.failed'),
    shelved: $t('statusbar.foreman.gates.outcome.shelved'),
    running: $t('statusbar.foreman.gates.outcome.running'),
  });

  function openJob(id: string): void {
    closePopover('navigate');
    openDrawer(id);
  }

  /** The config names a message points at, rendered as code: the message keeps them as {placeholders}. */
  const CODE: Record<string, string> = { '{key}': 'foreman.enabled: true', '{daemonKey}': 'daemon.enabled: true', '{file}': '.forge/config.yml' };
  const parts = (text: string): string[] => text.split(/(\{key\}|\{daemonKey\}|\{file\})/);
</script>

{#snippet howTo(text: string)}
  {#each parts(text) as part, i (i)}{#if Object.hasOwn(CODE, part)}<code class="mono">{CODE[part]}</code>{:else}{part}{/if}{/each}
{/snippet}

<!-- The hash may already be the Foreman page's, so the click sets the tab itself rather than leaving it to the route. -->
{#snippet openChat()}
  {#if S.selected}
    <a
      class="btn sm"
      href="#/p/{S.selected}/foreman"
      onclick={() => {
        S.foremanPanel = 'chats';
        closePopover('navigate');
      }}><Icon name="foreman" />{$t('statusbar.foreman.openChat')}</a
    >
  {/if}
{/snippet}

{#if foreman.on}
  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <div class="flex shrink-0 flex-col items-start gap-1.5">
      <Chip extra="sm foreman" text={$t('statusbar.foreman.tag')} />
      <p class="text-sm text-muted">{$t('statusbar.foreman.about')}</p>
      {#if !foreman.daemon}<p class="text-sm text-muted">{@render howTo($t('statusbar.foreman.daemonOffHow'))}</p>{/if}
      {#if foreman.officeError}<p class="w-full truncate text-sm text-bad" title={foreman.officeError}>{$t('statusbar.foreman.officeError', { error: foreman.officeError })}</p>{/if}
      {@render openChat()}
    </div>
    {#if foreman.prompts}
      <div class="flex max-h-[40%] shrink-0 flex-col gap-2 overflow-y-auto">
        <PermissionPrompts scope={OFFICE_SCOPE} name={$t('statusbar.foreman.officeLog')} />
      </div>
    {/if}
    <section class="flex min-h-0 flex-1 flex-col gap-2 border-t border-line pt-3" aria-labelledby="foreman-gate-runs">
      <div class="flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id="foreman-gate-runs" class="label">{$t('statusbar.foreman.gates.title')}</h3>
        {#if header.enabled}<span class="mono muted num">{$t('statusbar.foreman.gates.running', { live: header.live, parallel: header.parallel })}</span>{/if}
      </div>
      {#if !header.enabled}
        <p class="text-sm text-muted">{$t('statusbar.foreman.gates.off')}</p>
      {:else if header.held?.kind === 'cap'}
        <p class="text-sm text-warn break-words">{$t('statusbar.foreman.gates.pausedCap', { message: header.held.message })}</p>
      {:else if header.held?.kind === 'until'}
        <p class="text-sm text-warn">{$t('statusbar.foreman.gates.pausedUntil', { clock: clock(header.held.until) })}</p>
      {/if}
      {#if rows.length === 0}
        <p class="text-sm text-muted">{$t('statusbar.foreman.gates.empty')}</p>
      {:else}
        <ul class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto" aria-labelledby="foreman-gate-runs">
          {#each rows as r (r.key)}
            <li class="flex min-w-0 flex-col gap-0.5 border border-line-soft px-2 py-1.5">
              <div class="flex min-w-0 items-center gap-2">
                <span class="min-w-0 flex-1 truncate text-sm">{r.label}</span>
                <Chip tone={r.tone} extra="sm shrink-0" text={outcome[r.outcome]} />
              </div>
              <div class="flex min-w-0 items-center gap-2 text-xs text-muted">
                {#if r.job}
                  <button class="mono inline-flex min-h-6 min-w-0 items-center truncate text-fg underline decoration-dotted" title={$t('statusbar.foreman.gates.openJob', { job: r.job })} onclick={() => r.job && openJob(r.job)}>{r.job}</button>
                {:else}
                  <span class="mono min-w-0 truncate">{r.mandate}</span>
                {/if}
                <span class="flex-1"></span>
                <span class="shrink-0">{r.started}</span>
                <span class="mono num shrink-0" title={$t('statusbar.foreman.gates.spend', { usd: r.usd })}>{$t('statusbar.foreman.gates.tokens', { tokens: r.tokens })}</span>
              </div>
              {#if r.reason}<p class="caption muted truncate" title={r.reason}>{r.reason}</p>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
{:else}
  <div class="flex flex-col items-start gap-2">
    <Chip extra="sm foreman off" text={$t('statusbar.foreman.tag')} />
    <p class="text-sm">{$t('statusbar.foreman.about')}</p>
    <p class="text-sm text-muted">{$t('statusbar.foreman.offTitle')} {$t('statusbar.foreman.offBody')}</p>
    <p class="text-sm text-muted">{@render howTo($t('statusbar.foreman.offHow'))}</p>
    {@render openChat()}
  </div>
{/if}
