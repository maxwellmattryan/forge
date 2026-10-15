<!-- The daemon bar: a summary of the session pool (pill, inbox, live job sessions, holds, waits, per-job chips), pool
     Start/Stop, every session's pending permission prompts, and the inbox's log inline. Session errors are untrusted text and render as text. -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import PermissionPrompts from './PermissionPrompts.svelte';
  import SessionLog from './SessionLog.svelte';
  import { TONE_CLASS } from '../lib/util.ts';
  import { INBOX_SCOPE } from '../lib/types.ts';
  import type { DaemonPoolState } from '../lib/types.ts';
  import { mergePoolState, poolModel, postDaemon } from '../lib/daemon.ts';
  import { LOG_KEY } from '../lib/daemon-log.ts';
  import { S, forgeToken, openDrawer, refresh } from '../lib/app.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';

  // Follows each new /api/state (assigned only when it changed); POST replies overwrite it in between.
  let pool = $derived<Partial<DaemonPoolState> | null>(S.data?.daemons ?? null);
  let pending = $state(false);
  const model = $derived(poolModel(pool, { pending }));
  const modeName = $derived<Record<string, string>>({ default: $t('session.modes.default'), auto: $t('session.modes.auto'), dontAsk: $t('session.modes.dontAsk') });

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

  async function act(action: 'start' | 'stop'): Promise<void> {
    pending = true;
    try {
      const st = await postDaemon(action, forgeToken());
      pending = false;
      pool = mergePoolState(pool, st);
      refresh();
    } catch (err) {
      pending = false;
      toast($t('daemon.failed', { action, error: err instanceof Error ? err.message : String(err) }), true);
    }
  }
</script>

<!-- No whitespace inside #daemon: the wrapper relies on :empty. -->
<div id="daemon" class="mx-auto max-w-[1400px] px-4 md:px-8 pt-6 empty:hidden">{#if model}<div class="sheet px-3.5 py-2.5">
      <div class="flex flex-wrap items-center gap-2">
        <span class="chip sm {TONE_CLASS[model.pill.tone]}" title={model.pill.title}>{$t('daemon.pill', { label: model.pill.label })}</span>
        <button class="chip sm cursor-pointer {TONE_CLASS[model.inbox.tone]}" title={model.inbox.title} aria-expanded={inboxOpen ? 'true' : 'false'} onclick={toggleInbox}>{$t('daemon.inbox', { label: model.inbox.label })}</button>
        <span class="mono muted num">{$t('daemon.live', { live: model.live, cap: model.cap })}</span>
        {#if model.held.length}<span class="chip sm {TONE_CLASS.warn}" title={model.held.join('\n')}>{$t('daemon.held', { count: model.held.length })}</span>{/if}
        {#if model.waiting.length}<span class="chip sm {TONE_CLASS.warn}" title={model.waiting.join('\n')}>{$t('daemon.waiting', { count: model.waiting.length })}</span>{/if}
        {#if model.kept.length}<span class="chip sm {TONE_CLASS.live}" title={model.kept.join('\n')}>{$t('daemon.kept', { count: model.kept.length })}</span>{/if}
        {#each model.jobs as j (j.id)}<button class="chip sm cursor-pointer max-w-full {TONE_CLASS[j.pill.tone]}" title={[j.id, j.pill.title, ...(j.mode ? [$t('daemon.modeTitle', { mode: modeName[j.mode] })] : [])].join('\n')} onclick={() => openDrawer(j.id, null, 'thread')}><span class="truncate font-mono">{j.label}</span> · {j.pill.label}{#if j.mode} · {modeName[j.mode]}{/if}</button>{/each}
        {#if model.error !== null}<span class="truncate min-w-0 flex-1 text-xs text-muted" title={model.error}>{model.error}</span>{:else}<span class="flex-1"></span>{/if}
        <span class="flex items-center gap-2">
          <button class="btn sm" disabled={!model.canStart} title={model.startHint} aria-label={$t('daemon.startAll')} onclick={() => act('start')}><Icon name="play" />{$t('daemon.start')}</button>
          <button class="btn sm" disabled={!model.canStop} aria-label={$t('daemon.stopAll')} onclick={() => act('stop')}><Icon name="stop" />{$t('daemon.stop')}</button>
        </span>
      </div>
      <div class="mt-2 empty:hidden"><PermissionPrompts /></div>
      {#if inboxOpen}<div class="mt-3 border-t border-line pt-3"><SessionLog scope={INBOX_SCOPE} compact /></div>{/if}
    </div>{/if}</div>
