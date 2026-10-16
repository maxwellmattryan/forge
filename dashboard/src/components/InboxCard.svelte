<!-- A "Needs you" card: the job, why it waits, who owns the gate (with the foreman on), the protected paths it changes,
     its doc link, a note and the request buttons. -->
<script lang="ts">
  import JobActions from './JobActions.svelte';
  import StateChip from './StateChip.svelte';
  import { budgetPanel } from '../lib/budget.ts';
  import { protectedSummary, showParkReason } from '../lib/protected.ts';
  import { gateOwnerBadge, inboxDoc, inboxKind } from '../lib/view.ts';
  import { TONE_CLASS } from '../lib/util.ts';
  import { S, openDrawer } from '../lib/app.svelte.ts';
  import type { StateJob } from '../lib/types.ts';
  import { t } from '../lib/locale.ts';

  let { job: j }: { job: StateJob } = $props();
  const kind = $derived(inboxKind(j));
  const doc = $derived(inboxDoc(kind, j));
  const owner = $derived(gateOwnerBadge(j.gateOwner));
  const prot = $derived(protectedSummary(j));
</script>

<div class="plate ember p-4 flex flex-col gap-3">
  <div class="flex flex-wrap items-start justify-between gap-2"><div class="min-w-0"><button class="h card text-left hover:text-gleam" onclick={() => openDrawer(j.id)}>{j.title}</button><div class="mono muted text-[11px]">{j.id}</div></div><div class="flex flex-wrap items-center gap-1.5">{#if owner}<span class="chip sm {TONE_CLASS[owner.tone]}" title={owner.foreman ? $t('gate.foremanTitle') : $t('gate.humanTitle')}>{owner.foreman ? $t('gate.foreman') : $t('gate.human')}</span>{/if}<StateChip job={j} /></div></div>
  {#if showParkReason(j)}<div class="muted">{j.reason}</div>{/if}
  {#if prot}
    <div class="flex flex-col gap-1.5">
      <div id="protected-{j.id}" class="label text-[10px]">{$t('inbox.protectedPaths')}</div>
      <ul aria-labelledby="protected-{j.id}" class="flex flex-col gap-0.5">{#each prot.rows as r, i (i)}<li class="mono text-[12px] break-words"><span class="break-all">{r.path}</span>{' — '}<span class="muted">{r.reason}</span></li>{/each}</ul>
      {#if prot.more}<div class="muted text-[12px]">{$t('inbox.protectedMore', { count: prot.more })}</div>{/if}
      <button class="btn sm self-start" onclick={() => openDrawer(j.id, 'protected.diff', 'files')}>{$t('inbox.protectedDiff')}</button>
    </div>
  {/if}
  {#if kind === 'budget'}{@html budgetPanel(j, S.data?.config?.pipeline?.budget, { compact: true })}{/if}
  {#if doc}<button class="text-gleam underline underline-offset-2 text-[13px] self-start" onclick={() => openDrawer(j.id, doc, 'files')}>{$t('inbox.read', { doc })}</button>{/if}
  <JobActions job={j} noteId="note-{j.id}" />
</div>
