<!-- A job's Thread in the drawer: its requests and the session's replies, the gate's actions when the job needs a
     human, then the job's live session log. Request text and results are untrusted and render as plain text. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import JobActions from './JobActions.svelte';
  import SessionLog from './SessionLog.svelte';
  import { ago } from '../lib/util.ts';
  import { needsHuman } from '../lib/view.ts';
  import { threadItems, type ThreadFrom, type ThreadStatus } from '../lib/thread.ts';
  import type { ForgeRequest, Job } from '../lib/types.ts';
  import { t } from '../lib/locale.ts';

  let { job, requests, active }: { job: Job; requests: ForgeRequest[]; active: boolean } = $props();
  const items = $derived(threadItems(requests));
  const actionable = $derived(needsHuman(job) || job.state === 'failed' || job.state === 'blocked');

  const who = $derived<Record<ThreadFrom, string>>({ you: $t('thread.you'), cli: $t('thread.cli'), forge: $t('thread.forge') });
  const statusText = $derived<Record<ThreadStatus, string>>({ queued: $t('thread.queued'), handling: $t('thread.handling'), done: $t('thread.done'), rejected: $t('thread.rejected') });
  const TONE: Record<ThreadStatus, string> = { queued: 'muted', handling: 'accent', done: 'ok', rejected: 'bad' };
</script>

<div class="flex flex-col gap-5">
  <section class="flex flex-col gap-2" aria-label={$t('thread.conversation')}>
    {#if items.length}
      <ol class="flex flex-col gap-2">
        {#each items as m (m.id)}
          <li class="card p-3 flex flex-col gap-1.5">
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <span class="font-medium text-fg">{who[m.from]}</span><span class="font-mono text-muted">{m.type}</span><span class="text-muted">{ago(m.at)}</span><span class="flex-1"></span><Chip tone={TONE[m.status]} text={statusText[m.status]} />
            </div>
            {#if m.text}<p class="text-sm whitespace-pre-wrap break-words">{m.text}</p>{/if}
            {#if m.result}<div class="border-l-2 border-accent/50 pl-2.5 text-sm text-muted whitespace-pre-wrap break-words"><span class="text-xs font-medium text-fg">{who.forge}</span> {m.result}</div>{/if}
          </li>
        {/each}
      </ol>
    {:else}
      <div class="text-sm text-muted">{$t('thread.empty')}</div>
    {/if}
  </section>
  <section class="flex flex-col gap-2" aria-label={$t('thread.composer')}>
    {#if actionable}
      {#key job.id}<JobActions {job} noteId="thread-note-{job.id}" />{/key}
    {:else}
      <div class="text-sm text-muted">{$t('thread.nothing')}</div>
    {/if}
  </section>
  <!-- Keyed by job id only, so the drawer's 2 s refresh never re-creates the log or its stream; `active` closes the
       stream as soon as the drawer closes, though its last view stays while it slides out. -->
  {#key job.id}<SessionLog scope={job.id} {active} />{/key}
</div>
