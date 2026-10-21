<!-- A "Needs you" card: the job, why it waits, who acted last, who owns the gate (with the foreman on), what Approve does on a secret park (and whether the last one left it blocked), the protected paths it changes,
     its doc link, a note and the request buttons. The title takes the width (grows from 16rem), so the chips drop to the next line before it would wrap word by word. -->
<script lang="ts">
  import JobActions from './JobActions.svelte';
  import StateChip from './StateChip.svelte';
  import { budgetPanel, unattendedDefault } from '../lib/budget.ts';
  import { protectedSummary, showParkReason } from '../lib/protected.ts';
  import { gateOwnerBadge, inboxDoc, inboxKind, lastActed, secretPark } from '../lib/view.ts';
  import { TONE_CLASS, ago } from '../lib/util.ts';
  import { ticker } from '../lib/clock.svelte.ts';
  import { S, openDrawer } from '../lib/app.svelte.ts';
  import type { StateJob } from '../lib/types.ts';
  import { t } from '../lib/locale.ts';

  let { job: j }: { job: StateJob } = $props();
  const kind = $derived(inboxKind(j));
  const doc = $derived(inboxDoc(kind, j));
  const owner = $derived(gateOwnerBadge(j.gateOwner));
  const prot = $derived(protectedSummary(j));
  const acted = $derived(lastActed(j));
  const secret = $derived(secretPark(j));
</script>

<div class="plate ember p-4 flex flex-col gap-3">
  <div class="flex flex-wrap items-start gap-2"><div class="min-w-0 flex-[1_1_16rem]"><button class="h card text-left break-words hover:text-gleam" onclick={() => openDrawer(j.id)}>{j.title}</button><div class="mono muted text-[11px] truncate" title={j.id}>{j.id}</div></div><div class="flex flex-wrap items-center gap-1.5">{#if owner}<span class="chip sm {TONE_CLASS[owner.tone]}" title={owner.foreman ? $t('gate.foremanTitle') : $t('gate.humanTitle')}>{owner.foreman ? $t('gate.foreman') : $t('gate.human')}</span>{/if}{#if secret?.stillBlocked}<span class="chip sm {TONE_CLASS.warn}">{$t('inbox.stillBlocked')}</span>{/if}<StateChip job={j} /></div></div>
  {#if showParkReason(j)}<div class="muted">{j.reason}</div>{/if}
  {#if secret?.stillBlocked}<div class="muted text-[12px]">{$t('inbox.stillBlockedNote')}</div>{/if}
  {#if secret}<div class="muted text-[12px]">{$t('inbox.secretRescan')}</div>{/if}
  {#if acted}<div class="muted text-[12px]">{$t('inbox.lastActed', { who: acted.foreman ? $t('inbox.foreman') : acted.who, ago: ago(acted.ts, ticker.now) })}</div>{/if}
  {#if prot}
    <div class="flex flex-col gap-1.5">
      <div id="protected-{j.id}" class="label text-[10px]">{$t('inbox.protectedPaths')}</div>
      <ul aria-labelledby="protected-{j.id}" class="flex flex-col gap-0.5">{#each prot.rows as r, i (i)}<li class="mono text-[12px] break-words"><span class="break-all">{r.path}</span>{' — '}<span class="muted">{r.reason}</span></li>{/each}</ul>
      {#if prot.more}<div class="muted text-[12px]">{$t('inbox.protectedMore', { count: prot.more })}</div>{/if}
      <button class="btn sm self-start" onclick={() => openDrawer(j.id, 'protected.diff', 'files')}>{$t('inbox.protectedDiff')}</button>
    </div>
  {/if}
  <!-- A repo hold (kind repo-budget) skips the per-job panel, whose limits aren't what holds it, and points at the section that lifts it. -->
  {#if kind === 'budget'}{@html budgetPanel(j, S.data?.config?.pipeline?.budget, { compact: true, jobDefault: unattendedDefault(S.data?.config) })}{/if}
  {#if kind === 'repo-budget'}<div class="text-[13px]">{$t('budget.cardPointer')}</div>{/if}
  {#if doc}<button class="text-gleam underline underline-offset-2 text-[13px] self-start" onclick={() => openDrawer(j.id, doc, 'files')}>{$t('inbox.read', { doc })}</button>{/if}
  <JobActions job={j} noteId="note-{j.id}" />
</div>
