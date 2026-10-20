<!-- A gate's note and request buttons, shared by the Needs-you card, the Needs-you park list and the drawer's action dock.
     An issue-link gate adds its link, create and no-issue buttons (IssueLinkActions), which use the note as the reason.
     So does a spec gate whose job has no issue yet (specLinkPending): there each of those buttons also approves the spec,
     and they replace the plain Approve spec. A repo proposal park (RP1) lists the proposals above the note (RepoProposalActions) and,
     below it, Approve repos and Reject repos, which send the note with the decision. -->
<script lang="ts">
  import IssueLinkActions from './IssueLinkActions.svelte';
  import RepoProposalActions from './RepoProposalActions.svelte';
  import { inboxActions, inboxKind, notePlaceholder, showsNote, specLinkPending, type InboxAction } from '../lib/view.ts';
  import { req } from '../lib/app.svelte.ts';
  import type { Job } from '../lib/types.ts';

  let { job: j, noteId }: { job: Pick<Job, 'id' | 'state' | 'waitingOn' | 'reason' | 'issues' | 'noIssue'>; noteId: string } = $props();
  const kind = $derived(inboxKind(j));
  const pending = $derived(specLinkPending(j));
  const placeholder = $derived(notePlaceholder(kind, { linkPending: pending }));
  // Survives polls: the parent is keyed by job id, so the note is only lost when it goes away.
  let note = $state('');
  // The pending repos the proposal list shows: the only ones its Approve and Reject send.
  let proposed = $state<string[]>([]);

  // The note clears as soon as the request goes, and comes back only if it failed and nothing new was typed.
  function send(a: InboxAction): void {
    const text = note;
    const sending = req({ type: a.type, job: j.id, note: showsNote(kind) ? text : null, needsNote: a.needsNote, fixedText: a.text ?? null });
    if (!sending) return;
    note = '';
    sending.then((ok) => {
      if (!ok && note === '') note = text;
    });
  }
</script>

<!-- For an issue link the note is only the "No issue needed" reason, so it follows those buttons. -->
{#if kind === 'issue-link'}<IssueLinkActions id={j.id} refId="{noteId}-ref" bind:note />{:else if pending}<IssueLinkActions id={j.id} refId="{noteId}-ref" bind:note approving />{/if}
{#if kind === 'repo-proposal'}<RepoProposalActions id={j.id} bind:shown={proposed} />{/if}
{#if showsNote(kind)}<textarea id={noteId} rows="2" class="input w-full" {placeholder} aria-label={placeholder} bind:value={note}></textarea>{/if}
{#if kind === 'repo-proposal'}<RepoProposalActions id={j.id} bind:note buttons shown={proposed} />{/if}
<div class="flex flex-wrap gap-2">
  {#each inboxActions(kind, { linkPending: pending }) as a (a.label)}
    <button class="btn {a.primary ? 'primary' : ''}" onclick={() => send(a)}>{a.label}</button>
  {/each}
</div>
