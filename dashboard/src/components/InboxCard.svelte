<!-- A "Needs you" card: the job, why it waits, its doc link, a note and the request buttons. -->
<script lang="ts">
  import JobActions from './JobActions.svelte';
  import StateChip from './StateChip.svelte';
  import { budgetPanel } from '../lib/budget.ts';
  import { inboxDoc, inboxKind } from '../lib/view.ts';
  import { S, openDrawer } from '../lib/app.svelte.ts';
  import type { StateJob } from '../lib/types.ts';
  import { t } from '../lib/locale.ts';

  let { job: j }: { job: StateJob } = $props();
  const kind = $derived(inboxKind(j));
  const doc = $derived(inboxDoc(kind, j));
</script>

<div class="sheet ticks redline p-4 flex flex-col gap-3">
  <span class="tk"></span>
  <div class="flex flex-wrap items-start justify-between gap-2"><div class="min-w-0"><button class="h card text-left hover:text-ink" onclick={() => openDrawer(j.id)}>{j.title}</button><div class="mono muted text-[11px]">{j.id}</div></div><StateChip job={j} /></div>
  {#if j.reason}<div class="muted">{j.reason}</div>{/if}
  {#if kind === 'budget'}{@html budgetPanel(j, S.data?.config?.pipeline?.budget, { compact: true })}{/if}
  {#if doc}<button class="text-ink underline underline-offset-2 text-[13px] self-start" onclick={() => openDrawer(j.id, doc, 'files')}>{$t('inbox.read', { doc })}</button>{/if}
  <JobActions job={j} noteId="note-{j.id}" />
</div>
