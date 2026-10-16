<!-- One daemon session's activity line, shared by the board card and the drawer: the live dot and "working · 4s ago",
     the warn chip "needs permission · 4s ago", or a hollow dot with "waiting" / "idle · 4s ago". Nothing when off.
     The time reads the shared ticker, and this is never inside an aria-live region. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import LiveDot from './LiveDot.svelte';
  import { ticker } from '../lib/clock.svelte.ts';
  import type { Activity, ActivityKind } from '../lib/live.ts';
  import { ago } from '../lib/util.ts';
  import { t } from '../lib/locale.ts';

  let { activity, extra = '' }: { activity: Activity; extra?: string } = $props();
  const stateText = $derived<Record<ActivityKind, string>>({ working: $t('live.working'), asking: $t('live.asking'), waiting: $t('live.waiting'), idle: $t('live.idle'), off: '' });
  const when = $derived(activity.since ? ago(activity.since, ticker.now) : null);
</script>

{#if activity.kind === 'asking'}
  <span class="flex items-center gap-1.5 min-w-0 {extra}"><Chip tone="warn" text={stateText.asking} />{#if when}<span class="normal-case tracking-normal">· {when}</span>{/if}</span>
{:else if activity.kind !== 'off'}
  <span class="flex items-center gap-1.5 min-w-0 {activity.kind === 'working' ? 'text-gleam' : ''} {extra}"><LiveDot on={activity.kind === 'working'} /><span class="truncate">{#if when}{$t('live.line', { state: stateText[activity.kind], ago: when })}{:else}{stateText[activity.kind]}{/if}</span></span>
{/if}
