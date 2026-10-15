<!-- A gate's note and request buttons, shared by the Needs-you card, the Inbox park table and the drawer's action dock.
     An issue-link gate adds its link, create and no-issue buttons (IssueLinkActions), which use the note as the reason.
     So does a spec gate whose job has no issue yet (specLinkPending): there each of those buttons also approves the spec,
     and they replace the plain Approve spec. -->
<script lang="ts">
  import IssueLinkActions from './IssueLinkActions.svelte';
  import { inboxActions, inboxKind, notePlaceholder, showsNote, specLinkPending } from '../lib/view.ts';
  import { req } from '../lib/app.svelte.ts';
  import type { Job } from '../lib/types.ts';

  let { job: j, noteId }: { job: Pick<Job, 'id' | 'state' | 'waitingOn' | 'reason' | 'source' | 'noIssue'>; noteId: string } = $props();
  const kind = $derived(inboxKind(j));
  const pending = $derived(specLinkPending(j));
  const placeholder = $derived(notePlaceholder(kind, { linkPending: pending }));
  // Survives polls: the parent is keyed by job id, so the note is only lost when it goes away.
  let note = $state('');
</script>

<!-- For an issue link the note is only the "No issue needed" reason, so it follows those buttons. -->
{#if kind === 'issue-link'}<IssueLinkActions id={j.id} refId="{noteId}-ref" {note} />{:else if pending}<IssueLinkActions id={j.id} refId="{noteId}-ref" {note} approving />{/if}
{#if showsNote(kind)}<textarea id={noteId} rows="2" class="input w-full" {placeholder} aria-label={placeholder} bind:value={note}></textarea>{/if}
<div class="flex flex-wrap gap-2">
  {#each inboxActions(kind, { linkPending: pending }) as a (a.label)}
    <button class="btn {a.primary ? 'primary' : ''}" onclick={() => req({ type: a.type, job: j.id, note: showsNote(kind) ? note : null, needsNote: a.needsNote, fixedText: a.text ?? null })}>{a.label}</button>
  {/each}
</div>
