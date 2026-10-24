<!-- The drawer's Merge now card, above Delete job, for a job whose PR is open: a person's override of the merge checks.
     Merge now opens a confirm row that arms only once the job id is typed back; the server then merges the PR as
     `forge pr merge --now` does, logged as a bypass with the dashboard's name. A merged PR toasts; any other result
     (deferred, refused, failed) shows its error, or its action, inline, and a refusal shows the server's message. -->
<script lang="ts">
  import { confirmMatches, mergeNowDone, postMergeNow } from '../lib/merge-now.ts';
  import { forgeToken, refresh } from '../lib/app.svelte.ts';
  import type { Job } from '../lib/types.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';

  let { job }: { job: Pick<Job, 'id'> } = $props();
  let confirming = $state(false);
  let typed = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  const armed = $derived(confirmMatches(typed, job.id));

  function cancel(): void {
    confirming = false;
    typed = '';
    error = null;
  }

  async function merge(): Promise<void> {
    if (busy || !armed) return;
    busy = true;
    error = null;
    try {
      const r = await postMergeNow(job.id, typed.trim(), forgeToken());
      if (mergeNowDone(r)) {
        toast($t('mergeNow.done', { id: job.id }));
        cancel();
      } else error = r.error ?? r.action;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
      await refresh();
    }
  }
</script>

<div class="plate p-4 flex flex-col gap-3" id="drawer-merge-now">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="h section">{$t('mergeNow.title')}</h3>
    {#if !confirming}<button class="btn sm" onclick={() => (confirming = true)}>{$t('mergeNow.open')}</button>{/if}
  </div>
  <p class="text-sm text-muted">{$t('mergeNow.hint')}</p>
  {#if confirming}
    <label class="flex flex-col gap-1 text-sm" for="drawer-merge-now-confirm">{$t('mergeNow.typeId', { id: job.id })}</label>
    <input id="drawer-merge-now-confirm" class="input w-full mono" autocomplete="off" spellcheck="false" bind:value={typed} onkeydown={(e) => e.key === 'Enter' && merge()} />
    {#if error}<p class="text-[13px] text-bad break-words" role="alert">{error}</p>{/if}
    <div class="flex flex-wrap gap-2">
      <button class="btn sm text-bad" disabled={!armed || busy} aria-busy={busy} onclick={merge}>{$t('mergeNow.confirm')}</button>
      <button class="btn sm" disabled={busy} onclick={cancel}>{$t('mergeNow.keep')}</button>
    </div>
  {/if}
</div>
