<!-- A "Needs you" card: the job, why it waits (an escalation park's rules with their details and the file to read for
     each, else the raw reason), who owns the gate (with the foreman on) or that the Foreman left it for a human, what
     Approve does on a secret park (and whether the last one left it blocked), who acted last, the protected paths it
     changes, its doc link, what its buttons do to the PR (a merge gate on an open PR, a held push), a note and the request
     buttons. The title takes the width (grows from 16rem), so the chips drop to the next line before it would wrap word by word. -->
<script lang="ts">
  import JobActions from './JobActions.svelte';
  import GatePrNote from './GatePrNote.svelte';
  import StateChip from './StateChip.svelte';
  import BudgetPanel from './BudgetPanel.svelte';
  import Chip from './Chip.svelte';
  import { protectedSummary, showParkReason } from '../lib/jobs/protected.ts';
  import { gateOwnerBadge, gateReasonRows, handoffNote, inboxDoc, inboxKind, lastActed, secretPark } from '../lib/gates/inbox.ts';
  import { ago } from '../lib/core/util.ts';
  import { ticker } from '../lib/core/clock.svelte.ts';
  import { openDrawer } from '../lib/core/app.svelte.ts';
  import type { StateJob } from '../lib/core/types.ts';
  import { t } from '../lib/text/locale.ts';

  let { job: j }: { job: StateJob } = $props();
  const kind = $derived(inboxKind(j));
  const owner = $derived(gateOwnerBadge(j.gateOwner));
  // An older server sends no foremanHandoff: handoffNote is null and the owner chip stays.
  const note = $derived(handoffNote(j.foremanHandoff));
  const prot = $derived(protectedSummary(j));
  const acted = $derived(lastActed(j));
  const secret = $derived(secretPark(j));
  // An escalation park's rules with their details; null for any other park (or an older server). The protected-paths row
  // leaves its paths to the Protected paths list below, which shows them with their reasons and a diff.
  const reasons = $derived(gateReasonRows(j)?.map((r) => (r.rule === 'protected-paths' && prot ? { ...r, paths: [] } : r)) ?? null);
  // A reason that names a file links it on its own row; any other card keeps its one doc link.
  const doc = $derived(reasons?.some((r) => r.doc) ? null : inboxDoc(kind, j));
</script>

<div class="plate ember p-4 flex flex-col gap-3">
  <div class="flex flex-wrap items-start gap-2"><div class="min-w-0 flex-[1_1_16rem]"><button class="h card text-left break-words hover:text-gleam" onclick={() => openDrawer(j.id)}>{j.title}</button><div class="mono muted text-[11px] truncate" title={j.id}>{j.id}</div></div><div class="flex flex-wrap items-center gap-1.5">{#if note}<Chip tone="you" extra="sm" title={$t('gate.leftForHumanTitle')} text={$t('gate.leftForHuman')} />{:else if owner}<Chip tone={owner.tone} extra="sm" title={owner.foreman ? $t('gate.foremanTitle') : $t('gate.humanTitle')} text={owner.foreman ? $t('gate.foreman') : $t('gate.human')} />{/if}{#if secret?.stillBlocked}<Chip tone="warn" extra="sm" text={$t('inbox.stillBlocked')} />{/if}<StateChip job={j} /></div></div>
  {#if reasons}
    <div class="flex flex-col gap-1.5">
      <div id="gate-reasons-{j.id}" class="label text-[10px]">{$t('inbox.gateReasons')}</div>
      <ul aria-labelledby="gate-reasons-{j.id}" class="flex flex-col gap-0.5">{#each reasons as r, i (i)}<li class="text-[12px] break-words"><span class="mono">{r.rule}</span>{' — '}<span class="muted">{r.detail}</span>{#if r.paths.length}{' · '}<span class="mono muted break-all">{r.paths.join(', ')}</span>{/if}{#if r.doc}{' · '}<button class="text-gleam underline underline-offset-2" onclick={() => r.doc && openDrawer(j.id, r.doc, 'files')}>{$t('inbox.read', { doc: r.doc })}</button>{/if}</li>{/each}</ul>
    </div>
  {/if}
  {#if showParkReason(j)}<div class="muted">{j.reason}</div>{/if}
  <!-- One literal key per class, so the catalog check sees each; Svelte escapes the reason. -->
  {#if note}<div class="muted text-[12px]">{#if note.cls === 'reserved'}{$t('gate.handoff.reserved', { reason: note.reason })}{:else if note.cls === 'escalated'}{$t('gate.handoff.escalated', { reason: note.reason })}{:else}{$t('gate.handoff.refused', { reason: note.reason })}{/if}</div>{/if}
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
  {#if kind === 'budget'}<BudgetPanel job={j} compact />{/if}
  {#if kind === 'repo-budget'}<div class="text-[13px]">{$t('budget.cardPointer')}</div>{/if}
  {#if doc}<button class="text-gleam underline underline-offset-2 text-[13px] self-start" onclick={() => openDrawer(j.id, doc, 'files')}>{$t('inbox.read', { doc })}</button>{/if}
  <GatePrNote job={j} />
  <JobActions job={j} noteId="note-{j.id}" />
</div>
