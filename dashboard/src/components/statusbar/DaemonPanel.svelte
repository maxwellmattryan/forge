<!-- The Daemon popover's body: the pool pill, live/cap and default permissions, the pool error, pool Start/Stop, then one row
     per session: the Inbox, the Foreman (while foreman is on), then each job session in status order. A job row opens
     that job's pane on the Log tab. The rows say held and waiting themselves, so no chips repeat them; the Inbox log lives
     in the Inbox popover. StatusBar owns the pool state and act(), so the indicator and this panel agree. Session errors
     and job titles are untrusted and render as text. -->
<script lang="ts">
  import Icon from '../Icon.svelte';
  import { TONE_CLASS } from '../../lib/util.ts';
  import { START_HINT, daemonRows, type Pill, type PoolModel } from '../../lib/daemon.ts';
  import { S, openDrawer } from '../../lib/app.svelte.ts';
  import { closePopover } from '../../lib/popover.svelte.ts';
  import { t } from '../../lib/locale.ts';

  let { model, pending, act }: { model: PoolModel | null; pending: boolean; act: (action: 'start' | 'stop') => void } = $props();

  const modeName = $derived<Record<string, string>>({ default: $t('session.modes.default'), auto: $t('session.modes.auto'), dontAsk: $t('session.modes.dontAsk') });
  // The pool's own mode (daemon.command's), named as the session log's selector names it; another mode shows as written.
  const poolMode = $derived(S.data?.daemons?.permissionMode || 'default');
  /** A mode's name, own keys only, so a mode from the server never reads Object.prototype. */
  const named = (mode: string): string => (Object.hasOwn(modeName, mode) ? modeName[mode] : mode);
  const rows = $derived(model ? daemonRows(model, S.data?.jobs ?? []) : []);

  function openJob(id: string): void {
    closePopover('navigate');
    openDrawer(id, null, 'log');
  }
</script>

{#snippet pill(p: Pill)}<span class="chip sm shrink-0 {TONE_CLASS[p.tone]}" title={p.title}>{p.label}</span>{/snippet}

{#if model}
  <div class="flex flex-col gap-3" aria-busy={pending}>
    <!-- gap-x-3 keeps the two facts apart without a separator that a wrap would leave dangling. -->
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span class="chip sm {TONE_CLASS[model.pill.tone]}" title={model.pill.title}>{$t('daemon.pill', { label: model.pill.label })}</span>
      <span class="mono muted num">{$t('daemon.live', { live: model.live, cap: model.cap })}</span>
      <span class="mono muted">{$t('statusbar.daemon.mode', { mode: named(poolMode) })}</span>
    </div>
    {#if model.error !== null}<p class="text-sm text-bad whitespace-pre-line break-words">{model.error}</p>{/if}
    <div class="flex flex-wrap items-center gap-2">
      <button class="btn sm" disabled={!model.canStart} title={model.startHint} aria-label={$t('daemon.startAll')} onclick={() => act('start')}><Icon name="play" />{$t('daemon.start')}</button>
      <button class="btn sm" disabled={!model.canStop} aria-label={$t('daemon.stopAll')} onclick={() => act('stop')}><Icon name="stop" />{$t('daemon.stop')}</button>
    </div>
    <ul class="flex flex-col gap-1 border-t border-line pt-3" aria-label={$t('daemon.rows.label')}>
      {#each rows as r (r.kind === 'job' ? `job:${r.id}` : r.kind)}
        <li>
          {#if r.kind === 'job'}
            <button class="plain clickable flex w-full min-w-0 items-center gap-3 border border-line-soft px-2 py-1.5 text-left" title={[r.id, r.pill.title, ...(r.mode ? [$t('daemon.modeTitle', { mode: named(r.mode) })] : [])].join('\n')} onclick={() => openJob(r.id)}>
              <span class="flex min-w-0 flex-1 flex-col"><span class="truncate text-sm">{r.title ?? r.id}</span><span class="mono muted truncate">{r.id}{#if r.mode} · {named(r.mode)}{/if}</span></span>
              {@render pill(r.pill)}
            </button>
          {:else}
            <div class="plain flex min-w-0 items-center gap-3 border border-transparent px-2 py-1.5">
              <span class="flex min-w-0 flex-1 flex-col">
                <span class="flex items-center gap-2 text-sm">{r.kind === 'inbox' ? $t('daemon.rows.inbox') : $t('daemon.rows.foreman')}{#if r.kind === 'foreman'}<span class="chip live">{$t('daemon.rows.foremanTag')}</span>{/if}</span>
                <span class="caption muted">{r.kind === 'inbox' ? $t('daemon.rows.inboxAbout') : $t('daemon.rows.foremanAbout')}</span>
              </span>
              {@render pill(r.pill)}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{:else}
  <div class="flex flex-col gap-3">
    <p class="text-sm text-muted">{$t('statusbar.daemon.disabled')}</p>
    <div><button class="btn sm" disabled title={START_HINT} aria-label={$t('daemon.startAll')}><Icon name="play" />{$t('daemon.start')}</button></div>
  </div>
{/if}
