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

<div class="card p-4 flex flex-col gap-3 border-warn/40">
  <div class="flex flex-wrap items-start justify-between gap-2"><div><button class="font-medium hover:text-accent text-left" onclick={() => openDrawer(j.id)}>{j.title}</button><div class="text-[11px] text-muted font-mono">{j.id}</div></div><StateChip job={j} /></div>
  {#if j.reason}<div class="text-sm text-muted">{j.reason}</div>{/if}
  {#if kind === 'budget'}{@html budgetPanel(j, S.data?.config?.pipeline?.budget, { compact: true })}{/if}
  {#if doc}<button class="text-sm text-accent self-start" onclick={() => openDrawer(j.id, doc)}>{$t('inbox.read', { doc })}</button>{/if}
  <JobActions job={j} noteId="note-{j.id}" />
</div>
