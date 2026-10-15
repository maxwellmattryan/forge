<!-- The status bar: one fixed row at the bottom of every view. Left, the daemon, the inbox and (md and up) holds and waits;
     centre, the "New job or command" input (a button below md); right, the model and the connection. Each indicator opens
     one popover, a sibling after the bar: a fixed element with a z-index is its own stacking context, so a popover inside
     the bar could never rise above the drawer.
     Stacking, from the back: sidebar z-10, drawer backdrop z-30, this bar z-35, drawer z-40, popovers z-42, Settings and
     the palette z-45, toast z-50. At md and up the bar spans the content column only, so the sidebar keeps its full
     height and its title block, and the drawer ends at the bar's top edge. Session errors, titles and model strings are
     untrusted and render as text. -->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import LiveDot from './LiveDot.svelte';
  import Popover from './Popover.svelte';
  import ConnectionPanel from './statusbar/ConnectionPanel.svelte';
  import DaemonPanel from './statusbar/DaemonPanel.svelte';
  import InboxPanel from './statusbar/InboxPanel.svelte';
  import ModelPanel from './statusbar/ModelPanel.svelte';
  import { API_VERSION } from '../lib/types.ts';
  import type { DaemonPoolState } from '../lib/types.ts';
  import { mergePoolState, poolModel, postDaemon } from '../lib/daemon.ts';
  import { barModel, connectionState, modelSummary, promptAnnouncement } from '../lib/statusbar.ts';
  import { S, forgeToken, refresh } from '../lib/app.svelte.ts';
  import { closePopover, focusInPopover, openPopover, popover } from '../lib/popover.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';

  // Follows each new /api/state (assigned only when it changed); POST replies overwrite it in between.
  let pool = $derived<Partial<DaemonPoolState> | null>(S.data?.daemons ?? null);
  let pending = $state(false);
  const model = $derived(poolModel(pool, { pending }));
  const bar = $derived(barModel(pool, { pending }));
  const models = $derived(modelSummary(S.data?.config?.models));
  const conn = $derived(connectionState({ online: S.online, apiVersion: S.data?.apiVersion, clientApi: API_VERSION }));

  /** Tone → text colour, whole literals so Tailwind sees them. */
  const TONE_TEXT: Record<string, string> = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', info: 'text-info', ink: 'text-ink', live: 'text-ink', muted: 'text-muted' };
  /** Connection's static dot: only LiveDot pulses. */
  const CONN_DOT: Record<string, string> = { muted: 'dot hollow', ok: 'dot ok', warn: 'dot bg-warn', bad: 'dot bg-bad' };

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

  // The live region speaks only when the pool-wide prompt count rises; it is emptied first, so the same count can speak again.
  let lastPrompts = 0;
  let announcement = $state('');
  $effect(() => {
    const next = bar.prompts;
    const say = promptAnnouncement(lastPrompts, next);
    lastPrompts = next;
    if (say === null) return;
    const text = $t('permission.heading', { count: say });
    announcement = '';
    tick().then(() => (announcement = text));
  });

  // A job's drawer opened by any route closes the popover; focus goes back to the indicator only if it was inside.
  let lastDrawer: string | null = untrack(() => S.drawer.id);
  $effect(() => {
    const id = S.drawer.id;
    if (id !== null && id !== lastDrawer) untrack(() => closePopover(focusInPopover() ? 'navigate' : 'external'));
    lastDrawer = id;
  });

  // An indicator that stops rendering (the daemon disabled under the Inbox popover, a hold that cleared) takes its popover.
  $effect(() => {
    void bar;
    void S.data;
    untrack(() => {
      if (popover.open !== null && popover.anchor && !popover.anchor.isConnected) closePopover('gone');
    });
  });

  const expanded = (id: 'daemon' | 'inbox' | 'model' | 'connection'): boolean => popover.open === id;
  const controls = (id: 'daemon' | 'inbox' | 'model' | 'connection'): string | undefined => (popover.open === id ? `popover-${id}` : undefined);
</script>

<footer
  id="statusbar"
  aria-label={$t('statusbar.label')}
  class="fixed bottom-0 right-0 left-0 md:left-(--size-sidebar) z-35 chrome border-t border-line-strong h-[calc(var(--size-statusbar)_+_env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)] flex items-center gap-1 px-1 md:grid md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-2 md:px-3"
>
  <div class="flex min-w-0 shrink-0 items-center gap-0.5 overflow-x-clip md:gap-1 md:px-1">
    {#if S.data}
      <button class="btn sm ghost min-w-0 max-md:min-w-11 max-md:justify-center" aria-haspopup="dialog" aria-expanded={expanded('daemon')} aria-controls={controls('daemon')} onclick={(e) => openPopover('daemon', e.currentTarget)}>
        <span class="inline-flex md:hidden"><Icon name="daemon" /></span>
        <LiveDot on={bar.daemon.active} />
        {#if bar.daemon.off}
          <span class="truncate text-muted max-md:sr-only">{$t('statusbar.daemon.off')}</span>
        {:else}
          <span class="truncate max-md:sr-only {TONE_TEXT[bar.daemon.pill.tone]}"><span class="max-xl:sr-only">{$t('statusbar.daemon.title')}{' '}</span>{bar.daemon.pill.label}</span>
          <span class="num shrink-0 max-md:sr-only">{bar.daemon.live}/{bar.daemon.cap}<span class="sr-only">{' '}{$t('statusbar.daemon.sessions')}</span></span>
        {/if}
      </button>
      {#if bar.inbox}
        <button class="btn sm ghost min-w-0 max-md:min-w-11 max-md:justify-center" aria-haspopup="dialog" aria-expanded={expanded('inbox')} aria-controls={controls('inbox')} onclick={(e) => openPopover('inbox', e.currentTarget)}>
          <span class="inline-flex {TONE_TEXT[bar.inbox.tone]}"><Icon name="inbox" /></span>
          <span class="truncate max-md:sr-only {TONE_TEXT[bar.inbox.tone]}"><span class="max-xl:sr-only">{$t('statusbar.inbox.name')}{' '}</span>{bar.inbox.label}</span>
          {#if bar.prompts}<span class="num shrink-0 text-warn"><span class="md:hidden" aria-hidden="true">{bar.prompts}</span><span class="max-md:sr-only">{$t('statusbar.inbox.prompts', { count: bar.prompts })}</span></span>{/if}
        </button>
      {/if}
      {#if bar.held}
        <button class="btn sm ghost min-w-0 max-md:hidden" aria-haspopup="dialog" aria-expanded={expanded('daemon')} aria-controls={controls('daemon')} onclick={(e) => openPopover('daemon', e.currentTarget)}><span class="truncate text-warn">{$t('daemon.held', { count: bar.held })}</span></button>
      {/if}
      {#if bar.waiting}
        <button class="btn sm ghost min-w-0 max-md:hidden" aria-haspopup="dialog" aria-expanded={expanded('daemon')} aria-controls={controls('daemon')} onclick={(e) => openPopover('daemon', e.currentTarget)}><span class="truncate text-warn">{$t('daemon.waiting', { count: bar.waiting })}</span></button>
      {/if}
    {/if}
  </div>

  <div class="flex min-w-0 flex-1 items-center justify-center md:flex-none"></div>

  <div class="flex min-w-0 shrink-0 items-center justify-end gap-0.5 overflow-x-clip md:gap-1 md:px-1">
    {#if S.data}
      <button class="btn sm ghost min-w-0 max-md:min-w-11 max-md:justify-center" aria-haspopup="dialog" aria-expanded={expanded('model')} aria-controls={controls('model')} onclick={(e) => openPopover('model', e.currentTarget)}>
        <Icon name="agents" />
        <span class="sr-only">{$t('statusbar.model.name')}{' '}</span>
        <span class="truncate max-md:sr-only">{#if models.provider}<span class="max-xl:sr-only">{models.provider}{' · '}</span>{/if}{models.label ?? $t('statusbar.model.session')}{#if models.effort}<span class="max-xl:sr-only">{' · '}{$t('statusbar.model.effort', { effort: models.effort })}</span>{/if}</span>
      </button>
    {/if}
    <button class="btn sm ghost min-w-0 max-md:min-w-11 max-md:justify-center" aria-haspopup="dialog" aria-expanded={expanded('connection')} aria-controls={controls('connection')} onclick={(e) => openPopover('connection', e.currentTarget)}>
      <span class={CONN_DOT[conn.tone]} aria-hidden="true"></span>
      <span class="sr-only">{$t('statusbar.conn.title')}{' '}</span>
      <span class="truncate max-md:sr-only {TONE_TEXT[conn.tone]}">{#if conn.state === 'connecting'}{$t('statusbar.conn.connecting')}{:else if conn.state === 'offline'}{$t('statusbar.conn.offline')}{:else if conn.state === 'outdated'}{$t('statusbar.conn.outdated')}{:else}{$t('statusbar.conn.live')}{/if}</span>
    </button>
  </div>

  <div class="sr-only" aria-live="polite">{announcement}</div>
</footer>

{#if popover.open !== null && popover.anchor}
  {@const open = popover.open}
  {#key open}
    <Popover
      id={open}
      title={open === 'daemon' ? $t('statusbar.daemon.title') : open === 'inbox' ? $t('statusbar.inbox.title') : open === 'model' ? $t('statusbar.model.title') : $t('statusbar.conn.title')}
      anchor={popover.anchor}
      align={open === 'model' || open === 'connection' ? 'end' : 'start'}
      wide={open === 'daemon' || open === 'inbox'}
    >
      {#if open === 'daemon'}<DaemonPanel {model} {pending} {act} />
      {:else if open === 'inbox'}{#if model}<InboxPanel inbox={model.inbox} />{/if}
      {:else if open === 'model'}<ModelPanel />
      {:else}<ConnectionPanel status={conn.state} />{/if}
    </Popover>
  {/key}
{/if}
