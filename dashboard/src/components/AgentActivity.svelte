<!-- A job's running agents as `<role> · <model> · running <elapsed> · <last thing>`, newest first, with the owner's
     liveness beside it. On the card: the newest line plus a `+N more` chip. In the drawer header (`expandable`): the newest
     line plus an `N running` disclosure that lists every agent. The last thing is untrusted transcript text and renders
     as text only. Elapsed and ages read the shared ticker. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import LiveDot from './LiveDot.svelte';
  import { activityLine, newestActivity, ownerLiveness, sortedActivity } from '../lib/agent-activity.ts';
  import { ticker } from '../lib/clock.svelte.ts';
  import type { AgentActivity, OwnerStatus } from '../lib/types.ts';
  import { t } from '../lib/locale.ts';

  let { activity, owner = null, expandable = false }: { activity: AgentActivity[]; owner?: OwnerStatus | null; expandable?: boolean } = $props();
  const top = $derived(newestActivity(activity));
  const all = $derived(sortedActivity(activity));
  const live = $derived(ownerLiveness(owner, ticker.now));
  let open = $state(false);
</script>

{#snippet line(a: AgentActivity)}
  {@const p = activityLine(a, ticker.now)}
  <span class="flex min-w-0 items-center gap-1.5"><LiveDot on={true} /><span class="{expandable ? 'truncate' : 'line-clamp-2 break-words'}" title={p.last ?? undefined}><span class="text-gleam">{p.role}</span> · {p.model} · {$t('activity.running', { elapsed: p.elapsed })}{#if p.last}{' · '}<span class="mono text-muted">{p.last}</span>{/if}</span></span>
{/snippet}

<div role="group" class="flex min-w-0 max-w-full flex-col gap-1 text-xs" aria-label={$t('activity.label')}>
  <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
    {#if top.newest}{@render line(top.newest)}{/if}
    {#if top.more > 0 && !expandable}<Chip tone="muted" text={$t('activity.more', { count: top.more })} extra="shrink-0" />{/if}
    {#if top.more > 0 && expandable}<button type="button" class="btn sm shrink-0" aria-expanded={open ? 'true' : 'false'} onclick={(e) => { e.stopPropagation(); open = !open; }}>{$t('activity.runningCount', { count: all.length })}</button>{/if}
    {#if live.tone}<Chip tone={live.tone} text={$t('activity.owner', { status: live.status ?? '', age: live.age ?? '' })} extra="shrink-0" />{/if}
  </div>
  {#if expandable && open && top.more > 0}
    <ul class="flex flex-col gap-1 border-l border-line-soft pl-2">{#each all as a (a.role)}<li class="min-w-0">{@render line(a)}</li>{/each}</ul>
  {/if}
</div>
