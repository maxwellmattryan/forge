<!-- A board card. Every card has the same seven slots, in this order: title, ref, state line (state, PR and budget chips,
     then the dependency chips on their own line), stage (stepper plus stage and round), progress, reviewer verdicts and
     the footer. Progress and verdicts are left out when there is nothing to show; every other slot always renders. The
     slots read cardModel, never raw job state, so no card changes shape with its state. -->
<script lang="ts">
  import StateChip from './StateChip.svelte';
  import VerdictChip from './VerdictChip.svelte';
  import PrChip from './PrChip.svelte';
  import ProgressBar from './ProgressBar.svelte';
  import DepChips from './DepChips.svelte';
  import EffortChip from './EffortChip.svelte';
  import StageStepper from './StageStepper.svelte';
  import SessionActivity from './SessionActivity.svelte';
  import { budgetChip } from '../lib/budget.ts';
  import { effortChip } from '../lib/effort.ts';
  import { ago, tokensShort } from '../lib/util.ts';
  import { agentsSummary, cardModel, needsHuman, runningRoles } from '../lib/view.ts';
  import { S, openDrawer } from '../lib/app.svelte.ts';
  import { ticker } from '../lib/clock.svelte.ts';
  import { sessionActivity } from '../lib/live.ts';
  import type { StateJob } from '../lib/types.ts';
  import { t } from '../lib/locale.ts';

  let { job: j }: { job: StateJob } = $props();
  const m = $derived(cardModel(j));
  const agents = $derived(agentsSummary(runningRoles(j)));
  const act = $derived(sessionActivity(S.data?.daemons?.jobs?.[j.id], j.lastEvent?.ts));
  const flashing = $derived((S.flashes[j.id] ?? 0) > ticker.now);
  const effort = $derived(effortChip(j.effort, S.data?.config?.effort));
</script>

<button class="sheet ticks clickable {needsHuman(j) ? 'redline' : ''} w-full text-left p-3 pb-2.5 flex flex-col gap-2" onclick={() => openDrawer(j.id)}>
  <span class="tk"></span>
  <span data-slot="title" class="h card line-clamp-2">{j.title}</span>
  <span data-slot="ref" class="mono muted text-[11px] truncate" title={m.refTitle}>{m.ref}</span>
  <div data-slot="state" class="flex flex-wrap items-center gap-1.5"><StateChip job={j} /><PrChip pr={j.pr} />{@html budgetChip(j, S.data?.config?.pipeline?.budget)}<EffortChip level={effort} /><DepChips job={j} /></div>
  <!-- Wraps: on a narrow card the stage and round drop under the stepper rather than truncating the round away. -->
  <div data-slot="stage" class="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0"><StageStepper steps={m.steps} stage={m.stage} /><span class="label text-[10px] truncate min-w-0 max-w-full">{m.stage}{#if m.round}{' · '}{$t('job.round', m.round)}{/if}</span></div>
  {#if m.progress}<div data-slot="progress"><ProgressBar progress={m.progress} /></div>{/if}
  {#if m.lenses}<div data-slot="lenses" class="flex flex-wrap gap-1">{#each m.lenses as l, i (i)}<VerdictChip name={l.name} verdict={l.verdict} />{/each}</div>{/if}
  <div data-slot="footer" class="label flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px]">
    <SessionActivity activity={act} extra="normal-case tracking-normal max-w-full" />
    {#if agents}<span class="flex items-center gap-1.5 text-ink min-w-0 max-w-full" title={agents.title}><span class="dot ink size-1.5 shrink-0"></span><span class="truncate">{#if agents.kind === 'role'}{agents.role}{:else if agents.kind === 'reviewers'}{$t('job.runningReviewers', { count: agents.count })}{:else}{$t('job.runningAgents', { count: agents.count })}{/if}</span></span>{/if}
    <!-- The flash dot's space is always reserved, so a change never shifts the card. -->
    <span class="ml-auto normal-case tracking-normal"><span class="{flashing ? 'dot hl' : 'dot invisible'} size-1.5 mr-1.5 align-middle" aria-hidden="true"></span>{$t('job.usage', { tokens: tokensShort(j.usage?.totalTokens), ago: ago(j.updatedAt, ticker.now) })}</span>
  </div>
</button>
