<!-- The status bar: one slim fixed row at the bottom of every view. Left, the daemon, the inbox and (md and up) holds and
     waits; then the facts strip (FORGE version · API · SESSIONS live dot and count · SHEET); right, the model and the
     connection. It holds no text field: "New job or command" lives in the sidebar. Each indicator opens one popover, a
     sibling after the bar: a fixed element with a z-index is its own stacking context, so a popover inside the bar could
     never rise above the drawer.
     Stacking, from the back: sidebar z-10, drawer backdrop z-30, this bar z-35, drawer z-40, popovers z-42, Settings and
     the palette z-45, toast z-50. At md and up the bar spans the content column only, so the sidebar keeps its full
     height, and the drawer ends at the bar's top edge. Session errors, titles and model strings are untrusted and render
     as text.
     The facts strip takes what the clusters leave (basis 0) and drops facts from the right as it runs short (see
     factsHidden). Each cluster holds its indicators in a max-content row; when the row is wider than the cluster, the next
     level of text goes sr-only (see fit()), so a visible label is always whole, never cut to an ellipsis. Below md every
     indicator is a glyph or a dot. -->
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
  import { FACTS_MAX, barModel, connectionState, factsHidden, modelSummary, promptAnnouncement, summaryText } from '../lib/statusbar.ts';
  import { activeSessions } from '../lib/live.ts';
  import { INBOX_SCOPE } from '../lib/types.ts';
  import { VIEWS, viewIndex, type ViewId } from '../lib/view.ts';
  import { S, forgeToken, refresh } from '../lib/app.svelte.ts';
  import { closePopover, focusInPopover, keepFocus, openPopover, popover, reanchor } from '../lib/popover.svelte.ts';
  import type { PopoverId } from '../lib/popover.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';

  // Follows each new /api/state (assigned only when it changed); POST replies overwrite it in between.
  let pool = $derived<Partial<DaemonPoolState> | null>(S.data?.daemons ?? null);
  let pending = $state(false);
  const model = $derived(poolModel(pool, { pending }));
  const bar = $derived(barModel(pool, { pending }));
  const models = $derived(modelSummary(S.data?.config?.models));
  const conn = $derived(connectionState({ online: S.online, apiVersion: S.data?.apiVersion, clientApi: API_VERSION }));
  const active = $derived(activeSessions(S.data?.daemons));
  // One active session per line, the inbox by name.
  const activeTitle = $derived(active.count ? active.ids.map((id) => (id === INBOX_SCOPE ? $t('live.inbox') : id)).join('\n') : $t('live.none'));
  // The same map Nav.svelte builds, for the SHEET fact.
  const viewLabels = $derived<Record<ViewId, string>>({
    pipeline: $t('nav.pipeline'),
    inbox: $t('nav.inbox'),
    backlog: $t('nav.backlog'),
    agents: $t('nav.agents'),
    analytics: $t('nav.analytics'),
    evals: $t('nav.evals'),
  });

  /**
   * How much text each part hides, lowest value first. Left: 1 the "Daemon" and "Inbox" words, 2 the reasons of held and
   * waiting, 3 held and waiting (the Daemon indicator takes them: its title, its name and a warn glyph), 4 the inbox's state
   * (its toned glyph and the prompt count stay), 5 the daemon's state (its toned glyph, the live dot and live/cap stay),
   * 6 "prompts" after the count, 7 the count, 8 live/cap. Right: 1 the provider and the effort, 2 the model label, 3 the
   * connection's word while it is Live or Connecting, and "needed" after "Update", 4 the rest of the connection's word.
   * Facts, before either cluster: 1 SHEET, 2 API, 3 the SESSIONS word, 4 the FORGE word (lib/statusbar.ts factsHidden).
   */
  let left = $state(0);
  let right = $state(0);
  let facts = $state(0);
  let fits = $state(0);
  const LEFT_MAX = 8;
  const RIGHT_MAX = 4;
  const hid = $derived(factsHidden(facts));
  let fitting = 0;
  let phone = $state(typeof matchMedia === 'function' ? !matchMedia('(width >= 48rem)').matches : false);

  /** Tone → text colour, whole literals so Tailwind sees them. */
  const TONE_TEXT: Record<string, string> = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', info: 'text-info', gleam: 'text-gleam', live: 'text-gleam', muted: 'text-muted' };
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
  let factsBox = $state<HTMLDivElement>();

  function overflows(box: HTMLElement | undefined, row: HTMLElement | undefined): boolean {
    if (!box || !row) return false;
    const s = getComputedStyle(box);
    return row.getBoundingClientRect().width > box.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) + 0.5;
  }

  /** A box whose content is wider than it (the facts strip clips its overflow). */
  const cut = (el: HTMLElement | undefined): boolean => Boolean(el && el.getClientRects().length > 0 && el.scrollWidth > el.clientWidth + 0.5);

  /** From whole labels down, one level at a time, until each part fits: the facts first, then the clusters. All in
   *  microtasks, so nothing flickers. */
  async function fit(): Promise<void> {
    const me = ++fitting;
    phone = !matchMedia('(width >= 48rem)').matches;
    left = 0;
    right = 0;
    facts = 0;
    await tick();
    while (me === fitting && facts < FACTS_MAX && cut(factsBox)) {
      facts++;
      await tick();
    }
    while (me === fitting && left < LEFT_MAX && overflows(leftBox, leftRow)) {
      left++;
      await tick();
    }
    while (me === fitting && right < RIGHT_MAX && overflows(rightBox, rightRow)) {
      right++;
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
    void S.view;
    void active.count;
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

  const expanded = (id: PopoverId): boolean => popover.open === id;
  const controls = (id: PopoverId): string | undefined => (popover.open === id ? `popover-${id}` : undefined);
</script>

<footer
  bind:this={footer}
  id="statusbar"
  aria-label={$t('statusbar.label')}
  class="fixed bottom-0 right-0 left-0 md:left-(--size-sidebar) z-35 chrome border-t border-line-strong h-[calc(var(--size-statusbar)_+_env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)] flex items-center gap-1 px-1 md:gap-3.5 md:px-2"
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

  <!-- The facts: what the clusters leave, never wrapped. Each dropped fact goes sr-only, so the strip still reads whole.
       Below md only the version and the sessions dot and count stay. -->
  <div bind:this={factsBox} class="facts flex-1 basis-0">
    <span id="footer-version"><span class="k max-md:sr-only {hid.forgeWord ? 'sr-only' : ''}">{$t('statusbar.facts.forge')}</span>{S.data ? $t('statusbar.facts.version', { version: S.data.forgeVersion }) : '—'}</span>
    <span class="sep max-md:hidden! {hid.api ? 'hidden!' : ''}" aria-hidden="true"></span>
    <span class="max-md:sr-only {hid.api ? 'sr-only' : ''}"><span class="k">{$t('statusbar.facts.api')}</span>{S.data ? S.data.apiVersion : '—'}</span>
    <span class="sep" aria-hidden="true"></span>
    <span id="footer-sessions" title={activeTitle}><span class="k max-md:sr-only {hid.sessionsWord ? 'sr-only' : ''}">{$t('statusbar.facts.sessions')}</span><LiveDot on={active.count > 0} /><span class="num">{$t('statusbar.facts.sessionsValue', { count: active.count })}</span></span>
    <span class="sep max-md:hidden! {hid.sheet ? 'hidden!' : ''}" aria-hidden="true"></span>
    <span class="max-md:sr-only {hid.sheet ? 'sr-only' : ''}"><span class="k">{$t('statusbar.facts.sheet')}</span>{$t('statusbar.facts.sheetValue', { view: viewLabels[S.view], index: viewIndex(S.view), total: VIEWS.length })}</span>
  </div>

  <div bind:this={rightBox} class="ml-auto flex min-w-0 items-center justify-end overflow-x-clip px-1">
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
