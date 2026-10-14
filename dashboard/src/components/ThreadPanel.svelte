<!-- A job's Thread in the drawer: its request and the requests about it with the session's replies, the gate's actions
     when the job needs a human and its session's permission prompts, then the job's live session log. Request text and results are untrusted and render as
     plain text. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import JobActions from './JobActions.svelte';
  import PermissionPrompts from './PermissionPrompts.svelte';
  import SessionLog from './SessionLog.svelte';
  import { ago } from '../lib/util.ts';
  import { needsHuman } from '../lib/view.ts';
  import { pendingPrompts } from '../lib/permissions.ts';
  import { S } from '../lib/app.svelte.ts';
  import { threadItems, type ThreadAction, type ThreadFrom, type ThreadOpening, type ThreadStatus } from '../lib/thread.ts';
  import type { ForgeRequest, Job } from '../lib/types.ts';
  import { t } from '../lib/locale.ts';

  let { job, requests, opening, active }: { job: Job; requests: ForgeRequest[]; opening: ThreadOpening; active: boolean } = $props();
  const items = $derived(threadItems(requests, opening));
  const actionable = $derived(needsHuman(job) || job.state === 'failed' || job.state === 'blocked');
  const asking = $derived(pendingPrompts(S.data?.daemons ?? null, job.id).length > 0);

  const who = $derived<Record<ThreadFrom, string>>({ you: $t('thread.you'), cli: $t('thread.cli'), forge: $t('thread.forge'), tracker: $t('thread.tracker') });
  const statusText = $derived<Record<ThreadStatus, string>>({ queued: $t('thread.queued'), handling: $t('thread.handling'), done: $t('thread.done'), rejected: $t('thread.rejected') });
  const TONE: Record<ThreadStatus, string> = { queued: 'muted', handling: 'live', done: 'ok', rejected: 'bad' };

  /** What a message asks for, in words: never the raw request type. */
  function actionText(a: ThreadAction): string {
    switch (a.kind) {
      case 'request':
        return $t('thread.action.request');
      case 'imported':
        return $t('thread.action.imported');
      case 'started':
        return $t('thread.action.started');
      case 'handoff':
        return $t('thread.action.handoff');
      case 'resumed':
        return $t('thread.action.resumed');
      case 'link':
        return $t('thread.action.link', { ref: a.ref });
      case 'link-new':
        return $t('thread.action.linkNew');
      case 'link-none':
        return $t('thread.action.linkNone');
      case 'next':
        return $t('thread.action.next', { count: a.n });
      case 'run':
        return $t('thread.action.run', { ref: a.ref });
      default:
        return {
          approve: $t('thread.action.approve'),
          revise: $t('thread.action.revise'),
          rework: $t('thread.action.rework'),
          answer: $t('thread.action.answer'),
          cancel: $t('thread.action.cancel'),
          sync: $t('thread.action.sync'),
          eval: $t('thread.action.eval'),
          retro: $t('thread.action.retro'),
        }[a.verb];
    }
  }
</script>

<div class="flex flex-col gap-5">
  <section class="flex flex-col gap-2" aria-labelledby="thread-conversation-{job.id}">
    <h3 id="thread-conversation-{job.id}" class="label callout">{$t('thread.conversation')}</h3>
    {#if items.length}
      <ol class="flex flex-col gap-2">
        {#each items as m (m.id)}
          <li class="sheet ticks p-3 flex flex-col gap-1.5">
            <span class="tk"></span>
            <div class="caption flex flex-wrap items-center gap-x-2 gap-y-1">
              <span class="font-medium text-fg">{who[m.from]}</span><span class="text-fg">{actionText(m.action)}</span>{#if m.at}<span class="text-muted">{ago(m.at)}</span>{/if}<span class="flex-1"></span>{#if m.status}<Chip tone={TONE[m.status]} text={statusText[m.status]} />{/if}
            </div>
            {#if m.text}<p class="text-sm whitespace-pre-wrap break-words">{m.text}</p>{/if}
            {#if m.result}<div class="border-l border-line-strong pl-2.5 text-sm text-muted whitespace-pre-wrap break-words"><span class="text-xs font-medium text-fg">{who.forge}</span> {m.result}</div>{/if}
          </li>
        {/each}
      </ol>
    {:else}
      <div class="text-sm text-muted">{$t('thread.empty')}</div>
    {/if}
  </section>
  <section class="flex flex-col gap-2" aria-labelledby="thread-composer-{job.id}">
    <h3 id="thread-composer-{job.id}" class="label callout">{$t('thread.composer')}</h3>
    <PermissionPrompts scope={job.id} />
    {#if actionable}
      {#key job.id}<JobActions {job} noteId="thread-note-{job.id}" />{/key}
    {:else if !asking}
      <div class="text-sm text-muted">{$t('thread.nothing')}</div>
    {/if}
  </section>
  <!-- Keyed by job id only, so the drawer's 2 s refresh never re-creates the log or its stream; `active` closes the
       stream as soon as the drawer closes, though its last view stays while it slides out. -->
  {#key job.id}<SessionLog scope={job.id} {active} />{/key}
</div>
