<!-- One readable mandate on the Office page: its title, id, state and reason; its scope; its chain (with the active link
     marked) and what it waits on; its progress against its budget; its report card; the contract as it applies now and every line the
     config capped; its live jobs (each opens the drawer); a goal mandate's draft and gate, pointing at Needs you, which
     decides it. Then the actions its status offers (mandateActions): Pause and Close open a confirm row with an optional
     one-line reason (Close says it is final and starts the next link); focus moves to Confirm, and Cancel hands it back to
     the button that opened the row. A refusal is the server's error as a toast and changes nothing; a success reloads the
     mandates and the state. Every mandate string is owner or tracker text and renders as Svelte text. -->
<script lang="ts">
  import { tick } from 'svelte';
  import Chip from './Chip.svelte';
  import ReportCard from './ReportCard.svelte';
  import { STATE_TONE, inIntake, mandateActions, postMandateStatus, type MandateStatusAction } from '../lib/foreman.ts';
  import { usd } from '../lib/util.ts';
  import { S, forgeToken, loadMandates, openDrawer, refresh } from '../lib/app.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';
  import type { MandateRow, StateJob } from '../lib/types.ts';

  let { m, jobs, onedit }: { m: MandateRow; jobs: StateJob[]; onedit?: () => void } = $props();

  const actions = $derived(mandateActions(m));
  const e = $derived(m.effective);
  const p = $derived(m.progress);
  const goal = $derived(inIntake(m) && m.draft !== null);
  const gatePending = $derived(m.draft?.gate === 'pending' || m.draft?.gate === 'filing');
  /** The confirm row open for Pause or Close, with its reason. */
  let confirming = $state<'pause' | 'close' | null>(null);
  let reason = $state('');
  let busy = $state(false);
  let confirmButton = $state<HTMLButtonElement>();
  const reasonId = $derived(`mandate-reason-${m.id}`);

  async function openConfirm(action: 'pause' | 'close'): Promise<void> {
    confirming = action;
    reason = '';
    await tick();
    confirmButton?.focus();
  }

  async function cancelConfirm(): Promise<void> {
    const was = confirming;
    confirming = null;
    await tick();
    document.getElementById(`mandate-${was}-${m.id}`)?.focus();
  }

  async function act(action: MandateStatusAction): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const r = await postMandateStatus(m.id, action, reason, forgeToken());
      if (r.changed) toast(action === 'pause' ? $t('foreman.mandate.paused', { id: m.id }) : action === 'resume' ? $t('foreman.mandate.resumed', { id: m.id }) : $t('foreman.mandate.closed', { id: m.id }));
      confirming = null;
      await Promise.all([loadMandates(), refresh()]);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), true);
    } finally {
      busy = false;
    }
  }
</script>

{#snippet term(label: string, value: string)}
  <div class="min-w-0"><dt class="label text-[10px]">{label}</dt><dd class="mono text-[12px] break-words">{value}</dd></div>
{/snippet}

<article class="plate p-4 flex flex-col gap-3" aria-labelledby="mandate-title-{m.id}">
  <div class="flex flex-wrap items-start gap-2">
    <div class="min-w-0 flex-[1_1_16rem]">
      <h3 id="mandate-title-{m.id}" class="h card break-words">{m.title}</h3>
      <div class="mono muted text-[11px] break-all">{m.id}</div>
    </div>
    <Chip tone={STATE_TONE[m.state]} text={m.state} />
  </div>
  {#if m.reason}<p class="text-[13px] break-words"><span class="text-muted">{$t('foreman.mandate.reason')}</span> {m.reason}</p>{/if}

  <dl class="grid gap-x-4 gap-y-2 grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]">
    {#if m.scope.milestones.length}{@render term($t('foreman.mandate.milestones'), m.scope.milestones.join(' → '))}{/if}
    {#if m.scope.labels.length}{@render term($t('foreman.mandate.labels'), m.scope.labels.join(', '))}{/if}
    {#if m.scope.issues.length}{@render term($t('foreman.mandate.issues'), m.scope.issues.join(', '))}{/if}
    {#if inIntake(m)}{@render term($t('foreman.mandate.scope'), $t('foreman.mandate.intake'))}{/if}
  </dl>

  {#if m.chain.length > 1 || m.state === 'waiting'}
    <div class="flex flex-wrap items-center gap-1.5 text-[13px]">
      {#if m.chain.length > 1}
        <span class="label text-[10px]">{$t('foreman.mandate.chain')}</span>
        {#each m.chain as link, i (link)}{#if i}<span class="text-muted" aria-hidden="true">→</span>{/if}<Chip tone={link === m.activeLink ? 'gleam' : 'muted'} extra="normal-case tracking-normal" title={link === m.activeLink ? $t('foreman.mandate.activeLink') : undefined} text={link} />{#if link === m.activeLink}<span class="sr-only">{$t('foreman.mandate.activeLink')}</span>{/if}{/each}
      {/if}
      {#if m.state === 'waiting' && m.after}<span class="text-muted">{$t('foreman.mandate.waitingOn', { after: m.after })}</span>{/if}
    </div>
  {/if}

  <div class="flex flex-col gap-1">
    <div class="label text-[10px]">{$t('foreman.mandate.progress')}</div>
    <p class="text-[13px]">{$t('foreman.mandate.jobs', { reached: p.jobs.reached, inFlight: p.jobs.inFlight, handled: p.jobs.handled, unfinishable: p.jobs.unfinishable })}</p>
    <p class="text-[13px] num">{$t('foreman.mandate.spend', { spent: usd(p.spend.usd), budget: usd(p.spend.budget) })} · {$t('foreman.mandate.started', { started: p.started.jobs, budget: p.started.budget })}</p>
  </div>

  <ReportCard {m} />

  <details class="text-[13px]">
    <summary class="text-muted cursor-pointer">{$t('foreman.mandate.contract')}</summary>
    <dl class="mt-2 grid gap-x-4 gap-y-2 grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]">
      {@render term($t('foreman.mandate.until'), e.until)}
      {@render term($t('foreman.mandate.maxJobs'), String(e.maxJobs))}
      {@render term($t('foreman.mandate.order'), e.order)}
      {@render term($t('foreman.mandate.decides'), e.decides.length ? e.decides.join(', ') : $t('foreman.mandate.decidesNone'))}
      {@render term($t('foreman.mandate.stall'), $t('foreman.mandate.stallValue', { cadences: e.stall.cadences, bounces: e.stall.bounces }))}
      {@render term($t('foreman.mandate.onUnfinishable'), e.onUnfinishable)}
    </dl>
  </details>
  {#if m.capped.length}
    <ul class="flex flex-col gap-0.5 text-[12px] text-warn" aria-label={$t('foreman.mandate.capped')}>{#each m.capped as line, i (i)}<li class="break-words">{line}</li>{/each}</ul>
  {/if}

  {#if jobs.length}
    <div class="flex flex-wrap items-center gap-2 text-[13px]">
      <span class="label text-[10px]">{$t('foreman.mandate.liveJobs')}</span>
      {#each jobs as j (j.id)}<button class="mono hover:text-gleam" title={j.title} onclick={() => openDrawer(j.id)}>{j.id}</button>{/each}
    </div>
  {/if}

  {#if goal && m.draft}
    <p class="text-[13px]">{$t('foreman.mandate.draft', { status: m.draft.status, gate: m.draft.gate })}{#if gatePending}{' '}<span class="text-muted">{$t('foreman.mandate.draftNeedsYou')}</span>{/if}</p>
  {/if}

  {#if actions.length && S.data}
    <div class="flex flex-wrap gap-2">
      {#if actions.includes('edit')}<button id="mandate-edit-{m.id}" class="btn" disabled={busy} onclick={() => onedit?.()}>{$t('foreman.mandate.edit')}</button>{/if}
      {#if actions.includes('pause') && confirming !== 'pause'}<button id="mandate-pause-{m.id}" class="btn" disabled={busy || confirming !== null} onclick={() => openConfirm('pause')}>{$t('foreman.mandate.pause')}</button>{/if}
      {#if actions.includes('resume')}<button class="btn" disabled={busy || confirming !== null} aria-busy={busy} onclick={() => act('resume')}>{$t('foreman.mandate.resume')}</button>{/if}
      {#if actions.includes('close') && confirming !== 'close'}<button id="mandate-close-{m.id}" class="btn" disabled={busy || confirming !== null} onclick={() => openConfirm('close')}>{$t('foreman.mandate.close')}</button>{/if}
    </div>
    {#if confirming}
      <div class="plain border border-line-soft flex flex-col gap-2 p-3">
        {#if confirming === 'close'}<p class="text-[13px]">{$t('foreman.mandate.closeFinal')}</p>{/if}
        <label for={reasonId} class="label text-[10px]">{$t('foreman.mandate.reasonLabel')}</label>
        <input id={reasonId} type="text" class="w-full" maxlength="200" bind:value={reason} disabled={busy} />
        <div class="flex flex-wrap gap-2">
          <button bind:this={confirmButton} class="btn sm {confirming === 'close' ? 'text-bad' : ''}" disabled={busy} aria-busy={busy} onclick={() => confirming && act(confirming)}>{$t('foreman.mandate.confirm')}</button>
          <button class="btn sm" disabled={busy} onclick={cancelConfirm}>{$t('foreman.mandate.cancel')}</button>
        </div>
      </div>
    {/if}
  {/if}
</article>
