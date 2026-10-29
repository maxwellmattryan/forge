<!-- Needs you's first section while the repo budget holds work: the CLI's reason, the jobs it parked (a title opens the
     job's pane) and Acknowledge, which grants one more period (the month when a month cap is reached, else the day).
     Titles and the reason are untrusted and render as text; an error toasts the server's message. -->
<script lang="ts">
  import type { ApiState } from '../../lib/core/types.ts';
  import { ackPeriod } from '../../lib/metrics/repo-budget.ts';
  import { openDrawer, postBudgetAck, refresh } from '../../lib/core/app.svelte.ts';
  import { toast } from '../../lib/ui/overlay/toast.svelte.ts';
  import { t } from '../../lib/text/locale.ts';

  let { data }: { data: ApiState } = $props();
  const b = $derived(data.budget);
  const period = $derived(ackPeriod(b));
  const held = $derived(b.heldJobs.map((id) => ({ id, title: data.jobs.find((j) => j.id === id)?.title ?? id })));
  let busy = $state(false);

  async function ack(p: string): Promise<void> {
    busy = true;
    try {
      await postBudgetAck(p);
      toast($t('budget.acked', { period: p }));
      await refresh();
    } catch (e) {
      toast($t('budget.ackFailed', { error: e instanceof Error ? e.message : String(e) }), true);
    } finally {
      busy = false;
    }
  }
</script>

<section class="flex flex-col gap-3" aria-labelledby="needs-repo-budget">
  <h3 id="needs-repo-budget" class="label">{$t('budget.section')}</h3>
  <div class="plate ember p-4 flex flex-col gap-3">
    {#if b.reason}<div class="text-[13px]">{b.reason}</div>{/if}
    <div class="flex flex-col gap-1.5">
      <div id="repo-held-jobs" class="label text-[10px]">{$t('budget.heldJobs')}</div>
      {#if held.length}
        <ul aria-labelledby="repo-held-jobs" class="flex flex-col gap-1">
          {#each held as h (h.id)}<li><button class="h card text-left hover:text-gleam" onclick={() => openDrawer(h.id)}>{h.title}</button><div class="mono muted text-[11px]">{h.id}</div></li>{/each}
        </ul>
      {:else}
        <p class="muted text-[12px]">{$t('budget.noHeldJobs')}</p>
      {/if}
    </div>
    {#if period}
      <div class="flex flex-wrap items-center gap-3">
        <button class="btn sm" disabled={busy} aria-describedby="repo-ack-help" onclick={() => ack(period)}>{$t('budget.acknowledge', { period })}</button>
        <span id="repo-ack-help" class="caption muted">{$t('budget.ackHelp')}</span>
      </div>
    {/if}
  </div>
</section>
