<!-- A gate's note and request buttons, shared by the Needs-you card, the Needs-you park list and the drawer's action dock.
     An issue-link gate adds its link, create and no-issue buttons (IssueLinkActions), which use the note as the reason.
     So does a spec gate whose job has no issue yet (specLinkPending): there each of those buttons also approves the spec,
     and they replace the plain Approve spec. A repo proposal park (RP1) lists the proposals above the note (RepoProposalActions) and,
     below it, Approve repos and Reject repos, which send the note with the decision.
     Once a decision is sent (from here, or by another tab, the CLI or a session; a resume only counts on a gate whose
     buttons send one), the controls give way to its status line until the request
     leaves the queue (decision.ts): a job session, not the click, moves the gate, and that takes a while. They are
     hidden, not unmounted, so a failed send brings them back with what was typed. -->
<script lang="ts">
  import IssueLinkActions from './IssueLinkActions.svelte';
  import RepoProposalActions from './RepoProposalActions.svelte';
  import LiveDot from './LiveDot.svelte';
  import { decisionInFlight } from '../lib/decision.ts';
  import { inboxActions, inboxKind, notePlaceholder, showsNote, specLinkPending, type InboxAction } from '../lib/inbox.ts';
  import { budgetApprove, type BudgetApproveOutcome } from '../lib/budget.ts';
  import { S, req } from '../lib/app.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';
  import { ago } from '../lib/util.ts';
  import type { Job } from '../lib/types.ts';

  let { job: j, noteId }: { job: Pick<Job, 'id' | 'state' | 'waitingOn' | 'reason' | 'issues' | 'noIssue'>; noteId: string } = $props();
  const kind = $derived(inboxKind(j));
  const pending = $derived(specLinkPending(j));
  const placeholder = $derived(notePlaceholder(kind, { linkPending: pending }));
  // Survives polls: the parent is keyed by job id, so the note is only lost when it goes away.
  let note = $state('');
  // The pending repos the proposal list shows: the only ones its Approve and Reject send.
  let proposed = $state<string[]>([]);
  // While the budget route is in flight: the buttons look disabled and send drops a second click, so it can't queue
  // a second approve. They use aria-disabled, not disabled: disabling the pressed button drops focus to the page, and a
  // keyboard user who then gets the failure toast would have to tab back from the top to fix the note and retry.
  let busy = $state(false);
  const flight = $derived(decisionInFlight(j,S.sent[j.id], S.data?.requests));
  const manual = $derived(S.data?.config.daemon.enabled === false);
  let controls = $state<HTMLDivElement>();
  let status = $state<HTMLParagraphElement>();
  // The pressed button is hidden with the rest: focus moves to the status line, not the page.
  $effect(() => {
    if (flight && controls?.contains(document.activeElement)) status?.focus();
  });

  // The note clears as soon as the request goes (unless something new was typed meanwhile), and comes back only
  // if it failed and nothing new was typed. Approve on a budget gate first raises or acknowledges the budget
  // (budgetApprove); when that fails or a key is still over, nothing is queued and the note stays.
  async function send(a: InboxAction): Promise<void> {
    if (busy) return;
    const text = note;
    if (kind === 'budget' && a.type === 'approve') {
      busy = true;
      let r: BudgetApproveOutcome;
      try {
        r = await budgetApprove(j.id, text, {
          stillOver: (keys) => $t('inbox.budgetStillOver', { keys }),
          failed: (error) => $t('inbox.budgetFailed', { error }),
        });
      } finally {
        busy = false;
      }
      if ('toast' in r) return toast(r.toast, true);
    }
    const sending = req({ type: a.type, job: j.id, note: showsNote(kind) ? text : null, needsNote: a.needsNote, fixedText: a.text ?? null }, a.label);
    if (!sending) return;
    if (note === text) note = '';
    sending.then((ok) => {
      if (!ok && note === '') note = text;
    });
  }
</script>

<p bind:this={status} tabindex="-1" role="status" class="{flight ? 'flex' : 'hidden'} items-center gap-2 text-sm outline-none">
  {#if flight}
    {@const label = flight.label ?? $t('inbox.decision.elsewhere', { type: flight.type ?? '', from: flight.from ?? '', age: ago(flight.at) })}
    <LiveDot on /><span class="min-w-0 wrap-anywhere">{#if flight.phase === 'sending'}{$t('inbox.decision.sending', { label })}{:else if flight.phase === 'applying'}{$t('inbox.decision.applying', { label })}{:else if manual}{$t('inbox.decision.queuedManual', { label })}{:else}{$t('inbox.decision.queued', { label })}{/if}</span>
  {/if}
</p>
<div bind:this={controls} class={flight ? 'hidden' : 'contents'}>
<!-- For an issue link the note is only the "No issue needed" reason, so it follows those buttons. -->
{#if kind === 'issue-link'}<IssueLinkActions id={j.id} refId="{noteId}-ref" bind:note />{:else if pending}<IssueLinkActions id={j.id} refId="{noteId}-ref" bind:note approving />{/if}
{#if kind === 'repo-proposal'}<RepoProposalActions id={j.id} bind:shown={proposed} />{/if}
{#if showsNote(kind)}<textarea id={noteId} rows="2" class="input w-full" {placeholder} aria-label={placeholder} bind:value={note}></textarea>{/if}
{#if kind === 'repo-proposal'}<RepoProposalActions id={j.id} bind:note buttons shown={proposed} />{/if}
<div class="flex flex-wrap gap-2" aria-busy={busy}>
  {#each inboxActions(kind, { linkPending: pending }) as a (a.label)}
    <button class="btn {a.primary ? 'primary' : ''} {busy ? 'disabled' : ''}" aria-disabled={busy} onclick={() => send(a)}>{a.label}</button>
  {/each}
</div>
</div>
