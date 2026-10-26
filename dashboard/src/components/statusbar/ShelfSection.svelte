<!-- The Needs-you popover's Shelved list: the jobs a person set aside, which block nothing and don't count as waiting
     on you. Each row has a checkbox, its title (opens the job), id, reason, the gate it came from, who shelved it and when,
     and its PR. The batch bar sends one POST /api/shelf for the selected rows: Approve and Close only open a confirm row
     that names the count (its own button posts), Rework needs the note. The list refreshes as soon as the POST returns and
     a toast lists what each job did; focus goes back to a control that is still there (Cancel to the bar's button, a
     finished action to Select all) so the keyboard keeps its place in the popover.
     Titles, reasons and logins are untrusted and render as text. -->
<script lang="ts">
  import { tick } from 'svelte';
  import PrChip from '../PrChip.svelte';
  import { postShelf, shelfActionReady, shelfBody, shelfPress, shelfRows, shelfSummary } from '../../lib/shelf.ts';
  import type { JobLike } from '../../lib/job-state.ts';
  import type { ShelfAction } from '../../lib/types.ts';
  import { forgeToken, openDrawer, refresh } from '../../lib/app.svelte.ts';
  import { keepFocus } from '../../lib/popover.svelte.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import { ticker } from '../../lib/clock.svelte.ts';
  import { ago } from '../../lib/util.ts';
  import { t } from '../../lib/locale.ts';

  let { jobs }: { jobs: JobLike[] } = $props();
  const rows = $derived(shelfRows(jobs));
  // Ids, so a poll that hands over new job objects keeps the selection; a row that left the list leaves it too.
  let picked = $state<string[]>([]);
  const chosen = $derived(rows.filter((r) => picked.includes(r.id)));
  const all = $derived(rows.length > 0 && chosen.length === rows.length);
  let note = $state('');
  let busy = $state(false);
  let confirming = $state<ShelfAction | null>(null);
  let confirmButton = $state<HTMLButtonElement>();
  let selectAllBox = $state<HTMLInputElement>();
  let barButtons = $state<Partial<Record<ShelfAction, HTMLButtonElement | null>>>({});

  const ACTIONS: ShelfAction[] = ['approve', 'rework', 'unshelve', 'close'];
  // Literal keys, so the message check can find each one.
  const label = (a: ShelfAction): string =>
    a === 'approve' ? $t('shelf.action.approve') : a === 'rework' ? $t('shelf.action.rework') : a === 'unshelve' ? $t('shelf.action.unshelve') : $t('shelf.action.close');
  const confirmText = (a: ShelfAction, count: number): string => (a === 'close' ? $t('shelf.confirmClose', { count }) : $t('shelf.confirmApprove', { count }));
  const doneText = (o: 'approved' | 'reworked' | 'unshelved' | 'closed', count: number): string =>
    o === 'approved' ? $t('shelf.done.approved', { count }) : o === 'reworked' ? $t('shelf.done.reworked', { count }) : o === 'unshelved' ? $t('shelf.done.unshelved', { count }) : $t('shelf.done.closed', { count });

  function toggle(id: string, on: boolean): void {
    picked = on ? [...picked.filter((x) => x !== id), id] : picked.filter((x) => x !== id);
    confirming = null;
  }

  function toggleAll(on: boolean): void {
    picked = on ? rows.map((r) => r.id) : [];
    confirming = null;
  }

  // The control that had focus (the confirm button, or a bar button that disabled itself) may be gone or inert: put focus on
  // one that is still here, else on the popover, as NeedsPanel does when the whole section goes.
  async function settleFocus(): Promise<void> {
    await tick();
    const at = document.activeElement;
    if (at && at !== document.body) return;
    const next = confirming ? confirmButton : selectAllBox;
    if (next) next.focus();
    else keepFocus();
  }

  // The bar's Approve and Close only open the confirm (shelfPress); `via: 'confirm'` is its own button.
  async function press(a: ShelfAction, via: 'bar' | 'confirm'): Promise<void> {
    if (busy) return;
    const step = shelfPress(a, via, chosen.length, note);
    if (step === 'none') return;
    if (step === 'confirm') {
      confirming = a;
      await tick();
      confirmButton?.focus();
      return;
    }
    busy = true;
    try {
      const r = await postShelf(shelfBody(a, chosen, note), forgeToken());
      const summary = shelfSummary(r.results, {
        outcome: doneText,
        skipped: (id, reason) => $t('shelf.skipped', { id, reason }),
      });
      toast(summary.text, summary.bad);
      picked = [];
      note = '';
      confirming = null;
      await refresh();
    } catch (e) {
      toast($t('shelf.failed', { error: e instanceof Error ? e.message : String(e) }), true);
    } finally {
      busy = false;
    }
    await settleFocus();
  }

  async function cancelConfirm(): Promise<void> {
    const a = confirming;
    confirming = null;
    await tick();
    if (a) barButtons[a]?.focus();
  }
</script>

{#if rows.length}
  <section class="flex flex-col gap-2" aria-labelledby="needs-shelved">
    <h3 id="needs-shelved" class="label">{$t('shelf.heading')}</h3>
    <p class="text-muted text-xs">{$t('shelf.about')}</p>
    <ul class="plate flat needs-list">
      {#each rows as r (r.id)}
        <li class="needs-row">
          <div class="flex min-w-0 items-start gap-2">
            <!-- The label is the hit area: the box itself is 14 px. -->
            <label class="flex min-h-6 min-w-6 shrink-0 cursor-pointer items-center justify-center">
              <input type="checkbox" class="check" checked={picked.includes(r.id)} aria-label={$t('shelf.select', { id: r.id })} onchange={(e) => toggle(r.id, e.currentTarget.checked)} />
            </label>
            <div class="flex min-w-0 flex-1 flex-col gap-2">
              <div class="min-w-0">
                <button class="h card block w-full text-left break-words hover:text-gleam" onclick={() => openDrawer(r.id)}>{r.title}</button>
                <div class="mono muted text-[11px] truncate" title={r.id}>{r.id}</div>
              </div>
              <p class="break-words">{r.reason}</p>
              <div class="flex flex-wrap items-center gap-2 text-muted text-xs">
                <span>{$t('shelf.from', { gate: r.from })}</span>
                <span>{r.by ? $t('shelf.byWhen', { who: r.by, ago: ago(r.at, ticker.now) }) : $t('shelf.when', { ago: ago(r.at, ticker.now) })}</span>
                <PrChip pr={r.pr} />
              </div>
            </div>
          </div>
        </li>
      {/each}
    </ul>
    <div class="plate flat flex flex-col gap-2 p-3" aria-busy={busy}>
      <label class="field text-sm"><input bind:this={selectAllBox} type="checkbox" class="check" checked={all} indeterminate={chosen.length > 0 && !all} onchange={(e) => toggleAll(e.currentTarget.checked)} />{$t('shelf.selectAll', { count: chosen.length, total: rows.length })}</label>
      <textarea id="shelf-note" rows="2" class="input w-full" placeholder={$t('shelf.note')} aria-label={$t('shelf.note')} bind:value={note}></textarea>
      <div class="flex flex-wrap gap-2">
        {#each ACTIONS as a (a)}
          <button bind:this={barButtons[a]} class="btn sm {a === 'unshelve' ? 'primary' : ''}" disabled={busy || !shelfActionReady(a, chosen.length, note)} onclick={() => press(a, 'bar')}>{label(a)}</button>
        {/each}
      </div>
      {#if confirming}
        {@const c = confirming}
        <div class="flex flex-wrap items-center gap-2">
          <span id="shelf-confirm-text" class="text-[13px]">{confirmText(c, chosen.length)}</span>
          <button bind:this={confirmButton} class="btn sm {c === 'close' ? 'text-bad' : 'primary'}" aria-describedby="shelf-confirm-text" disabled={busy} aria-busy={busy} onclick={() => press(c, 'confirm')}>{label(c)}</button>
          <button class="btn sm" disabled={busy} onclick={cancelConfirm}>{$t('shelf.cancel')}</button>
        </div>
      {/if}
    </div>
  </section>
{/if}
