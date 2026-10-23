<!-- The Thread's live line, pinned under the conversation: the newest running agent as `<role> · running <elapsed> · <last
     thing>` (with `+N more`), else the session's state and age, and the job's cost so far. It is one button that opens the
     Log, where the detail is. Nothing shows while no agent runs and the session is off. It reads the 2 s /api/state poll,
     so it opens no stream of its own. The last thing is untrusted transcript text and renders as text only. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import LiveDot from './LiveDot.svelte';
  import { activityLine, newestActivity } from '../lib/agent-activity.ts';
  import { ticker } from '../lib/clock.svelte.ts';
  import type { Activity } from '../lib/live.ts';
  import type { AgentActivity } from '../lib/types.ts';
  import { ago, usd } from '../lib/util.ts';
  import { t } from '../lib/locale.ts';

  let { agents, session, cost, onopen }: { agents: AgentActivity[]; session: Activity | null; cost: number | null | undefined; onopen: () => void } = $props();
  const top = $derived(newestActivity(agents));
  const line = $derived(top.newest ? activityLine(top.newest, ticker.now) : null);
  const stateName = $derived<Record<Activity['kind'], string>>({ working: $t('live.working'), asking: $t('live.asking'), waiting: $t('live.waiting'), idle: $t('live.idle'), off: '' });
  const shown = $derived(line !== null || (session !== null && session.kind !== 'off'));
</script>

{#if shown}
  <button type="button" title={$t('thread.live.label')} class="chrome shrink-0 flex w-full min-w-0 items-center gap-2 border-t border-line px-5 md:px-6 py-2 text-left text-xs hover:text-fg focus-visible:-outline-offset-2" onclick={onopen}>
    {#if line}
      <LiveDot on={true} />
      <span class="min-w-0 flex-1 truncate" title={line.last ?? undefined}><span class="text-gleam">{line.role}</span> · {$t('activity.running', { elapsed: line.elapsed })}{#if line.last}{' · '}<span class="mono text-muted">{line.last}</span>{/if}</span>
      {#if top.more > 0}<Chip tone="muted" text={$t('activity.more', { count: top.more })} extra="shrink-0" />{/if}
    {:else if session}
      <LiveDot on={session.kind === 'working'} />
      <span class="min-w-0 flex-1 truncate">{session.since ? $t('thread.live.session', { state: stateName[session.kind], ago: ago(session.since, ticker.now) }) : $t('thread.live.sessionNow', { state: stateName[session.kind] })}</span>
    {/if}
    {#if cost}<span class="shrink-0 num text-muted">{usd(cost)}</span>{/if}
    <span class="shrink-0 text-gleam">{$t('thread.live.open')}</span>
  </button>
{/if}
