<!-- The status bar: one fixed row at the bottom of every view. Left, the daemon, the inbox and (md and up) holds and waits;
     centre, the "New job or command" input (a button below md); right, the model and the connection. Each indicator opens
     one popover, a sibling after the bar: a fixed element with a z-index is its own stacking context, so a popover inside
     the bar could never rise above the drawer.
     Stacking, from the back: sidebar z-10, drawer backdrop z-30, this bar z-35, drawer z-40, popovers z-42, Settings and
     the palette z-45, toast z-50. At md and up the bar spans the content column only, so the sidebar keeps its full
     height and its title block, and the drawer ends at the bar's top edge. Session errors, titles and model strings are
     untrusted and render as text.
     Each cluster holds its indicators in a max-content row. When the row is wider than the cluster, the next level of text
     goes sr-only (see fit()), so a visible label is always whole, never cut to an ellipsis. Below md every indicator is a
     glyph or a dot. -->
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
  import { barModel, connectionState, inlineInputAction, modelSummary, promptAnnouncement, summaryText, type InlineInputEvent } from '../lib/statusbar.ts';
  import { shortcutLabel } from '../lib/command.ts';
  import { S, forgeToken, refresh } from '../lib/app.svelte.ts';
  import { closePopover, focusInPopover, keepFocus, openPopover, popover, reanchor } from '../lib/popover.svelte.ts';
  import type { PopoverId } from '../lib/popover.ts';
  import { openPalette } from '../lib/palette.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';

  // Follows each new /api/state (assigned only when it changed); POST replies overwrite it in between.
  let pool = $derived<Partial<DaemonPoolState> | null>(S.data?.daemons ?? null);
  let pending = $state(false);
  const model = $derived(poolModel(pool, { pending }));
  const bar = $derived(barModel(pool, { pending }));
  const models = $derived(modelSummary(S.data?.config?.models));
  const conn = $derived(connectionState({ online: S.online, apiVersion: S.data?.apiVersion, clientApi: API_VERSION }));
  const shortcut = shortcutLabel(typeof navigator === 'undefined' ? '' : navigator.platform);

  /**
   * How much text each part hides, lowest value first. Left: 1 the "Daemon" and "Inbox" words, 2 the reasons of held and
   * waiting, 3 held and waiting (the Daemon indicator takes them: its title, its name and a warn glyph), 4 the inbox's state
   * (its toned glyph and the prompt count stay), 5 the daemon's state (its toned glyph, the live dot and live/cap stay),
   * 6 "prompts" after the count, 7 the count, 8 live/cap. Right: 1 the provider and the effort, 2 the model label, 3 the
   * connection's word while it is Live or Connecting, and "needed" after "Update", 4 the rest of the connection's word.
   * Centre, below md: 1 "or command", 2 "New job" (the glyph stays).
   */
  let left = $state(0);
  let right = $state(0);
  let mid = $state(0);
  let fits = $state(0);
  const LEFT_MAX = 8;
  const RIGHT_MAX = 4;
  const MID_MAX = 2;
  let fitting = 0;
  let phone = $state(typeof matchMedia === 'function' ? !matchMedia('(width >= 48rem)').matches : false);

  /** Tone → text colour, whole literals so Tailwind sees them. */
  const TONE_TEXT: Record<string, string> = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', info: 'text-info', ink: 'text-ink', live: 'text-ink', muted: 'text-muted' };
  /** Connection's static dot: only LiveDot pulses. */
  const CONN_DOT: Record<string, string> = { muted: 'dot hollow', ok: 'dot ok', warn: 'dot bg-warn', bad: 'dot bg-bad' };

  /** Held and waiting jobs whose buttons are not shown (fit level 3, or below md): the Daemon indicator speaks for them. */
  const holdsOut = $derived((phone || left >= 3) && (bar.held > 0 || bar.waiting > 0));
  const holdText = $derived(
    [...(bar.held ? [$t('daemon.held', { count: bar.held })] : []), ...(bar.waiting ? [$t('daemon.waiting', { count: bar.waiting })] : [])].join(', '),
  );
  // A hidden hold or wait tones the daemon glyph warn, so the bar still says something needs a look.
  const daemonTone = $derived(bar.daemon.off ? 'muted' : holdsOut && bar.daemon.pill.tone !== 'bad' ? 'warn' : bar.daemon.pill.tone);
  const connWord = $derived(
    conn.state === 'connecting' ? $t('statusbar.conn.connecting') : conn.state === 'offline' ? $t('statusbar.conn.offline') : conn.state === 'outdated' ? $t('statusbar.conn.outdated') : $t('statusbar.conn.live'),
  );
  // Live and Connecting differ by shape (a filled or a hollow dot); Offline and Update needed keep their word at every width.
  const connQuiet = $derived(conn.state === 'live' || conn.state === 'connecting');
  const modelText = $derived(summaryText(models, $t('statusbar.model.session'), (effort) => $t('statusbar.model.effort', { effort })));
  // Tooltips with the full label, only while part of an indicator's text is hidden: a title that repeats the visible
  // label is read a second time as the description.
  const titles = $derived({
    daemon: bar.daemon.off
      ? $t('statusbar.daemon.off')
      : [`${$t('daemon.pill', { label: bar.daemon.pill.label })} · ${$t('daemon.live', { live: bar.daemon.live, cap: bar.daemon.cap })}`, ...(holdsOut ? [holdText] : [])].join(' · '),
    inbox: bar.inbox ? [$t('daemon.inbox', { label: bar.inbox.label }), ...(bar.prompts ? [$t('statusbar.inbox.prompts', { count: bar.prompts })] : [])].join(' · ') : '',
    model: `${$t('statusbar.model.name')} · ${modelText}`,
    connection: `${$t('statusbar.conn.title')} · ${connWord}`,
  });

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
    // Start or Stop turned disabled under the keyboard: focus back on the popover, not the body.
    keepFocus();
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

  // ---------- fitting the clusters ----------
  let footer = $state<HTMLElement>();
  let leftBox = $state<HTMLDivElement>();
  let leftRow = $state<HTMLDivElement>();
  let rightBox = $state<HTMLDivElement>();
  let rightRow = $state<HTMLDivElement>();
  let cmdLabel = $state<HTMLSpanElement>();

  function overflows(box: HTMLElement | undefined, row: HTMLElement | undefined): boolean {
    if (!box || !row) return false;
    const s = getComputedStyle(box);
    return row.getBoundingClientRect().width > box.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) + 0.5;
  }

  /** A shown label that its box cuts. */
  const cut = (el: HTMLElement | undefined): boolean => Boolean(el && el.getClientRects().length > 0 && el.scrollWidth > el.clientWidth + 0.5);

  /** From whole labels down, one level at a time, until each part fits. All in microtasks, so nothing flickers. */
  async function fit(): Promise<void> {
    const me = ++fitting;
    phone = !matchMedia('(width >= 48rem)').matches;
    left = 0;
    right = 0;
    mid = 0;
    await tick();
    while (me === fitting && left < LEFT_MAX && overflows(leftBox, leftRow)) {
      left++;
      await tick();
    }
    while (me === fitting && right < RIGHT_MAX && overflows(rightBox, rightRow)) {
      right++;
      await tick();
    }
    // On a phone the clusters keep their width and the palette button gives way: "needed" goes before its label does.
    while (me === fitting && phone && right < 3 && cut(cmdLabel)) {
      right++;
      await tick();
    }
    while (me === fitting && mid < MID_MAX && cut(cmdLabel)) {
      mid++;
      await tick();
    }
    if (me === fitting) fits++;
  }

  // Refit when what the labels say changes, when the bar resizes, and once the fonts arrive.
  $effect(() => {
    void bar;
    void models;
    void conn.state;
    void S.data;
    void $t;
    untrack(() => fit());
  });
  $effect(() => {
    if (!footer) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(footer);
    document.fonts?.ready.then(() => fit());
    return () => ro.disconnect();
  });

  // An indicator that stops rendering or showing takes its popover with it, unless another indicator for the same popover
  // remains (a cleared hold hands the Daemon popover back to the Daemon button). Focus inside goes to the view's heading.
  $effect(() => {
    void bar;
    void S.data;
    void fits;
    untrack(() => {
      const open = popover.open;
      const anchor = popover.anchor;
      if (open === null || !anchor || (anchor.isConnected && anchor.getClientRects().length > 0)) return;
      const other = [...(footer?.querySelectorAll<HTMLElement>(`[data-popover="${open}"]`) ?? [])].find((b) => b.getClientRects().length > 0);
      if (other) reanchor(other);
      else closePopover('gone');
    });
  });

  // ---------- the inline command input ----------
  let input = $state<HTMLInputElement>();

  function inline(e: Event & { currentTarget: HTMLInputElement }, type: InlineInputEvent['type']): void {
    const el = e.currentTarget;
    const composing = 'isComposing' in e && type !== 'compositionend' ? Boolean(e.isComposing) : false;
    const key = e instanceof KeyboardEvent ? e.key : undefined;
    if (inlineInputAction({ type, value: el.value, key, composing }) !== 'open') return;
    if (type === 'keydown') e.preventDefault();
    openPalette({ text: el.value, opener: el });
    el.value = '';
  }

  /** For App's Cmd/Ctrl-K: whether the inline input shows (md and up) and has focus. */
  export function commandState(): { visible: boolean; focused: boolean } {
    return { visible: Boolean(input && input.getClientRects().length > 0), focused: Boolean(input && document.activeElement === input) };
  }

  export function focusCommand(): void {
    input?.focus();
  }

  const expanded = (id: PopoverId): boolean => popover.open === id;
  const controls = (id: PopoverId): string | undefined => (popover.open === id ? `popover-${id}` : undefined);
</script>

<footer
  bind:this={footer}
  id="statusbar"
  aria-label={$t('statusbar.label')}
  class="fixed bottom-0 right-0 left-0 md:left-(--size-sidebar) z-35 chrome border-t border-line-strong h-[calc(var(--size-statusbar)_+_env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)] flex items-center gap-1 px-1 md:grid md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-2 md:px-3"
>
  <div bind:this={leftBox} class="flex min-w-0 items-center overflow-x-clip px-1">
    <div bind:this={leftRow} class="flex w-max items-center gap-0.5 md:gap-1">
      {#if S.data}
        <button class="btn sm ghost max-md:min-w-11 max-md:justify-center max-md:focus-visible:-outline-offset-2" data-popover="daemon" title={phone || left >= 1 || holdsOut ? titles.daemon : undefined} aria-haspopup="dialog" aria-expanded={expanded('daemon')} aria-controls={controls('daemon')} onclick={(e) => openPopover('daemon', e.currentTarget)}>
          <span class="inline-flex {left >= 5 || holdsOut ? '' : 'md:hidden'} {TONE_TEXT[daemonTone]}"><Icon name="daemon" /></span>
          <LiveDot on={bar.daemon.active} />
          {#if bar.daemon.off}
            <span class="text-muted max-md:sr-only {left >= 5 ? 'sr-only' : ''}">{$t('statusbar.daemon.off')}</span>
          {:else}
            <span class="max-md:sr-only {left >= 5 ? 'sr-only' : ''} {TONE_TEXT[bar.daemon.pill.tone]}"><span class={left >= 1 ? 'sr-only' : ''}>{$t('statusbar.daemon.title')}{' '}</span>{bar.daemon.pill.label}</span>
            <span class="num max-md:sr-only {left >= 8 ? 'sr-only' : ''}">{bar.daemon.live}/{bar.daemon.cap}<span class="sr-only">{' '}{$t('statusbar.daemon.sessions')}</span></span>
          {/if}
          {#if holdsOut}<span class="sr-only">{', '}{holdText}</span>{/if}
        </button>
        {#if bar.inbox}
          <button class="btn sm ghost max-md:min-w-11 max-md:justify-center max-md:focus-visible:-outline-offset-2" data-popover="inbox" title={phone || left >= 1 ? titles.inbox : undefined} aria-haspopup="dialog" aria-expanded={expanded('inbox')} aria-controls={controls('inbox')} onclick={(e) => openPopover('inbox', e.currentTarget)}>
            <span class="inline-flex {TONE_TEXT[bar.inbox.tone]}"><Icon name="inbox" /></span>
            <span class="max-md:sr-only {left >= 4 ? 'sr-only' : ''} {TONE_TEXT[bar.inbox.tone]}"><span class={left >= 1 ? 'sr-only' : ''}>{$t('statusbar.inbox.name')}{' '}</span>{bar.inbox.label}</span>
            {#if bar.prompts}<span class="num text-warn"><span class={left >= 7 ? 'sr-only' : left >= 6 ? '' : 'md:hidden'} aria-hidden="true">{bar.prompts}</span><span class="max-md:sr-only {left >= 6 ? 'sr-only' : ''}">{$t('statusbar.inbox.prompts', { count: bar.prompts })}</span></span>{/if}
          </button>
        {/if}
        {#if bar.held}
          <button class="btn sm ghost max-md:hidden {left >= 3 ? 'hidden!' : ''}" data-popover="daemon" title={left >= 2 ? $t('daemon.held', { count: bar.held }) : undefined} aria-haspopup="dialog" aria-expanded={expanded('daemon')} aria-controls={controls('daemon')} onclick={(e) => openPopover('daemon', e.currentTarget)}><span class="text-warn">{$t('statusbar.held.word')}<span class={left >= 2 ? 'sr-only' : ''}>{$t('statusbar.held.rest')}</span>{' '}({bar.held})</span></button>
        {/if}
        {#if bar.waiting}
          <button class="btn sm ghost max-md:hidden {left >= 3 ? 'hidden!' : ''}" data-popover="daemon" title={left >= 2 ? $t('daemon.waiting', { count: bar.waiting }) : undefined} aria-haspopup="dialog" aria-expanded={expanded('daemon')} aria-controls={controls('daemon')} onclick={(e) => openPopover('daemon', e.currentTarget)}><span class="text-warn">{$t('statusbar.waiting.word')}<span class={left >= 2 ? 'sr-only' : ''}>{$t('statusbar.waiting.rest')}</span>{' '}({bar.waiting})</span></button>
        {/if}
      {/if}
    </div>
  </div>

  <div class="flex min-w-0 flex-1 items-center justify-center md:flex-none">
    <!-- Below md: one button fills the space between the clusters, never under 44px; its label sheds words to fit, never cut. -->
    <button class="btn md:hidden min-w-11 flex-1 justify-center px-2! normal-case tracking-normal max-md:focus-visible:-outline-offset-2" aria-haspopup="dialog" onclick={(e) => openPalette({ opener: e.currentTarget })}><Icon name="command" /><span bind:this={cmdLabel} class="min-w-0 overflow-hidden whitespace-nowrap {mid >= 2 ? 'sr-only' : ''}">{$t('statusbar.command.word')}<span class={mid >= 1 ? 'sr-only' : ''}>{$t('statusbar.command.rest')}</span></span></button>
    <!-- md and up: a real input; typing hands its text to the palette. The kbd is hidden because aria-keyshortcuts announces it,
         and from lg up only, so the placeholder stays whole in the narrow md input. The placeholder is its only visible label,
         so it takes muted (4.5:1 in every theme) rather than dim, and the strong edge. -->
    <span class="relative max-md:hidden">
      <input
        bind:this={input}
        id="statusbar-command"
        type="text"
        aria-label={$t('command.open')}
        aria-haspopup="dialog"
        aria-keyshortcuts="Meta+K Control+K"
        autocomplete="off"
        spellcheck="false"
        placeholder={$t('command.open')}
        class="max-md:hidden w-48 lg:w-64 xl:w-80 2xl:w-96 lg:pr-14! border-line-strong! placeholder:text-muted!"
        oninput={(e) => inline(e, 'input')}
        oncompositionend={(e) => inline(e, 'compositionend')}
        onkeydown={(e) => inline(e, 'keydown')}
      />
      <kbd class="mono muted pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[10px] max-lg:hidden" aria-hidden="true">{shortcut}</kbd>
    </span>
  </div>

  <div bind:this={rightBox} class="flex min-w-0 items-center justify-end overflow-x-clip px-1">
    <div bind:this={rightRow} class="flex w-max items-center gap-0.5 md:gap-1">
      {#if S.data}
        <button class="btn sm ghost max-md:min-w-11 max-md:justify-center max-md:focus-visible:-outline-offset-2" data-popover="model" title={phone || right >= 1 ? titles.model : undefined} aria-haspopup="dialog" aria-expanded={expanded('model')} aria-controls={controls('model')} onclick={(e) => openPopover('model', e.currentTarget)}>
          <Icon name="agents" />
          <span class="sr-only">{$t('statusbar.model.name')}{' '}</span>
          <span class="max-md:sr-only {right >= 2 ? 'sr-only' : ''}">{#if models.provider}<span class={right >= 1 ? 'sr-only' : ''}>{models.provider}{' · '}</span>{/if}{models.label ?? $t('statusbar.model.session')}{#if models.effort}<span class={right >= 1 ? 'sr-only' : ''}>{' · '}{$t('statusbar.model.effort', { effort: models.effort })}</span>{/if}</span>
        </button>
      {/if}
      <button class="btn sm ghost max-md:min-w-11 max-md:justify-center max-md:focus-visible:-outline-offset-2" data-popover="connection" title={phone || right >= 3 ? titles.connection : undefined} aria-haspopup="dialog" aria-expanded={expanded('connection')} aria-controls={controls('connection')} onclick={(e) => openPopover('connection', e.currentTarget)}>
        <span class={CONN_DOT[conn.tone]} aria-hidden="true"></span>
        <span class="sr-only">{$t('statusbar.conn.title')}{' '}</span>
        {#if conn.state === 'outdated'}
          <span class="text-warn {right >= 4 ? 'sr-only' : ''}">{$t('statusbar.conn.outdatedWord')}<span class={right >= 3 ? 'sr-only' : ''}>{$t('statusbar.conn.outdatedRest')}</span></span>
        {:else}
          <span class="{connQuiet ? 'max-md:sr-only' : ''} {(connQuiet && right >= 3) || right >= 4 ? 'sr-only' : ''} {TONE_TEXT[conn.tone]}">{connWord}</span>
        {/if}
      </button>
    </div>
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
