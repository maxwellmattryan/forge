<!-- A gate's note and request buttons, shared by the Needs-you card and the drawer's Thread. An issue-link gate adds its
     link, create and no-issue buttons (IssueLinkActions), which use the note as the reason. -->
<script lang="ts">
  import IssueLinkActions from './IssueLinkActions.svelte';
  import { inboxActions, inboxKind, notePlaceholder, showsNote } from '../lib/view.ts';
  import { req } from '../lib/app.svelte.ts';
  import type { Job } from '../lib/types.ts';

  let { job: j, noteId }: { job: Pick<Job, 'id' | 'state' | 'waitingOn'>; noteId: string } = $props();
  const kind = $derived(inboxKind(j));
  // Survives polls: the parent is keyed by job id, so the note is only lost when it goes away.
  let note = $state('');
</script>

{#if showsNote(kind)}<textarea id={noteId} rows="2" class="w-full" placeholder={notePlaceholder(kind)} aria-label={notePlaceholder(kind)} bind:value={note}></textarea>{/if}
{#if kind === 'issue-link'}<IssueLinkActions id={j.id} {note} />{/if}
<div class="flex flex-wrap gap-2">
  {#each inboxActions(kind) as a (a.label)}
    <button class="btn {a.primary ? 'btn-primary' : ''}" onclick={() => req({ type: a.type, job: j.id, note: showsNote(kind) ? note : null, needsNote: a.needsNote, fixedText: a.text ?? null })}>{a.label}</button>
  {/each}
</div>
