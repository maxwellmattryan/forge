<!-- A "Needs you" card for a goal mandate's milestone draft at the milestone-approval gate: the mandate, who owns the gate,
     the milestone with its exit criteria, the owner's goal (collapsed) and the issues wave by wave, each a fold with its
     Why / What to do / Done. Pending: a note and Approve and file / Request changes / Reject (with a confirm row, since it
     closes the mandate; focus moves to its Confirm, and back to Reject on Cancel). A stopped filing: its error and Retry
     filing only. The card fetches the draft when it mounts and whenever /api/state's request or digest moves (not on every
     poll), and every POST carries the request and digest of the draft it rendered.
     Draft, goal and error text is outside text: it renders as Svelte text, and only why / what to do / done go through md(). -->
<script lang="ts">
  import { tick } from 'svelte';
  import Chip from '../ui/Chip.svelte';
  import { md } from '../../lib/text/markdown.ts';
  import { draftCardActions, draftDecisionBody, fetchDraft, postDraftDecision, wavesOf } from '../../lib/office/drafts.ts';
  import { gateOwnerBadge } from '../../lib/gates/inbox.ts';
  import { errorText } from '../../lib/core/util.ts';
  import { refresh } from '../../lib/core/app.svelte.ts';
  import { toast } from '../../lib/ui/overlay/toast.svelte.ts';
  import { t } from '../../lib/text/locale.ts';
  import type { DraftGate, MandateDraftResponse, PostMandateDraftBody } from '../../lib/core/types.ts';

  let { gate }: { gate: DraftGate } = $props();

  let data = $state.raw<MandateDraftResponse | null>(null);
  let error = $state<string | null>(null);
  let loads = $state(0);
  let note = $state('');
  let busy = $state(false);
  let confirming = $state(false);
  let rejectButton = $state<HTMLButtonElement>();
  let confirmButton = $state<HTMLButtonElement>();

  const owner = $derived(gateOwnerBadge(gate.owner));
  const actions = $derived(draftCardActions(gate.status));
  const waves = $derived(data?.draft ? wavesOf(data.draft) : []);
  const existing = $derived(data?.draft ? data.draft.issues.filter((i) => i.existing).length : 0);
  const noteId = $derived(`draft-note-${gate.mandate}`);
  // Strings, so a poll that hands over a new but equal gate object changes neither and fetches nothing.
  const mandate = $derived(gate.mandate);
  const draftKey = $derived(`${gate.mandate}|${gate.request}|${gate.digest}`);

  $effect(() => {
    const id = mandate;
    void draftKey;
    void loads;
    error = null;
    fetchDraft(id)
      .then((d) => {
        if (id === mandate) data = d;
      })
      .catch((e) => {
        if (id === mandate) error = errorText(e instanceof Error ? e.message : String(e));
      });
  });

  // The button that had focus unmounts with its row: focus goes to the row that replaces it.
  async function openConfirm(): Promise<void> {
    confirming = true;
    await tick();
    confirmButton?.focus();
  }

  async function cancelConfirm(): Promise<void> {
    confirming = false;
    await tick();
    rejectButton?.focus();
  }

  async function decide(decision: PostMandateDraftBody['decision']): Promise<void> {
    if (!data?.request || !data.digest || busy) return;
    busy = true;
    try {
      const r = await postDraftDecision(gate.mandate, draftDecisionBody(decision, data.request, data.digest, note));
      if (r.decision === 'approve') toast($t('milestoneDraft.filed', { milestone: r.filing.milestone.title, count: r.filing.issues.length }));
      else toast(r.decision === 'revise' ? $t('milestoneDraft.revised') : $t('milestoneDraft.rejected'));
      note = '';
      confirming = false;
      await refresh();
    } catch (e) {
      toast($t('milestoneDraft.failed', { error: e instanceof Error ? e.message : String(e) }), true);
    } finally {
      busy = false;
    }
  }
</script>

<div class="plate ember p-4 flex flex-col gap-3">
  <div class="flex flex-wrap items-start gap-2">
    <div class="min-w-0 flex-[1_1_16rem]">
      <div class="label text-[10px]">{$t('milestoneDraft.kicker')}</div>
      <div class="h card break-words">{gate.title}</div>
      <div class="mono muted text-[11px] truncate" title={gate.mandate}>{$t('milestoneDraft.mandate', { id: gate.mandate })}</div>
    </div>
    <div class="flex flex-wrap items-center gap-1.5">
      {#if gate.leftForHuman}<Chip tone="you" extra="sm" title={$t('gate.leftForHumanTitle')} text={$t('gate.leftForHuman')} />{:else if owner}<Chip tone={owner.tone} extra="sm" title={owner.foreman ? $t('gate.foremanTitle') : $t('gate.humanTitle')} text={owner.foreman ? $t('gate.foreman') : $t('gate.human')} />{/if}
    </div>
  </div>

  {#if error}
    <div class="flex flex-wrap items-baseline gap-2 text-[13px]" role="alert"><span class="text-bad break-words">{$t('milestoneDraft.loadFailed', { error })}</span><button class="text-gleam underline underline-offset-2" onclick={() => loads++}>{$t('milestoneDraft.retryLoad')}</button></div>
  {:else if !data}
    <p class="muted text-[13px]">{$t('milestoneDraft.loading')}</p>
  {:else}
    {#if data.draft}
      <div class="flex flex-col gap-1">
        <div class="h section break-words">{data.draft.milestone.title}</div>
        <div class="muted text-[13px]">{$t('milestoneDraft.issues', { count: data.draft.issues.length })} {$t('milestoneDraft.waves', { count: waves.length })}{#if existing}{' · '}{$t('milestoneDraft.existing', { count: existing })}{/if}</div>
      </div>
      <div class="flex flex-col gap-1">
        <div id="exit-{gate.mandate}" class="label text-[10px]">{$t('milestoneDraft.exitCriteria')}</div>
        <ul aria-labelledby="exit-{gate.mandate}" class="list-disc pl-5 text-[13px] flex flex-col gap-0.5">{#each data.draft.milestone.exitCriteria as c, i (i)}<li class="break-words">{c}</li>{/each}</ul>
      </div>
    {/if}
    <details class="text-[13px]">
      <summary class="text-muted cursor-pointer">{$t('milestoneDraft.goal')}</summary>
      <p class="mt-1 whitespace-pre-wrap break-words">{data.goal}</p>
    </details>
    {#each waves as w (w.wave)}
      <div class="flex flex-col gap-1">
        <div class="label text-[10px]">{$t('milestoneDraft.wave', { count: w.wave })}</div>
        {#each w.issues as it (it.key)}
          <details class="plain border border-line-soft px-2 py-1.5 text-[13px]">
            <summary class="cursor-pointer break-words"><span>{it.title}</span>{' '}<span class="muted">· {it.stat}</span>{' '}<span class="mono muted text-[11px]">{it.key}</span></summary>
            <div class="mt-2 flex flex-col gap-2">
              <div><div class="label text-[10px]">{$t('milestoneDraft.why')}</div><div class="prose compact break-words">{@html md(it.why)}</div></div>
              <div><div class="label text-[10px]">{$t('milestoneDraft.whatToDo')}</div><div class="prose compact break-words">{@html md(it.whatToDo)}</div></div>
              <div><div class="label text-[10px]">{$t('milestoneDraft.done')}</div><div class="prose compact break-words">{@html md(it.done)}</div></div>
              <div class="mono text-[12px] break-all"><span class="muted">{$t('milestoneDraft.files')}:</span> {it.files.join(', ')}</div>
              {#if it.dependsOn.length}<div class="mono text-[12px] break-all"><span class="muted">{$t('milestoneDraft.dependsOn')}:</span> {it.dependsOn.join(', ')}</div>{/if}
              {#if it.existing}<div class="text-[12px] break-all">{$t('milestoneDraft.existingRef', { action: it.existing.action, ref: it.existing.ref })}</div>{/if}
            </div>
          </details>
        {/each}
      </div>
    {/each}

    {#if actions.includes('retry')}
      {#if gate.error}<p class="text-[13px] text-bad break-words" role="alert">{$t('milestoneDraft.filingStopped', { error: gate.error })}</p>{/if}
      <p class="muted text-[12px]">{$t('milestoneDraft.filingHint')}</p>
      <div class="flex flex-wrap gap-2"><button class="btn primary" disabled={busy} aria-busy={busy} onclick={() => decide('approve')}>{$t('milestoneDraft.retry')}</button></div>
    {:else}
      <textarea id={noteId} rows="2" class="input w-full" placeholder={$t('milestoneDraft.note')} aria-label={$t('milestoneDraft.note')} bind:value={note}></textarea>
      <div class="flex flex-wrap gap-2">
        <button class="btn primary" disabled={busy} aria-busy={busy} onclick={() => decide('approve')}>{$t('milestoneDraft.approve')}</button>
        <button class="btn" disabled={busy || !note.trim()} onclick={() => decide('revise')}>{$t('milestoneDraft.revise')}</button>
        {#if !confirming}<button bind:this={rejectButton} class="btn" disabled={busy} onclick={openConfirm}>{$t('milestoneDraft.reject')}</button>{/if}
      </div>
      {#if confirming}
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-[13px]">{$t('milestoneDraft.rejectConfirm')}</span>
          <button bind:this={confirmButton} class="btn sm text-bad" disabled={busy} aria-busy={busy} onclick={() => decide('reject')}>{$t('milestoneDraft.confirm')}</button>
          <button class="btn sm" disabled={busy} onclick={cancelConfirm}>{$t('milestoneDraft.cancel')}</button>
        </div>
      {/if}
    {/if}
  {/if}
</div>
