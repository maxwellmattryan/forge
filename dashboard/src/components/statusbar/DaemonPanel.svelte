<!-- The Daemon popover's body: the pool pill, live/cap and default permissions, the pool error, pool Start/Stop, holds and
     waits, one chip per job session, and the Inbox log toggle. StatusBar owns the pool state and act(), so the indicator
     and this panel agree. Session errors and titles are untrusted and render as text. -->
<script lang="ts">
  import Icon from '../Icon.svelte';
  import SessionLog from '../SessionLog.svelte';
  import { TONE_CLASS } from '../../lib/util.ts';
  import { INBOX_SCOPE } from '../../lib/types.ts';
  import { START_HINT, type PoolModel } from '../../lib/daemon.ts';
  import { LOG_KEY } from '../../lib/daemon-log.ts';
  import { S, openDrawer } from '../../lib/app.svelte.ts';
  import { closePopover } from '../../lib/popover.svelte.ts';
  import { t } from '../../lib/locale.ts';

  let { model, pending, act }: { model: PoolModel | null; pending: boolean; act: (action: 'start' | 'stop') => void } = $props();

  const modeName = $derived<Record<string, string>>({ default: $t('session.modes.default'), auto: $t('session.modes.auto'), dontAsk: $t('session.modes.dontAsk') });
  // The pool's own mode (daemon.command's), named as the session log's selector names it; another mode shows as written.
  const poolMode = $derived(S.data?.daemons?.permissionMode || 'default');

  const readOpen = (): boolean => {
    try {
      return localStorage.getItem(LOG_KEY) === '1';
    } catch {
      return false;
    }
  };
  let inboxOpen = $state(readOpen());
  function toggleInbox(): void {
    inboxOpen = !inboxOpen;
    try {
      localStorage.setItem(LOG_KEY, inboxOpen ? '1' : '0');
    } catch {}
  }

  function openJob(id: string): void {
    closePopover('navigate');
    openDrawer(id, null, 'log');
  }
</script>

{#if model}
  <div class="flex flex-col gap-3" aria-busy={pending}>
    <div class="flex flex-wrap items-center gap-2">
      <span class="chip sm {TONE_CLASS[model.pill.tone]}" title={model.pill.title}>{$t('daemon.pill', { label: model.pill.label })}</span>
      <span class="mono muted num">{$t('daemon.live', { live: model.live, cap: model.cap })}</span>
      <span class="mono muted">{$t('statusbar.daemon.mode', { mode: modeName[poolMode] ?? poolMode })}</span>
    </div>
    {#if model.error !== null}<p class="text-sm text-bad whitespace-pre-line break-words">{model.error}</p>{/if}
    <div class="flex flex-wrap items-center gap-2">
      <button class="btn sm" disabled={!model.canStart} title={model.startHint} aria-label={$t('daemon.startAll')} onclick={() => act('start')}><Icon name="play" />{$t('daemon.start')}</button>
      <button class="btn sm" disabled={!model.canStop} aria-label={$t('daemon.stopAll')} onclick={() => act('stop')}><Icon name="stop" />{$t('daemon.stop')}</button>
      {#if model.held.length}<span class="chip sm {TONE_CLASS.warn}" title={model.held.join('\n')}>{$t('daemon.held', { count: model.held.length })}</span>{/if}
      {#if model.waiting.length}<span class="chip sm {TONE_CLASS.warn}" title={model.waiting.join('\n')}>{$t('daemon.waiting', { count: model.waiting.length })}</span>{/if}
      {#if model.kept.length}<span class="chip sm {TONE_CLASS.live}" title={model.kept.join('\n')}>{$t('daemon.kept', { count: model.kept.length })}</span>{/if}
    </div>
    {#if model.jobs.length}
      <div class="flex flex-col gap-1.5">
        <h3 class="label">{$t('statusbar.daemon.jobs')}</h3>
        <div class="flex flex-wrap items-center gap-2">
          {#each model.jobs as j (j.id)}<button class="chip sm cursor-pointer max-w-full {TONE_CLASS[j.pill.tone]}" title={[j.id, j.pill.title, ...(j.mode ? [$t('daemon.modeTitle', { mode: modeName[j.mode] })] : [])].join('\n')} onclick={() => openJob(j.id)}><span class="truncate font-mono">{j.label}</span> · {j.pill.label}{#if j.mode} · {modeName[j.mode]}{/if}</button>{/each}
        </div>
      </div>
    {/if}
    <div class="border-t border-line pt-3">
      <button class="btn sm" aria-expanded={inboxOpen ? 'true' : 'false'} onclick={toggleInbox}><Icon name="inbox" />{$t('statusbar.daemon.inboxLog')}</button>
      {#if inboxOpen}<div class="mt-3 border-t border-line pt-3"><SessionLog scope={INBOX_SCOPE} compact /></div>{/if}
    </div>
  </div>
{:else}
  <div class="flex flex-col gap-3">
    <p class="text-sm text-muted">{$t('statusbar.daemon.disabled')}</p>
    <div><button class="btn sm" disabled title={START_HINT} aria-label={$t('daemon.startAll')}><Icon name="play" />{$t('daemon.start')}</button></div>
  </div>
{/if}
