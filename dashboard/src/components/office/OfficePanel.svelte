<!-- The Office page's panel, in two columns where the view is wide enough (lib/office/layout.ts), stacked below that. The
     left column, top to bottom: the mandates (New mandate and the editor, the open ones, unreadable ones as one line each,
     then the closed ones folded), the gate runs (only while the Foreman is on), and the latest directives, newest first;
     it scrolls on its own. The right column is the office session: the Foreman-off note, or its permission prompts and
     SessionLog filling the column, whose log pane is the one scroller. Mandates come from GET /api/mandates (S.mandates:
     on open, on the 15 s view poll and after each write); the gate runs, pending gates and the office log read the
     /api/state poll and the session stream. Mandate, directive and request strings are owner, session or tracker text and
     render only as Svelte text. -->
<script lang="ts">
  import { tick } from 'svelte';
  import Banner from '../ui/feedback/Banner.svelte';
  import Chip from '../ui/Chip.svelte';
  import Empty from '../ui/feedback/Empty.svelte';
  import MandateCard from './MandateCard.svelte';
  import MandateEditor from './MandateEditor.svelte';
  import PermissionPrompts from '../sessions/PermissionPrompts.svelte';
  import SessionLog from '../logs/SessionLog.svelte';
  import ForemanDirectivesSkeleton from '../skeletons/office/ForemanDirectivesSkeleton.svelte';
  import ForemanMandatesSkeleton from '../skeletons/office/ForemanMandatesSkeleton.svelte';
  import { OFFICE_GRID, OFFICE_LEFT, OFFICE_RIGHT } from '../../lib/office/layout.ts';
  import { DIRECTIVE_TONE, directiveActor, directiveFeed, isUnreadable, mandateGroups, pendingGates } from '../../lib/office/foreman.ts';
  import { gateRunRows, gateRunsHeader, type GateRunShown } from '../../lib/office/gate-runs.ts';
  import { pendingPrompts } from '../../lib/sessions/permissions.ts';
  import { OFFICE_SCOPE } from '../../lib/core/types.ts';
  import { ago, clock } from '../../lib/core/util.ts';
  import { S, openDrawer } from '../../lib/core/app.svelte.ts';
  import { ticker } from '../../lib/core/clock.svelte.ts';
  import { t } from '../../lib/text/locale.ts';

  const data = $derived(S.data);
  const foremanOn = $derived(data?.daemons?.foreman === true);
  const prompts = $derived(pendingPrompts(data?.daemons ?? null, OFFICE_SCOPE).length > 0);
  const list = $derived(S.mandates);
  const groups = $derived(mandateGroups(list?.mandates ?? []));
  const jobs = $derived(data?.jobs ?? []);
  const requests = $derived(data?.requests ?? []);
  const gates = $derived(foremanOn ? data?.daemons?.gates : null);
  const header = $derived(gateRunsHeader(gates));
  const runs = $derived(gateRunRows(gates));
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
  const waiting = $derived(pendingGates(requests));
  const directives = $derived(directiveFeed(list?.directives ?? []));
  const jobIds = $derived(new Set(jobs.map((j) => j.id)));

  /** The editor open, in a modal: a new mandate's, or one mandate's. */
  let editing = $state<{ mode: 'new' } | { mode: 'edit'; id: string } | null>(null);
  let newButton = $state<HTMLButtonElement>();

  async function closeEditor(): Promise<void> {
    const was = editing;
    editing = null;
    await tick();
    if (was?.mode === 'edit') document.getElementById(`mandate-edit-${was.id}`)?.focus();
    else newButton?.focus();
  }

  /** The config names the off note points at, rendered as code: the message keeps them as {placeholders}. */
  const CODE: Record<string, string> = { '{key}': 'foreman.enabled: true', '{daemonKey}': 'daemon.enabled: true', '{file}': '.forge/config.yml' };
  const parts = (text: string): string[] => text.split(/(\{key\}|\{daemonKey\}|\{file\})/);
  const absolute = (iso: string): string => new Date(iso).toLocaleString();
  /** The CLI command the empty state names, as code: the message keeps it as {cmd}. */
  const NEW_CMD = 'forge mandate new';
</script>

{#snippet howTo(text: string)}
  {#each parts(text) as part, i (i)}{#if Object.hasOwn(CODE, part)}<code class="mono">{CODE[part]}</code>{:else}{part}{/if}{/each}
{/snippet}

<div class={OFFICE_GRID}>
  <div class={OFFICE_LEFT}>
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 class="plate h section w-fit max-w-full px-3 py-1.5">{$t('foreman.office.mandates')}</h2>
      <button bind:this={newButton} class="btn primary" disabled={!list || editing?.mode === 'new'} onclick={() => (editing = { mode: 'new' })}>{$t('foreman.office.new')}</button>
    </div>
    {#if S.mandatesError}<Banner msg={$t('foreman.office.loadFailed', { error: S.mandatesError })} />{/if}
    {#if list && editing?.mode === 'new'}<MandateEditor mandates={list} onclose={closeEditor} />{/if}
    {#if !list}
      {#if !S.mandatesError}<ForemanMandatesSkeleton />{/if}
    {:else if !list.mandates.length}
      {#if editing?.mode !== 'new'}<Empty><p>{$t('foreman.office.noMandates')}</p><p class="text-xs mt-1">{#each $t('foreman.office.noMandatesHow').split('{cmd}') as part, i (i)}{#if i}<code class="mono">{NEW_CMD}</code>{/if}{part}{/each}</p></Empty>{/if}
    {:else}
      <div class="flex flex-col gap-3">
        {#each groups.open as m (m.id)}
          {#if isUnreadable(m)}
            <div class="plate flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-sm"><span class="mono">{m.id}</span><span class="text-bad break-words min-w-0">{$t('foreman.office.unreadable', { problem: m.problem })}</span></div>
          {:else}
            <MandateCard {m} jobs={jobs.filter((j) => j.mandate === m.id)} onedit={() => (editing = { mode: 'edit', id: m.id })} />
          {/if}
        {/each}
      </div>
      {#each groups.open as m (m.id)}
        {#if !isUnreadable(m) && editing?.mode === 'edit' && editing.id === m.id}<MandateEditor mandates={list} row={m} onclose={closeEditor} />{/if}
      {/each}
      {#if groups.closed.length}
        <details class="mt-3">
          <summary class="plate w-fit px-3 py-1.5 text-sm cursor-pointer">{$t('foreman.office.closed', { count: groups.closed.length })}</summary>
          <div class="mt-3 flex flex-col gap-3">{#each groups.closed as m (m.id)}<MandateCard {m} jobs={[]} />{/each}</div>
        </details>
      {/if}
    {/if}

    {#if foremanOn}
      <h2 class="plate h section w-fit max-w-full px-3 py-1.5 mt-8 mb-3">{$t('foreman.office.gateRuns')}</h2>
      {#if header.enabled}
        <p class="plain w-fit max-w-full px-3 py-1.5 mb-3 text-sm text-muted">
          <span class="mono num">{$t('statusbar.foreman.gates.running', { live: header.live, parallel: header.parallel })}</span>
          {#if header.held?.kind === 'cap'}<span class="text-warn break-words"> · {$t('statusbar.foreman.gates.pausedCap', { message: header.held.message })}</span>
          {:else if header.held?.kind === 'until'}<span class="text-warn"> · {$t('statusbar.foreman.gates.pausedUntil', { clock: clock(header.held.until) })}</span>{/if}
        </p>
      {/if}
      {#if !header.enabled}
        <p class="plate w-fit max-w-full px-3 py-1.5 text-sm text-muted">{$t('statusbar.foreman.gates.off')}</p>
      {:else if runs.length}
        <div class="plate flat"><div class="overflow-x-auto">
          <table class="tbl">
            <thead><tr><th>{$t('foreman.office.gate')}</th><th>{$t('foreman.office.target')}</th><th>{$t('foreman.office.outcome')}</th><th>{$t('foreman.office.reason')}</th><th>{$t('foreman.office.started')}</th><th>{$t('foreman.office.tokens')}</th></tr></thead>
            <tbody>
              {#each runs as r (r.key)}
                <tr>
                  <td class="whitespace-nowrap">{r.label}</td>
                  <td class="mono whitespace-nowrap">{#if r.job}<button class="hover:text-gleam" onclick={() => r.job && openDrawer(r.job)}>{r.job}</button>{:else}{r.mandate}{/if}</td>
                  <td><Chip tone={r.tone} text={outcome[r.outcome]} /></td>
                  <td class="break-words min-w-[12rem]">{r.reason ?? '—'}</td>
                  <td class="text-muted whitespace-nowrap">{r.started}</td>
                  <td class="mono num whitespace-nowrap" title={$t('statusbar.foreman.gates.spend', { usd: r.usd })}>{r.tokens}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div></div>
      {:else}
        <p class="plate w-fit max-w-full px-3 py-1.5 text-sm text-muted">{$t('statusbar.foreman.gates.empty')}</p>
      {/if}
      <p class="plain w-fit max-w-full px-3 py-1.5 mt-3 text-sm text-muted">{$t('foreman.office.gatesWaiting', { count: waiting })}</p>
    {/if}

    <h2 class="plate h section w-fit max-w-full px-3 py-1.5 mt-8 mb-3">{$t('foreman.office.directives')}</h2>
    {#if !list}
      {#if !S.mandatesError}<ForemanDirectivesSkeleton />{/if}
    {:else if directives.length}
      <div class="plate flat"><div class="overflow-x-auto">
        <table class="tbl">
          <thead><tr><th>{$t('foreman.office.when')}</th><th>{$t('foreman.office.mandate')}</th><th>{$t('foreman.office.action')}</th><th>{$t('foreman.office.issue')}</th><th>{$t('common.job')}</th><th>{$t('foreman.office.reason')}</th><th>{$t('foreman.office.actor')}</th></tr></thead>
          <tbody>
            {#each directives as d, i (i)}
              <tr>
                <td class="text-muted whitespace-nowrap" title={absolute(d.ts)}>{ago(d.ts, ticker.now)}</td>
                <td class="mono whitespace-nowrap">{d.mandate}</td>
                <td><Chip tone={DIRECTIVE_TONE[d.action]} text={d.action} /></td>
                <td class="mono break-all">{d.issue ?? '—'}</td>
                <td class="mono whitespace-nowrap">{#if d.job && jobIds.has(d.job)}<button class="hover:text-gleam" onclick={() => d.job && openDrawer(d.job)}>{d.job}</button>{:else}{d.job ?? '—'}{/if}</td>
                <td class="break-words min-w-[12rem]">{d.reason}</td>
                <td class="whitespace-nowrap">{directiveActor(d, $t('foreman.office.foremanActor'))}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div></div>
    {:else}
      <Empty>{$t('foreman.office.noDirectives')}</Empty>
    {/if}
  </div>
  <section class={foremanOn ? OFFICE_RIGHT : 'flex min-w-0 flex-col'} aria-labelledby="office-session-title">
    <h2 id="office-session-title" class="plate h section w-fit max-w-full shrink-0 px-3 py-1.5 mb-3">{$t('foreman.office.session')}</h2>
    {#if !foremanOn}
      <div class="plate flex flex-col items-start gap-2 p-4">
        <Chip extra="sm foreman off" text={$t('statusbar.foreman.tag')} />
        <p class="text-sm text-muted">{$t('statusbar.foreman.offTitle')} {$t('statusbar.foreman.offBody')}</p>
        <p class="text-sm text-muted">{@render howTo($t('statusbar.foreman.offHow'))}</p>
        <p class="text-sm text-muted">{$t('foreman.office.offMandates')}</p>
      </div>
    {:else}
      <div class="flex min-h-0 flex-1 flex-col gap-3">
        {#if prompts}<div class="max-h-[40%] shrink-0 overflow-y-auto overscroll-contain"><PermissionPrompts scope={OFFICE_SCOPE} name={$t('statusbar.foreman.officeLog')} /></div>{/if}
        <SessionLog scope={OFFICE_SCOPE} fill />
      </div>
    {/if}
  </section>
</div>
