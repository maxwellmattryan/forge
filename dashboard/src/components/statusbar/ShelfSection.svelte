<!-- The Needs-you popover's Shelved list: the jobs a person set aside, which block nothing and don't count as waiting
     on you. Each row has a checkbox, its title (opens the job), id, reason, the gate it came from, who shelved it and when,
     and its PR. The batch bar sends one POST /api/shelf for the selected rows: Approve and Close ask for a second click
     that names the count, Rework needs the note. Rows leave on the next state poll; a toast lists what each job did.
     Titles, reasons and logins are untrusted and render as text. -->
<script lang="ts">
  import { tick } from 'svelte';
  import PrChip from '../PrChip.svelte';
  import { postShelf, shelfActionReady, shelfBody, shelfNeedsConfirm, shelfRows, shelfSummary } from '../../lib/shelf.ts';
  import type { JobLike } from '../../lib/job-state.ts';
  import type { ShelfAction } from '../../lib/types.ts';
  import { forgeToken, openDrawer } from '../../lib/app.svelte.ts';
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

  async function press(a: ShelfAction): Promise<void> {
    if (busy || !shelfActionReady(a, chosen.length, note)) return;
    if (shelfNeedsConfirm(a) && confirming !== a) {
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
    } catch (e) {
      toast($t('shelf.failed', { error: e instanceof Error ? e.message : String(e) }), true);
    } finally {
      busy = false;
    }
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
            <input type="checkbox" class="check mt-1" checked={picked.includes(r.id)} aria-label={$t('shelf.select', { id: r.id })} onchange={(e) => toggle(r.id, e.currentTarget.checked)} />
            <div class="min-w-0 flex-1">
              <button class="h card block w-full text-left break-words hover:text-gleam" onclick={() => openDrawer(r.id)}>{r.title}</button>
              <div class="mono muted text-[11px] truncate" title={r.id}>{r.id}</div>
            </div>
          </div>
          <p class="break-words">{r.reason}</p>
          <div class="flex flex-wrap items-center gap-2 text-muted text-xs">
            <span>{$t('shelf.from', { gate: r.from })}</span>
            <span>{r.by ? $t('shelf.byWhen', { who: r.by, ago: ago(r.at, ticker.now) }) : $t('shelf.when', { ago: ago(r.at, ticker.now) })}</span>
            <PrChip pr={r.pr} />
          </div>
        </li>
      {/each}
    </ul>
    <div class="plate flat flex flex-col gap-2 p-3" aria-busy={busy}>
      <label class="field text-sm"><input type="checkbox" class="check" checked={all} indeterminate={chosen.length > 0 && !all} onchange={(e) => toggleAll(e.currentTarget.checked)} />{$t('shelf.selectAll', { count: chosen.length, total: rows.length })}</label>
      <textarea id="shelf-note" rows="2" class="input w-full" placeholder={$t('shelf.note')} aria-label={$t('shelf.note')} bind:value={note}></textarea>
      <div class="flex flex-wrap gap-2">
        {#each ACTIONS as a (a)}
          <button class="btn sm {a === 'unshelve' ? 'primary' : ''}" disabled={busy || !shelfActionReady(a, chosen.length, note)} onclick={() => press(a)}>{label(a)}</button>
        {/each}
      </div>
      {#if confirming}
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-[13px]">{confirmText(confirming, chosen.length)}</span>
          <button bind:this={confirmButton} class="btn sm {confirming === 'close' ? 'text-bad' : 'primary'}" disabled={busy} aria-busy={busy} onclick={() => press(confirming!)}>{label(confirming)}</button>
          <button class="btn sm" disabled={busy} onclick={() => (confirming = null)}>{$t('shelf.cancel')}</button>
        </div>
      {/if}
    </div>
  </section>
{/if}
