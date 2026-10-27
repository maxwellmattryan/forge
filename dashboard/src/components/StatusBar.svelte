<!-- The status bar: one slim fixed row at the bottom of every view. Left, Needs you (an icon-only bell, its count of
     decisions and permission prompts waiting pinned to the glyph's corner, first in the bar), the Foreman (always: the
     supervisor above the pool, on or off), Workers (the pool's job sessions: its glyph and a `Workers live/cap` count) and
     Inbox (the inbox session, no count), ghosts like the rest, and (md and up) holds and waits after them, so the four
     never move when one appears; then the facts strip (FOCUS job id while a job is focused, a button to its drawer; empty otherwise); right, the model and the
     connection. It holds no text field: "New job or command" lives in the sidebar. Each indicator opens one popover, a
     sibling after the bar: a fixed element with a z-index is its own stacking context, so a popover inside the bar could
     never rise above a full job pane.
     Stacking, from the back: sidebar z-10, this bar z-25, the drawer's backdrop z-30, the rail tooltip z-36, the job pane
     z-40, popovers z-42, Settings and the palette z-45, toast z-50. At md and up the bar spans the content column only, so
     the sidebar keeps its full height. An open job pane covers the bar like the rest of the page: the backdrop dims it,
     the pane runs to the viewport's bottom, and the indicators go inert. Session errors, titles and model strings are untrusted and render
     as text.
     The facts strip takes what the clusters leave (basis 0) and drops the FOCUS word as it runs short (see
     factsHidden). Each cluster holds its indicators in a max-content row; when the row is wider than the cluster, the next
     level of text goes sr-only (see fit()), so a visible label is always whole, never cut to an ellipsis. Below md every
     indicator is a glyph or a lamp. Needs, Foreman, Workers, Inbox and Connection each carry a pilot lamp (src/lib/statusbar.ts
     barLamps), the one the session terminals use; the model button has none. Every indicator shares one class (INDICATOR). -->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import CountBadge from './CountBadge.svelte';
  import Icon from './Icon.svelte';
  import Lamp from './Lamp.svelte';
  import Popover from './Popover.svelte';
  import ConnectionPanel from './statusbar/ConnectionPanel.svelte';
  import InboxPanel from './statusbar/InboxPanel.svelte';
  import NeedsPanel from './statusbar/NeedsPanel.svelte';
  import ForemanPanel from './statusbar/ForemanPanel.svelte';
  import ModelPanel from './statusbar/ModelPanel.svelte';
  import WorkersPanel from './statusbar/WorkersPanel.svelte';
  import Tooltip from './Tooltip.svelte';
  import { API_VERSION } from '../lib/types.ts';
  import type { DaemonPoolState } from '../lib/types.ts';
  import { mergePoolState, poolModel, postDaemon } from '../lib/daemon.ts';
  import { FACTS_MAX, barLamps, barModel, connectionState, factsHidden, modelSummary, promptAnnouncement, summaryText } from '../lib/statusbar.ts';
  import { needsCount } from '../lib/inbox.ts';
  import { S, openDrawer, refresh } from '../lib/app.svelte.ts';
  import { focusFact } from '../lib/focus.ts';
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
  // The job being QA-ed by hand (forge focus), when it is still in the list and active; nothing renders otherwise.
  const focus = $derived(focusFact(S.data));
  const focusTitle = $derived(focus ? $t('statusbar.focus.title', { id: focus.id, title: focus.title }) : undefined);
  // The Needs-you badge: the decisions waiting on a person plus every pending permission prompt in the pool (the
  // popover's first two sections).
  const needs = $derived(needsCount(S.data?.jobs ?? [], S.data?.drafts));
  const needsTotal = $derived(needs + bar.prompts);
  // The overseer's console: each indicator's pilot lamp, decorative beside its sr-only text and title.
  const lamps = $derived(barLamps(bar, { needs: needsTotal, conn: conn.state }));

  /**
   * How much text each part hides, lowest value first. Left: 1 the "Inbox" word, 2 the "Workers" word, 3 the reasons of
   * held and waiting, 4 held and waiting (the Workers indicator takes them: its title, its sr-only text and a warn glyph),
   * 5 Workers' live/cap, 6 the "Foreman" word (its glyph, lamp and prompt count stay): the supervisor keeps its name
   * longest. Glyphs and lamps show at every level. The Needs-you bell is icon-only at every width, so it adds no level. Right: 1 the provider and the effort, 2 the model label, 3 the
   * connection's word while it is Live or Connecting, and "needed" after "Update", 4 the rest of the connection's word.
   * Facts, before either cluster: 1 the FOCUS word (src/lib/statusbar.ts factsHidden).
   */
  let left = $state(0);
  let right = $state(0);
  let facts = $state(0);
  let fits = $state(0);
  const LEFT_MAX = 6;
  const RIGHT_MAX = 4;
  const hid = $derived(factsHidden(facts));
  let fitting = 0;
  let phone = $state(typeof matchMedia === 'function' ? !matchMedia('(width >= 48rem)').matches : false);

  /**
   * The one class every indicator shares (Needs you, Foreman, Workers, Inbox, model, connection): a whole literal so Tailwind
   * sees it. pb-0.5! lifts the content 2px so it sits centred in the bar; the ! beats .btn.sm's two-class padding. Below
   * md the side padding and gap shrink, so a glyph and its lamp make one 44px target and six fit 320px with FOCUS.
   */
  const INDICATOR = 'btn sm ghost pb-0.5! max-md:min-w-11 max-md:justify-center max-md:gap-1.5! max-md:px-1.5! max-md:focus-visible:-outline-offset-2';
  /** Tone → text colour, whole literals so Tailwind sees them. */
  const TONE_TEXT: Record<string, string> = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', info: 'text-info', gleam: 'text-gleam', live: 'text-gleam', muted: 'text-muted' };

  /** Held and waiting jobs whose buttons are not shown (fit level 4, or below md): the Workers indicator speaks for them. */
  const holdsOut = $derived((phone || left >= 4) && (bar.held > 0 || bar.waiting > 0));
  const holdText = $derived(
    [...(bar.held ? [$t('daemon.held', { count: bar.held })] : []), ...(bar.waiting ? [$t('daemon.waiting', { count: bar.waiting })] : [])].join(', '),
  );
  // A hidden hold or wait tones the Workers glyph warn, so the bar still says something needs a look.
  const workersTone = $derived(bar.daemon.off ? 'muted' : holdsOut && bar.daemon.pill.tone !== 'bad' ? 'warn' : bar.daemon.pill.tone);
  // The inbox session's pill tones the Inbox glyph only while the daemon runs.
  const inboxTone = $derived(bar.inbox.off ? 'muted' : bar.inbox.pill.tone);
  // The Foreman's pill (the office session's) tones its glyph only while the daemon runs.
  const foremanTone = $derived(bar.foreman.on && bar.foreman.daemon ? bar.foreman.pill.tone : 'muted');
  const connWord = $derived(
    conn.state === 'connecting' ? $t('statusbar.conn.connecting') : conn.state === 'offline' ? $t('statusbar.conn.offline') : conn.state === 'outdated' ? $t('statusbar.conn.outdated') : $t('statusbar.conn.live'),
  );
  // Live and Connecting differ by their lamp (lit ok or dark); Offline and Update needed keep their word at every width.
  const connQuiet = $derived(conn.state === 'live' || conn.state === 'connecting');
  const modelText = $derived(summaryText(models, $t('statusbar.model.session'), (effort) => $t('statusbar.model.effort', { effort })));
  // Every icon button carries a tooltip at every width. Each adds the indicator's name to what is visible, so a screen
  // reader hears at most the name a second time as the description. The Foreman's off title differs from its visible
  // "Foreman off", and the bell's is only its name, "Needs you" (its popover's title): its counts are already in the
  // sr-only text and the badge. The Foreman's, Workers' and Inbox's state words are never visible, so their titles always carry them.
  const titles = $derived({
    foreman: !bar.foreman.on
      ? $t('statusbar.foreman.offTitle')
      : [
          bar.foreman.daemon ? `${$t('statusbar.foreman.name')} · ${bar.foreman.pill.label}` : $t('statusbar.foreman.daemonOff'),
          ...(bar.foreman.prompts ? [$t('statusbar.foreman.prompts', { count: bar.foreman.prompts })] : []),
        ].join(' · '),
    workers: [
      bar.daemon.off ? $t('statusbar.workers.daemonOff') : `${$t('statusbar.workers.name')} · ${bar.daemon.pill.label}`,
      $t('daemon.live', { live: bar.daemon.off ? 0 : bar.daemon.live, cap: bar.daemon.cap }),
      ...(holdsOut ? [holdText] : []),
    ].join(' · '),
    inbox: bar.inbox.off ? $t('statusbar.inbox.daemonOff') : `${$t('statusbar.inbox.title')} · ${bar.inbox.pill.label}`,
    needs: $t('statusbar.needs.name'),
    model: `${$t('statusbar.model.name')} · ${modelText}`,
    connection: `${$t('statusbar.conn.title')} · ${connWord}`,
  });

  async function act(action: 'start' | 'stop'): Promise<void> {
    pending = true;
    try {
      const st = await postDaemon(action);
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
  // remains (a cleared hold hands the Workers popover back to the Workers button). Focus inside goes to the view's heading.
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

  // `#/inbox` (the old Needs-you page) opens the Needs-you popover once the data and its button are in.
  let needsButton = $state<HTMLButtonElement>();
  $effect(() => {
    if (!S.openNeeds || !S.data || !needsButton) return;
    const anchor = needsButton;
    untrack(() => {
      S.openNeeds = false;
      if (popover.open !== 'needs') openPopover('needs', anchor);
    });
  });

  const expanded = (id: PopoverId): boolean => popover.open === id;
  const controls = (id: PopoverId): string | undefined => (popover.open === id ? `popover-${id}` : undefined);
</script>

<footer
  bind:this={footer}
  id="statusbar"
  aria-label={$t('statusbar.label')}
  class="fixed bottom-0 right-[var(--scroll-lock-gap,0px)] left-0 md:left-(--size-sidebar) z-25 chrome border-t border-line-strong h-[calc(var(--size-statusbar)_+_env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)] flex items-center gap-0 px-0 md:gap-3.5 md:px-2"
>
  <!-- Under an open job pane the indicators go inert, as the sidebar does; the live region stays out of it, since an inert
       region never speaks. display: contents keeps the three parts in the bar's own flex row. -->
  <div class="contents" inert={S.drawer.open}>
  <!-- Below md the clusters drop their padding so six 44px indicators and the FOCUS glyph fit 320px; the focus outline is inset there. -->
  <div bind:this={leftBox} class="flex min-w-0 items-center overflow-x-clip max-md:px-0 md:px-1">
    <div bind:this={leftRow} class="flex w-max items-center gap-0.5 md:gap-1">
      {#if S.data}
        <!-- The one place for everything that needs a person, first in the bar: icon-only at every width (the bell and the
             badge speak; its words are sr-only), so it adds no fit level. The badge counts decisions plus pool-wide
             permission prompts. -->
        <button bind:this={needsButton} class={INDICATOR} data-popover="needs" aria-haspopup="dialog" aria-expanded={expanded('needs')} aria-controls={controls('needs')} onclick={(e) => openPopover('needs', e.currentTarget)}>
<!--          <Lamp state={lamps.needs} />-->
          <CountBadge count={needsTotal} extra={needsTotal > 0 ? 'text-fg' : 'text-muted'}><Icon name="bell" /></CountBadge>
          <span class="sr-only">{$t('statusbar.needs.name')}{#if needs > 0}{', '}{$t('statusbar.needs.count', { count: needs })}{/if}{#if bar.prompts > 0}{', '}{$t('permission.heading', { count: bar.prompts })}{/if}</span>
        </button>
        <!-- The supervisor: always shown, a ghost like the rest of the bar. Its state word is only in the sr-only text and title. -->
        <button class={INDICATOR} data-popover="foreman" title={titles.foreman} aria-haspopup="dialog" aria-expanded={expanded('foreman')} aria-controls={controls('foreman')} onclick={(e) => openPopover('foreman', e.currentTarget)}>
          <span class="inline-flex {TONE_TEXT[foremanTone]}"><Icon name="foreman" /></span>
          <Lamp state={lamps.foreman} />
          {#if bar.foreman.on}
            <span class="max-md:sr-only {left >= 6 ? 'sr-only' : ''}">{$t('statusbar.foreman.name')}</span>
            <span class="sr-only">{', '}{bar.foreman.daemon ? bar.foreman.pill.label : $t('daemon.off')}</span>
            {#if bar.foreman.prompts}<span class="num text-warn"><span aria-hidden="true">{bar.foreman.prompts}</span><span class="sr-only">{', '}{$t('statusbar.foreman.prompts', { count: bar.foreman.prompts })}</span></span>{/if}
          {:else}
            <span class="max-md:sr-only {left >= 6 ? 'sr-only' : ''} text-muted">{$t('statusbar.foreman.off')}</span>
          {/if}
        </button>
        <!-- The pool's job sessions: the Foreman's pair, its glyph at every width. Its lamp still counts every prompt in the pool. -->
        <button class={INDICATOR} data-popover="workers" title={titles.workers} aria-haspopup="dialog" aria-expanded={expanded('workers')} aria-controls={controls('workers')} onclick={(e) => openPopover('workers', e.currentTarget)}>
          <span class="inline-flex {TONE_TEXT[workersTone]}"><Icon name="agents" /></span>
          <Lamp state={lamps.workers} />
          <span class="max-md:sr-only {left >= 5 ? 'sr-only' : ''} {bar.daemon.off ? 'text-muted' : ''}"><span class={left >= 2 ? 'sr-only' : ''}>{$t('statusbar.workers.name')}{' '}</span><span class="num">{bar.daemon.off ? 0 : bar.daemon.live}/{bar.daemon.cap}</span></span>
          <span class="sr-only">{' '}{$t('statusbar.workers.sessions')}{', '}{bar.daemon.off ? $t('daemon.off') : bar.daemon.pill.label}</span>
          {#if holdsOut}<span class="sr-only">{', '}{holdText}</span>{/if}
        </button>
        <!-- The inbox session alone: its lamp is that session's, and it carries no badge or count (those live on the bell). -->
        <button class={INDICATOR} data-popover="inbox" title={titles.inbox} aria-haspopup="dialog" aria-expanded={expanded('inbox')} aria-controls={controls('inbox')} onclick={(e) => openPopover('inbox', e.currentTarget)}>
          <span class="inline-flex {TONE_TEXT[inboxTone]}"><Icon name="inbox" /></span>
          <Lamp state={lamps.inbox} />
          <span class="max-md:sr-only {left >= 1 ? 'sr-only' : ''} {bar.inbox.off ? 'text-muted' : ''}">{$t('statusbar.inbox.name')}</span>
          <span class="sr-only">{', '}{bar.inbox.off ? $t('daemon.off') : bar.inbox.pill.label}</span>
        </button>
        {#if bar.held}
          <button class="btn sm ghost pb-0.5! max-md:hidden {left >= 4 ? 'hidden!' : ''}" data-popover="workers" title={left >= 3 ? $t('daemon.held', { count: bar.held }) : undefined} aria-haspopup="dialog" aria-expanded={expanded('workers')} aria-controls={controls('workers')} onclick={(e) => openPopover('workers', e.currentTarget)}><span class="text-warn">{$t('statusbar.held.word')}<span class={left >= 3 ? 'sr-only' : ''}>{$t('statusbar.held.rest')}</span>{' '}({bar.held})</span></button>
        {/if}
        {#if bar.waiting}
          <button class="btn sm ghost pb-0.5! max-md:hidden {left >= 4 ? 'hidden!' : ''}" data-popover="workers" title={left >= 3 ? $t('daemon.waiting', { count: bar.waiting }) : undefined} aria-haspopup="dialog" aria-expanded={expanded('workers')} aria-controls={controls('workers')} onclick={(e) => openPopover('workers', e.currentTarget)}><span class="text-warn">{$t('statusbar.waiting.word')}<span class={left >= 3 ? 'sr-only' : ''}>{$t('statusbar.waiting.rest')}</span>{' '}({bar.waiting})</span></button>
        {/if}
      {/if}
    </div>
  </div>

  <!-- The facts: what the clusters leave, never wrapped. Only FOCUS, while a job is focused; with none the strip is an empty
       spacer that keeps the right cluster at the edge. Its word goes sr-only when the strip runs short, and below md
       only the focus glyph shows. -->
  <div bind:this={factsBox} class="facts flex-1 basis-0">
    {#if focus}<button id="footer-focus" class="inline-flex shrink-0 items-center gap-[5px] pb-0.5 hover:text-gleam focus-visible:-outline-offset-2 max-md:min-w-11 max-md:justify-center" title={focusTitle} onclick={() => openDrawer(focus.id)}><span class="inline-flex md:hidden text-gleam" aria-hidden="true"><Icon name="review" /></span><span class="k max-md:sr-only {hid.focusWord ? 'sr-only' : ''}">{$t('statusbar.facts.focus')}</span><span class="max-md:sr-only max-w-[24ch] truncate">{focus.id}</span><span class="sr-only">{', '}{focus.title}</span></button>{/if}
  </div>

  <div bind:this={rightBox} class="ml-auto flex min-w-0 items-center justify-end overflow-x-clip max-md:px-0 md:px-1">
    <div bind:this={rightRow} class="flex w-max items-center gap-0.5 md:gap-1">
      {#if S.data}
        <button class={INDICATOR} data-popover="model" title={titles.model} aria-haspopup="dialog" aria-expanded={expanded('model')} aria-controls={controls('model')} onclick={(e) => openPopover('model', e.currentTarget)}>
          <Icon name="cpu" />
          <span class="sr-only">{$t('statusbar.model.name')}{' '}</span>
          <span class="max-md:sr-only {right >= 2 ? 'sr-only' : ''}">{#if models.provider}<span class={right >= 1 ? 'sr-only' : ''}>{models.provider}{' · '}</span>{/if}{models.label ?? $t('statusbar.model.session')}{#if models.effort}<span class={right >= 1 ? 'sr-only' : ''}>{' · '}{$t('statusbar.model.effort', { effort: models.effort })}</span>{/if}</span>
        </button>
      {/if}
      <button class={INDICATOR} data-popover="connection" title={titles.connection} aria-haspopup="dialog" aria-expanded={expanded('connection')} aria-controls={controls('connection')} onclick={(e) => openPopover('connection', e.currentTarget)}>
        <Lamp state={lamps.connection} />
        <span class="sr-only">{$t('statusbar.conn.title')}{' '}</span>
        {#if conn.state === 'outdated'}
          <span class="text-warn {right >= 4 ? 'sr-only' : ''}">{$t('statusbar.conn.outdatedWord')}<span class={right >= 3 ? 'sr-only' : ''}>{$t('statusbar.conn.outdatedRest')}</span></span>
        {:else}
          <span class="{connQuiet ? 'max-md:sr-only' : ''} {(connQuiet && right >= 3) || right >= 4 ? 'sr-only' : ''} {TONE_TEXT[conn.tone]}">{connWord}</span>
        {/if}
      </button>
    </div>
  </div>
  </div>

  <div class="sr-only" aria-live="polite">{announcement}</div>
</footer>
<!-- The bell is icon-only at every width, so its name shows in a Tooltip (hidden while its popover is open), written
     outside the bar so the clusters it measures hold only their indicators. -->
<Tooltip anchor={needsButton} text={titles.needs} off={expanded('needs') === true} />

{#if popover.open !== null && popover.anchor}
  {@const open = popover.open}
  {#key open}
    <Popover
      id={open}
      title={open === 'foreman'
        ? $t('statusbar.foreman.title')
        : open === 'needs'
          ? $t('statusbar.needs.title')
          : open === 'workers'
            ? $t('statusbar.workers.title')
            : open === 'inbox'
              ? $t('statusbar.inbox.title')
              : open === 'model'
                ? $t('statusbar.model.title')
                : $t('statusbar.conn.title')}
      anchor={popover.anchor}
      align={open === 'model' || open === 'connection' ? 'end' : 'start'}
      size={open === 'foreman' ? (bar.foreman.on ? 'chat' : 'wide') : open === 'needs' || open === 'workers' || open === 'inbox' ? 'wide' : 'normal'}
      accent={open === 'foreman' ? 'foreman' : undefined}
    >
      {#if open === 'foreman'}<ForemanPanel foreman={bar.foreman} />
      {:else if open === 'needs'}{#if S.data}<NeedsPanel data={S.data} />{/if}
      {:else if open === 'workers'}<WorkersPanel {model} {pending} {act} billing={S.data?.config?.daemon?.billing ?? null} />
      {:else if open === 'inbox'}<InboxPanel {model} />
      {:else if open === 'model'}<ModelPanel />
      {:else}<ConnectionPanel status={conn.state} />{/if}
    </Popover>
  {/key}
{/if}
