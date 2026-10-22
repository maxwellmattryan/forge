<!-- The repo-proposal gate's answers (step RP1): the proposals an agent made (repo-proposals.json), each with its status and
     reason, and (with `buttons`, rendered after the note) Approve repos / Reject repos, which decide the pending repos the list
     shows (`shown`, bound by JobActions from the list instance) through POST /api/jobs/:id/repos with the note. The server
     refuses (409) unless those are the whole pending set from the job's events, since the file is session-editable.
     Reasons and notes are agent-written job state: they render as text, never as markup. An error toasts the server's message.
     Approve repos is primary only in the drawer's action dock (`dock`). -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import { api } from '../lib/util.ts';
  import { forgeToken, refresh } from '../lib/app.svelte.ts';
  import { parseRepoProposals, pendingRepos, postRepoDecision, proposalTone } from '../lib/repo-proposals.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';
  import type { RepoProposal } from '../lib/types.ts';

  let { id, note = $bindable(''), buttons = false, shown = $bindable([]), dock = false }: { id: string; note?: string; buttons?: boolean; shown?: string[]; dock?: boolean } = $props();

  let rows = $state<RepoProposal[]>([]);
  let busy = $state(false);

  $effect(() => {
    if (buttons) return;
    const job = id;
    rows = [];
    shown = [];
    api<string>(`/api/jobs/${encodeURIComponent(job)}/file?path=${encodeURIComponent('repo-proposals.json')}`)
      .then((text) => {
        if (job !== id) return;
        rows = parseRepoProposals(typeof text === 'string' ? text : JSON.stringify(text));
        shown = pendingRepos(rows);
      })
      .catch(() => {});
  });

  async function decide(decision: 'approve' | 'reject'): Promise<void> {
    busy = true;
    // The note clears as soon as the decision goes, and comes back only if it failed and nothing new was typed.
    const text = note;
    note = '';
    try {
      const r = await postRepoDecision(id, decision, shown, text, forgeToken());
      toast(decision === 'approve' ? $t('repoProposal.approved', { repos: r.repos.join(', ') }) : $t('repoProposal.rejected', { repos: r.repos.join(', ') }));
      await refresh();
    } catch (e) {
      if (note === '') note = text;
      toast($t('repoProposal.failed', { error: e instanceof Error ? e.message : String(e) }), true);
    } finally {
      busy = false;
    }
  }
</script>

{#if buttons}
  <div class="flex flex-wrap gap-2">
    <button class="btn {dock ? 'primary' : ''}" disabled={busy || !shown.length} onclick={() => decide('approve')}>{$t('repoProposal.approve')}</button>
    <button class="btn" disabled={busy || !shown.length} onclick={() => decide('reject')}>{$t('repoProposal.reject')}</button>
  </div>
{:else}
<div class="flex flex-col gap-2">
  <p class="text-sm">{$t('repoProposal.prompt')}</p>
  {#if rows.length}
    <ul class="flex flex-col gap-1.5" aria-label={$t('repoProposal.list')}>
      {#each rows as r (r.repo)}
        <li class="plate flex flex-col gap-1 px-3 py-2 text-sm min-w-0">
          <div class="flex flex-wrap items-center gap-2 min-w-0">
            <span class="font-mono break-all">{r.repo}</span>
            <Chip tone={proposalTone(r.status)} text={r.status === 'pending' ? $t('repoProposal.status.pending') : r.status === 'approved' ? $t('repoProposal.status.approved') : $t('repoProposal.status.rejected')} extra="sm" />
          </div>
          {#if r.reason}<p class="text-muted break-words">{r.reason}</p>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
{/if}
