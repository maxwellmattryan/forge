<!-- One mandate's controls on the Pipeline: a graph plate's header and a table group row (Group by mandate). Its state
     chip, then play/pause (mandateToggle: no button once closed), which posts at once with no reason and keeps focus,
     then the ⋯ menu (MenuButton's menu mode, trigger id `mandate-menu-<id>`, items from mandateMenu: Edit, Close,
     Cancel with its jobs, Delete). Edit calls `onedit` (the layout renders MandateEditor at its root, outside a plate or
     a <th>); Close, Cancel and Delete open MandateConfirm on its own full-width line, with the table header's type style
     reset. Focus goes back to the ⋯ button when the panel closes. A refusal is the server's error as a toast; a success
     reloads the mandates and the state. Mandate text renders as Svelte text. -->
<script lang="ts">
  import { tick } from 'svelte';
  import Chip from '../ui/Chip.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import MenuButton from '../ui/overlay/MenuButton.svelte';
  import MandateConfirm from './MandateConfirm.svelte';
  import { STATE_TONE, mandateMenu, mandateToggle, postMandateStatus, type MandateMenuId } from '../../lib/office/foreman.ts';
  import { keepFocus, type MenuItem } from '../../lib/ui/overlay/menu.ts';
  import { loadMandates, refresh } from '../../lib/core/app.svelte.ts';
  import { toast } from '../../lib/ui/overlay/toast.svelte.ts';
  import { t } from '../../lib/text/locale.ts';
  import type { MandateRow } from '../../lib/core/types.ts';

  let { m, onedit }: { m: MandateRow; onedit: () => void } = $props();

  // The ⋯ menu sits in the table's <th> and the plate's header: its panel inherits their type style unless reset.
  const RESET = 'font-sans font-normal text-[14px] leading-5 normal-case tracking-normal text-fg text-left';

  let busy = $state(false);
  let confirmBusy = $state(false);
  let confirming = $state<'close' | 'cancel' | 'delete' | null>(null);
  const toggle = $derived(mandateToggle(m));
  const menuId = $derived(`mandate-menu-${m.id}`);
  const labels = $derived<Record<MandateMenuId, string>>({
    edit: $t('foreman.mandate.menu.edit'),
    close: $t('foreman.mandate.menu.close'),
    cancel: $t('foreman.mandate.menu.cancel'),
    delete: $t('foreman.mandate.menu.delete'),
  });
  const hints = $derived<Record<MandateMenuId, string | undefined>>({
    edit: $t('foreman.mandate.menu.closedHint'),
    close: $t('foreman.mandate.menu.closedHint'),
    cancel: undefined,
    delete: $t('foreman.mandate.menu.deleteHint'),
  });
  const items = $derived<MenuItem[]>(mandateMenu(m).map((i) => ({ ...i, label: labels[i.id], hint: i.disabled ? hints[i.id] : undefined })));

  async function refocus(): Promise<void> {
    await tick();
    document.getElementById(menuId)?.focus();
  }

  function select(id: string): void {
    if (busy || confirmBusy) return;
    if (id === 'edit') onedit();
    else if (id === 'close' || id === 'cancel' || id === 'delete') confirming = id;
  }

  function closeConfirm(): void {
    confirming = null;
    void refocus();
  }

  async function flip(e: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }): Promise<void> {
    const action = toggle;
    if (busy || action === null) return;
    const restore = keepFocus(e.currentTarget);
    busy = true;
    try {
      const r = await postMandateStatus(m.id, action, '');
      if (r.changed) toast(action === 'pause' ? $t('foreman.mandate.paused', { id: m.id }) : $t('foreman.mandate.resumed', { id: m.id }));
      await Promise.all([loadMandates(), refresh()]);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), true);
    } finally {
      busy = false;
      await tick();
      restore();
    }
  }
</script>

<span class="ml-auto flex shrink-0 items-center gap-1.5 {RESET}">
  <Chip tone={STATE_TONE[m.state]} text={m.state} />
  {#if toggle}<IconButton icon={toggle === 'pause' ? 'pause' : 'play'} label={toggle === 'pause' ? $t('foreman.mandate.pauseMandate') : $t('foreman.mandate.resumeMandate')} disabled={busy} onclick={flip} />{/if}
  <MenuButton id={menuId} iconOnly icon="more" label={$t('foreman.mandate.actions')} title={$t('foreman.mandate.actions')} {items} onselect={select} />
</span>
{#if confirming}
  <div class="basis-full min-w-0 {RESET}"><MandateConfirm {m} kind={confirming} bind:busy={confirmBusy} onclose={closeConfirm} /></div>
{/if}
