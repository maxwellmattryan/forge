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
  import AgentActivity from './AgentActivity.svelte';
  import BudgetChip from './BudgetChip.svelte';
  import Chip from './Chip.svelte';
  import MandateBadge from './MandateBadge.svelte';
  import { memberPrs } from '../lib/jobs/repos.ts';
  import { effortChip } from '../lib/jobs/effort.ts';
  import { ago, tokensShort } from '../lib/core/util.ts';
  import { agentsSummary, needsHuman, runningRoles } from '../lib/jobs/state.ts';
  import { cardModel } from '../lib/jobs/board.ts';
  import { S, openDrawer } from '../lib/core/app.svelte.ts';
  import { ticker } from '../lib/core/clock.svelte.ts';
  import { sessionActivity } from '../lib/sessions/live.ts';
  import type { StateJob } from '../lib/core/types.ts';
  import { t } from '../lib/text/locale.ts';

  /** `onopen` replaces opening the job's panel: the issue panel's card opens it with a Back button. */
  let { job: j, onopen }: { job: StateJob; onopen?: () => void } = $props();
  const m = $derived(cardModel(j));
  // An older server sends no activity: the role summary in the footer stands in for the activity line.
  const agents = $derived(j.activity ? null : agentsSummary(runningRoles(j)));
  const agentsLive = $derived(j.activity?.length ? j.activity : null);
  const act = $derived(sessionActivity(S.data?.daemons?.jobs?.[j.id], j.lastEvent?.ts));
  const flashing = $derived((S.flashes[j.id] ?? 0) > ticker.now);
  // A stage change seen after the dashboard settled (app.svelte.ts pollChanges): the edge cools once.
  const cooling = $derived((S.cooling[j.id] ?? 0) > ticker.now);
  const effort = $derived(effortChip(j.effort, S.data?.config?.effort));
  const protTitle = $derived(m.protected ? $t('job.protectedTitle', { reasons: m.protected.reasons.join(' · ') }) : '');
</script>

<button class="plate clickable {needsHuman(j) ? 'ember' : ''} {cooling ? 'cooling' : ''} w-full text-left p-3 pb-2.5 flex flex-col gap-2" onclick={() => (onopen ?? (() => openDrawer(j.id)))()}>
  <span data-slot="title" class="h card line-clamp-2">{j.title}</span>
  <span data-slot="ref" class="mono muted text-[11px] truncate" title={m.refTitle}>{m.ref}</span>
  <div data-slot="state" class="flex flex-wrap items-center gap-1.5"><StateChip job={j} />{#if m.protected}<Chip tone="warn" title={protTitle}><span aria-hidden="true">{$t('job.protected')}</span><span class="sr-only">{protTitle}</span></Chip>{/if}<PrChip pr={j.pr} inButton />{#each memberPrs(j) as mp (mp.repo)}<PrChip pr={mp.pr} repo={mp.repo} inButton />{/each}<BudgetChip job={j} /><EffortChip level={effort} /><MandateBadge mandate={j.mandate} />{#if agentsLive}<div class="basis-full min-w-0"><AgentActivity activity={agentsLive} owner={j.ownerStatus} /></div>{/if}<DepChips job={j} /></div>
  <!-- Wraps: on a narrow card the stage and round drop under the stepper rather than truncating the round away. -->
  <div data-slot="stage" class="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0"><StageStepper steps={m.steps} stage={m.stage} active={m.running} fresh={cooling} /><span class="label text-[10px] truncate min-w-0 max-w-full">{m.stage}{#if m.round}{' · '}{$t('job.round', m.round)}{/if}</span></div>
  {#if m.progress}<div data-slot="progress"><ProgressBar progress={m.progress} /></div>{/if}
  {#if m.lenses}<div data-slot="lenses" class="flex flex-wrap gap-1">{#each m.lenses as l, i (i)}<VerdictChip name={l.name} verdict={l.verdict} />{/each}</div>{/if}
  <!-- One line at every card width: the usage keeps its width at the right, the activity and the agents summary shrink
       and truncate, the agents summary first. -m-1 p-1 gives the live dot's halo (twice the dot) room inside the clip
       without moving the line. -->
  <div data-slot="footer" class="label flex flex-nowrap min-w-0 overflow-hidden -m-1 p-1 items-center gap-x-2.5 text-[10px]">
    <SessionActivity activity={act} extra="normal-case tracking-normal min-w-0 shrink" />
    {#if agents}<span class="flex items-center gap-1.5 text-gleam min-w-0 shrink-[2]" title={agents.title}><span class="dot gleam plain size-1.5 shrink-0"></span><span class="truncate">{#if agents.kind === 'role'}{agents.role}{:else if agents.kind === 'reviewers'}{$t('job.runningReviewers', { count: agents.count })}{:else}{$t('job.runningAgents', { count: agents.count })}{/if}</span></span>{/if}
    <!-- The flash dot's space is always reserved, so a change never shifts the card. -->
    <span class="ml-auto shrink-0 whitespace-nowrap normal-case tracking-normal"><span class="{flashing ? 'dot spark' : 'dot invisible'} size-1.5 mr-1.5 align-middle" aria-hidden="true"></span>{$t('job.usage', { tokens: tokensShort(j.usage?.totalTokens), ago: ago(j.updatedAt, ticker.now) })}</span>
  </div>
</button>
