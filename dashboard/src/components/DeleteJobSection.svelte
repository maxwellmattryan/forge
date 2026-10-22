<!-- The drawer's Delete job card, at the foot of Details: for a job started by mistake. Delete opens a confirm row that
     arms only once the job id is typed back; the server stops the job's dashboard session, removes its worktree, backing
     services and branch, and deletes its record for good. A job with a PR or an eval job gets the reason instead of the
     button, and any other refusal (a live session, split children, an active dependent) shows the server's message. -->
<script lang="ts">
  import { confirmMatches, deleteBlocker, postDeleteJob } from '../lib/delete-job.ts';
  import { closeDrawer, forgeToken, refresh } from '../lib/app.svelte.ts';
  import type { Job } from '../lib/types.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';

  let { job }: { job: Pick<Job, 'id' | 'kind' | 'pr'> } = $props();
  const blocker = $derived(deleteBlocker(job));
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

  async function remove(): Promise<void> {
    if (busy || !armed) return;
    busy = true;
    error = null;
    try {
      await postDeleteJob(job.id, typed.trim(), forgeToken());
      toast($t('deleteJob.done', { id: job.id }));
      closeDrawer();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
      await refresh();
    }
  }
</script>

<div class="plate p-4 flex flex-col gap-3" id="drawer-delete">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="h section">{$t('deleteJob.title')}</h3>
    {#if !blocker && !confirming}<button class="btn sm" onclick={() => (confirming = true)}>{$t('deleteJob.open')}</button>{/if}
  </div>
  {#if blocker === 'pr'}
    <p class="text-sm text-muted">{$t('deleteJob.hasPr')}</p>
  {:else if blocker === 'eval'}
    <p class="text-sm text-muted">{$t('deleteJob.eval')}</p>
  {:else}
    <p class="text-sm text-muted">{$t('deleteJob.hint')}</p>
    {#if confirming}
      <label class="flex flex-col gap-1 text-sm" for="drawer-delete-confirm">{$t('deleteJob.typeId', { id: job.id })}</label>
      <input id="drawer-delete-confirm" class="input w-full mono" autocomplete="off" spellcheck="false" bind:value={typed} onkeydown={(e) => e.key === 'Enter' && remove()} />
      {#if error}<p class="text-[13px] text-bad break-words" role="alert">{error}</p>{/if}
      <div class="flex flex-wrap gap-2">
        <button class="btn sm text-bad" disabled={!armed || busy} aria-busy={busy} onclick={remove}>{$t('deleteJob.confirm')}</button>
        <button class="btn sm tertiary" disabled={busy} onclick={cancel}>{$t('deleteJob.keep')}</button>
      </div>
    {/if}
  {/if}
</div>
