<!-- The confirm panel for one mandate action (`kind`), shared by the Office card (Pause, Close) and the Pipeline's
     mandate controls (Close, Cancel with its jobs, Delete). Pause, Close and Cancel take an optional one-line reason;
     Close and Cancel say what they do first; Delete asks for the mandate id typed again, and its Confirm stays disabled
     until the trimmed text equals it (the server checks `confirm` again: this is UX, not the guard). Opening focuses
     Confirm, or the id field for Delete. Cancel posts nothing and calls `onclose(false)`, so the caller puts focus back;
     a success toasts, reloads the mandates and the state, then calls `onclose(true)`. A refusal is the server's error as
     a toast, and the panel stays open with its input. Ids and errors render as Svelte text. -->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { deleteReady, postMandateCancel, postMandateDelete, postMandateStatus, type MandateConfirmAction } from '../../lib/office/foreman.ts';
  import { loadMandates, refresh } from '../../lib/core/app.svelte.ts';
  import { toast } from '../../lib/ui/overlay/toast.svelte.ts';
  import { t } from '../../lib/text/locale.ts';

  // `kind`, not `action`: the dashboard invariants read an `action=` attribute as a URL. `busy` is bindable so the
  // Pipeline's ⋯ menu ignores a choice while Confirm's request runs.
  let { m, kind, onclose, busy = $bindable(false) }: { m: { id: string }; kind: MandateConfirmAction; onclose: (done: boolean) => void; busy?: boolean } = $props();

  const uid = $props.id();
  const fieldId = `${uid}-field`;
  let reason = $state('');
  let typed = $state('');
  let confirmButton = $state<HTMLButtonElement>();
  let idField = $state<HTMLInputElement>();
  const ready = $derived(kind !== 'delete' || deleteReady(typed, m.id));

  // A new kind (the menu chosen again while open) starts with empty fields and takes focus again.
  $effect(() => {
    const k = kind;
    untrack(() => {
      reason = '';
      typed = '';
      void tick().then(() => (k === 'delete' ? idField : confirmButton)?.focus());
    });
  });

  async function confirm(): Promise<void> {
    if (busy || !ready) return;
    busy = true;
    try {
      if (kind === 'cancel') {
        const r = await postMandateCancel(m.id, reason);
        if (r.changed || r.cancelled.length) toast($t('foreman.mandate.cancelled', { id: m.id, count: r.cancelled.length }));
      } else if (kind === 'delete') {
        await postMandateDelete(m.id);
        toast($t('foreman.mandate.deleted', { id: m.id }));
      } else {
        const r = await postMandateStatus(m.id, kind, reason);
        if (r.changed) toast(kind === 'pause' ? $t('foreman.mandate.paused', { id: m.id }) : $t('foreman.mandate.closed', { id: m.id }));
      }
      await Promise.all([loadMandates(), refresh()]);
      onclose(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), true);
    } finally {
      busy = false;
    }
  }
</script>

<div class="plain border border-line-soft flex flex-col gap-2 p-3">
  {#if kind === 'close'}<p class="text-[13px]">{$t('foreman.mandate.closeFinal')}</p>{/if}
  {#if kind === 'cancel'}<p class="text-[13px]">{$t('foreman.mandate.cancelFinal')}</p>{/if}
  {#if kind === 'delete'}
    <p class="text-[13px]">{$t('foreman.mandate.deleteFinal')}</p>
    <label for={fieldId} class="label text-[10px]">{$t('foreman.mandate.deleteType', { id: m.id })}</label>
    <input bind:this={idField} id={fieldId} type="text" class="mono w-full" autocomplete="off" spellcheck="false" bind:value={typed} disabled={busy} />
  {:else}
    <label for={fieldId} class="label text-[10px]">{$t('foreman.mandate.reasonLabel')}</label>
    <input id={fieldId} type="text" class="w-full" maxlength="200" bind:value={reason} disabled={busy} />
  {/if}
  <div class="flex flex-wrap gap-2">
    <button bind:this={confirmButton} type="button" class="btn sm {kind === 'pause' ? '' : 'text-bad'}" disabled={busy || !ready} aria-busy={busy} onclick={confirm}>{$t('foreman.mandate.confirm')}</button>
    <button type="button" class="btn sm" disabled={busy} onclick={() => onclose(false)}>{$t('foreman.mandate.cancel')}</button>
  </div>
</div>
